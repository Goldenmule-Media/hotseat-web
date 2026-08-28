import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import {
  evalTimeoutMsFromEnv,
  evaluationSystemPrompt,
  evaluationUserTurn,
  GRADES,
  runTermEvaluation,
  STUDY_MAX_POINTS,
  validateStudyVerdict,
  VERDICT_OUTPUT_SCHEMA,
  type CreateMessage,
} from "./study-critic";

const input = {
  term: "Entropy",
  definition: "How much information a token carries on average.",
  context: "- **Entropy** - a measure of how much information a token carries.",
  subject: "Book - AI Engineering",
};

describe("the user turn", () => {
  it("carries the term, the definition, the notes context and the subject", () => {
    const p = evaluationUserTurn(input);
    expect(p).toContain("TERM: Entropy");
    expect(p).toContain("How much information a token carries on average.");
    expect(p).toContain("NOTES WHERE THE TERM APPEARS");
    expect(p).toContain("a measure of how much information");
    expect(p).toContain("SUBJECT: Book - AI Engineering");
  });

  it("omits the context and subject blocks when absent or blank", () => {
    const p = evaluationUserTurn({ term: "RAG", definition: "Retrieve, then generate.", context: "  " });
    expect(p).not.toContain("NOTES WHERE THE TERM APPEARS");
    expect(p).not.toContain("SUBJECT:");
    expect(p).toContain("TERM: RAG");
  });
});

describe("the system prompt", () => {
  it("holds the judging criteria, not the term being judged", () => {
    const s = evaluationSystemPrompt();
    expect(s).toContain("You are a function, not a chat partner");
    expect(s).toContain('grade: "understood"');
    expect(s).toContain("suggestion: ALWAYS");
    expect(s).not.toContain("TERM: Entropy");
  });

  it("keeps the terse bullet-only instruction", () => {
    const s = evaluationSystemPrompt();
    expect(s).toContain("BULLETS and nothing else — no summary sentence");
    expect(s).toContain("points: 1 to 3");
    expect(s).toContain("BE TERSE");
  });

  it("no longer begs for JSON, because the schema decides the shape", () => {
    expect(evaluationSystemPrompt()).not.toContain("EXACTLY one JSON object");
  });
});

describe("the output schema", () => {
  it("takes the grade enum from the one list of grades", () => {
    expect(VERDICT_OUTPUT_SCHEMA.properties.grade.enum).toEqual([...GRADES]);
  });

  it("admits nothing but the verdict's three fields", () => {
    expect(VERDICT_OUTPUT_SCHEMA.required).toEqual(["grade", "points", "suggestion"]);
    expect(VERDICT_OUTPUT_SCHEMA.additionalProperties).toBe(false);
  });
});

describe("validateStudyVerdict", () => {
  it("caps points at 3 and keeps the suggestion", () => {
    const v = validateStudyVerdict({ grade: "surface", points: ["a", "b", "c", "d"], suggestion: "Better." });
    expect(v).toEqual({ grade: "surface", points: ["a", "b", "c"], suggestion: "Better." });
    expect(STUDY_MAX_POINTS).toBe(3);
  });

  it("folds a legacy summary/gaps reply into points", () => {
    const v = validateStudyVerdict({ grade: "partial", summary: "Reworded.", gaps: ["no mechanism"] });
    expect(v?.points).toEqual(["Reworded.", "no mechanism"]);
  });

  it("rejects an empty verdict", () => {
    expect(validateStudyVerdict({ grade: "understood" })).toBeNull();
  });
});

function answer(body: unknown, stopReason: Anthropic.Message["stop_reason"] = "end_turn"): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    stop_reason: stopReason,
    stop_sequence: null,
    content: [
      { type: "thinking", thinking: "weighing the definition", signature: "sig" },
      { type: "text", text: typeof body === "string" ? body : JSON.stringify(body), citations: null },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Message;
}

const replying = (message: Anthropic.Message): CreateMessage => async () => message;

describe("runTermEvaluation", () => {
  it("reads the text block past the thinking block", async () => {
    const out = await runTermEvaluation({
      ...input,
      create: replying(answer({ grade: "partial", points: ["misses the surprisal average"], suggestion: "Better." })),
    });
    expect(out).toEqual({
      ok: true,
      verdict: { grade: "partial", points: ["misses the surprisal average"], suggestion: "Better." },
    });
  });

  it("reports a refusal instead of parsing it", async () => {
    const out = await runTermEvaluation({ ...input, create: replying(answer({ grade: "partial" }, "refusal")) });
    expect(out).toEqual({ ok: false, message: "the evaluator declined to judge this term" });
  });

  it("reports a verdict cut off at the length limit", async () => {
    const out = await runTermEvaluation({ ...input, create: replying(answer('{"grade":', "max_tokens")) });
    expect(out).toEqual({ ok: false, message: "the evaluation ran past its length limit" });
  });

  it("reports text that is not JSON", async () => {
    const out = await runTermEvaluation({ ...input, create: replying(answer("Close, but circular.")) });
    expect(out).toEqual({ ok: false, message: "the evaluation reply had no usable verdict" });
  });

  it("passes the signal and the timeout through, and asks for no tools", async () => {
    const controller = new AbortController();
    let seen: { params: Anthropic.MessageCreateParamsNonStreaming; options?: Anthropic.RequestOptions } | null = null;
    const create: CreateMessage = async (params, options) => {
      seen = { params, options };
      return answer({ grade: "understood", points: ["got the mechanism"], suggestion: "Fine." });
    };
    await runTermEvaluation({ ...input, timeoutMs: 12_345, signal: controller.signal, create });
    const call = seen as unknown as { params: Record<string, unknown>; options: Record<string, unknown> };
    expect(call.options.timeout).toBe(12_345);
    expect(call.options.signal).toBe(controller.signal);
    expect(call.params.model).toBe("claude-opus-5");
    expect(call.params.thinking).toEqual({ type: "adaptive" });
    expect(call.params).not.toHaveProperty("tools");
    expect(call.params.output_config).toEqual({
      format: { type: "json_schema", schema: VERDICT_OUTPUT_SCHEMA },
    });
  });

  it("evaluates one term per call, with no session to resume", async () => {
    let calls = 0;
    const create: CreateMessage = async () => {
      calls += 1;
      // Nothing usable: the old CLI path answered this with a reinforcement retry.
      return answer("not a verdict");
    };
    await runTermEvaluation({ ...input, create });
    expect(calls).toBe(1);
  });

  it("turns an API failure into one sentence", async () => {
    const create: CreateMessage = async () => {
      throw new Error("boom");
    };
    expect(await runTermEvaluation({ ...input, create })).toEqual({ ok: false, message: "the evaluation failed" });
  });
});

describe("evalTimeoutMsFromEnv", () => {
  it("falls back when unset or invalid", () => {
    expect(evalTimeoutMsFromEnv({}, 300_000)).toBe(300_000);
    expect(evalTimeoutMsFromEnv({ STUDY_EVAL_TIMEOUT_MS: "soon" }, 300_000)).toBe(300_000);
  });

  it("parses its own override and falls back to the restate one", () => {
    expect(evalTimeoutMsFromEnv({ STUDY_EVAL_TIMEOUT_MS: "60000" }, 300_000)).toBe(60_000);
    expect(evalTimeoutMsFromEnv({ SPEC_RESTATE_TIMEOUT_MS: "90000" }, 300_000)).toBe(90_000);
  });
});
