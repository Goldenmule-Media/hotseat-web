import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import {
  buildCritiqueMessages,
  CRITIQUE_OUTPUT_SCHEMA,
  critiqueSystemPrompt,
  critiqueUserTurn,
  GRADES,
  MAX_GAPS,
  MAX_HISTORY_TURNS,
  MAX_IMPROVEMENTS,
  REVIEW_OUTPUT_SCHEMA,
  reviewSystemPrompt,
  reviewUserTurn,
  runCritique,
  runReview,
  SEVERITIES,
  timeoutMsFromEnv,
  validateCritiqueVerdict,
  validateReviewVerdict,
  type CreateMessage,
  type CritiqueTurn,
  type CritiqueVerdict,
} from "./critic";

const section = { title: "Goals", markdown: "The goal is X." };

const verdict = (summary: string): CritiqueVerdict => ({
  grade: "partial",
  summary,
  gaps: [],
  improvements: [],
});

describe("validateCritiqueVerdict", () => {
  it("coerces an unknown grade to partial and caps the lists", () => {
    const v = validateCritiqueVerdict({
      grade: "excellent",
      summary: "Close.",
      gaps: Array.from({ length: 9 }, (_, i) => `gap ${i}`),
      improvements: ["a", "b", "c"],
    });
    expect(v?.grade).toBe("partial");
    expect(v?.gaps).toHaveLength(MAX_GAPS);
    expect(v?.improvements).toHaveLength(MAX_IMPROVEMENTS);
  });

  it("rejects a verdict with no summary", () => {
    expect(validateCritiqueVerdict({ grade: "understood" })).toBeNull();
    expect(validateCritiqueVerdict(null)).toBeNull();
    expect(validateCritiqueVerdict([])).toBeNull();
  });
});

describe("validateReviewVerdict", () => {
  it("drops notes with no usable title or body and coerces severity", () => {
    const v = validateReviewVerdict({
      summary: "Mostly coherent.",
      notes: [
        { title: "Two rules", markdown: "Stated twice.", severity: "CRITICAL" },
        { title: "", markdown: "no title" },
        { title: "No body", markdown: "  " },
        { title: "Unknown", markdown: "body", severity: "spicy" },
      ],
    });
    expect(v?.notes).toEqual([
      { title: "Two rules", markdown: "Stated twice.", severity: "critical" },
      { title: "Unknown", markdown: "body", severity: "minor" },
    ]);
  });

  it("rejects a verdict with no summary", () => {
    expect(validateReviewVerdict({ notes: [] })).toBeNull();
  });
});

describe("the output schemas", () => {
  it("derive their enums from the constants the validators use", () => {
    expect(CRITIQUE_OUTPUT_SCHEMA.properties.grade.enum).toEqual([...GRADES]);
    expect(REVIEW_OUTPUT_SCHEMA.properties.notes.items.properties.severity.enum).toEqual([...SEVERITIES]);
  });

  it("bound the lists at the same caps the validator enforces", () => {
    expect(CRITIQUE_OUTPUT_SCHEMA.properties.gaps.maxItems).toBe(MAX_GAPS);
    expect(CRITIQUE_OUTPUT_SCHEMA.properties.improvements.maxItems).toBe(MAX_IMPROVEMENTS);
  });
});

describe("the prompts", () => {
  it("puts the role and the judging criteria in the system prompt, not the task", () => {
    const system = critiqueSystemPrompt();
    expect(system).toContain("You are the critic in a spec-restatement studio");
    expect(system).toContain(`gaps: at most ${MAX_GAPS}`);
    expect(system).toContain(`improvements: at most ${MAX_IMPROVEMENTS}`);
    expect(critiqueUserTurn(section, "My restatement.")).not.toContain("You are the critic");
  });

  it("carries the section and the restatement in the task", () => {
    const turn = critiqueUserTurn(section, "My restatement.");
    expect(turn).toContain("SECTION: Goals");
    expect(turn).toContain("The goal is X.");
    expect(turn).toContain("My restatement.");
  });

  it("still forbids the round-over-round recap that history would otherwise invite", () => {
    expect(critiqueSystemPrompt()).toContain("never narrate what changed since your last critique");
  });

  it("keeps the review's criteria in its system prompt and the spec in its only message", () => {
    const system = reviewSystemPrompt();
    expect(system).toContain("reviewing a complete specification document holistically");
    expect(system).toContain("A rule stated TWICE");
    expect(system).toContain('"critical" = the spec cannot be built correctly as written');
    expect(system).not.toContain("# Spec");
    expect(reviewUserTurn("# Spec\n\nBody.")).toContain("# Spec");
  });
});

const turn = (title: string, restatement: string, summary: string): CritiqueTurn => ({
  section: { title, markdown: `Source for ${title}.` },
  restatement,
  verdict: verdict(summary),
});

describe("buildCritiqueMessages", () => {
  it("puts the current task last, as a user message", () => {
    const messages = buildCritiqueMessages(section, "Now.", [turn("Scope", "Earlier.", "Close.")]);
    const last = messages[messages.length - 1];
    expect(last?.role).toBe("user");
    expect(String(last?.content)).toContain("SECTION: Goals");
  });

  it("replays a past critique as its own task and the model's own JSON", () => {
    const past = turn("Scope", "Earlier.", "Close.");
    const messages = buildCritiqueMessages(section, "Now.", [past]);
    expect(messages[0]?.role).toBe("user");
    expect(String(messages[0]?.content)).toContain("Source for Scope.");
    expect(messages[1]?.role).toBe("assistant");
    expect(JSON.parse(String(messages[1]?.content))).toEqual(past.verdict);
  });

  it("alternates user and assistant, starting with user", () => {
    const messages = buildCritiqueMessages(section, "Now.", [
      turn("A", "r1", "s1"),
      turn("B", "r2", "s2"),
    ]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
  });

  it("keeps only the last few turns", () => {
    const history = Array.from({ length: MAX_HISTORY_TURNS + 3 }, (_, i) => turn(`S${i}`, `r${i}`, `s${i}`));
    const messages = buildCritiqueMessages(section, "Now.", history);
    expect(messages).toHaveLength(MAX_HISTORY_TURNS * 2 + 1);
    expect(String(messages[0]?.content)).toContain("SECTION: S3");
  });

  it("drops a malformed turn rather than sending half of it", () => {
    const history = [
      { section: { title: "", markdown: "src" }, restatement: "r", verdict: verdict("s") },
      { section: { title: "T", markdown: "src" }, restatement: "", verdict: verdict("s") },
      { section: { title: "T", markdown: "src" }, restatement: "r", verdict: { grade: "partial" } },
      turn("Real", "r", "s"),
    ] as unknown as CritiqueTurn[];
    const messages = buildCritiqueMessages(section, "Now.", history);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(String(messages[0]?.content)).toContain("SECTION: Real");
  });

  it("clips a replayed source but never the section being judged", () => {
    const long = "x".repeat(20_000);
    const messages = buildCritiqueMessages({ title: "Now", markdown: long }, long, [
      { section: { title: "Past", markdown: long }, restatement: long, verdict: verdict("s") },
    ]);
    expect(String(messages[0]?.content).length).toBeLessThan(long.length);
    expect(String(messages[2]?.content)).toContain(long);
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
      { type: "thinking", thinking: "reading the source", signature: "sig" },
      { type: "text", text: typeof body === "string" ? body : JSON.stringify(body), citations: null },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Message;
}

const replying = (message: Anthropic.Message): CreateMessage => async () => message;

describe("runCritique", () => {
  it("reads the text block past the thinking block", async () => {
    const out = await runCritique({
      section,
      restatement: "Mine.",
      create: replying(answer({ grade: "understood", summary: "Yours.", gaps: [], improvements: [] })),
    });
    expect(out).toEqual({
      ok: true,
      verdict: { grade: "understood", summary: "Yours.", gaps: [], improvements: [] },
    });
  });

  it("reports a refusal instead of parsing it", async () => {
    const out = await runCritique({
      section,
      restatement: "Mine.",
      create: replying(answer({ summary: "no" }, "refusal")),
    });
    expect(out).toEqual({ ok: false, message: "the critique declined to answer" });
  });

  it("reports a reply cut off at the length limit", async () => {
    const out = await runCritique({
      section,
      restatement: "Mine.",
      create: replying(answer('{"summary":', "max_tokens")),
    });
    expect(out).toEqual({ ok: false, message: "the critique ran past its length limit" });
  });

  it("reports text that is not a usable verdict", async () => {
    const out = await runCritique({
      section,
      restatement: "Mine.",
      create: replying(answer("You missed the point.")),
    });
    expect(out).toEqual({ ok: false, message: "the critique replied with no usable verdict" });
  });

  it("passes the signal and the timeout through, and asks for no tools", async () => {
    const controller = new AbortController();
    let seen: { params: Anthropic.MessageCreateParamsNonStreaming; options?: Anthropic.RequestOptions } | null = null;
    const create: CreateMessage = async (params, options) => {
      seen = { params, options };
      return answer({ grade: "partial", summary: "ok", gaps: [], improvements: [] });
    };
    await runCritique({ section, restatement: "Mine.", timeoutMs: 12_345, signal: controller.signal, create });
    const call = seen as unknown as { params: Record<string, unknown>; options: Record<string, unknown> };
    expect(call.options.timeout).toBe(12_345);
    expect(call.options.signal).toBe(controller.signal);
    expect(call.params.model).toBe("claude-opus-5");
    expect(call.params.thinking).toEqual({ type: "adaptive" });
    expect(call.params.output_config).toEqual({ format: { type: "json_schema", schema: CRITIQUE_OUTPUT_SCHEMA } });
    expect(call.params).not.toHaveProperty("tools");
  });

  it("turns an API failure into one sentence", async () => {
    const create: CreateMessage = async () => {
      throw new Error("boom");
    };
    expect(await runCritique({ section, restatement: "Mine.", create })).toEqual({
      ok: false,
      message: "the critique failed",
    });
  });
});

describe("runReview", () => {
  it("sends the spec once and validates the notes", async () => {
    let seen: Anthropic.MessageCreateParamsNonStreaming | null = null;
    const create: CreateMessage = async (params) => {
      seen = params;
      return answer({
        summary: "Two rules disagree.",
        notes: [{ title: "Ordering", markdown: "Stated twice.", severity: "major" }],
      });
    };
    const out = await runReview({ specMarkdown: "# Spec\n\nBody.", create });
    expect(out).toEqual({
      ok: true,
      verdict: {
        summary: "Two rules disagree.",
        notes: [{ title: "Ordering", markdown: "Stated twice.", severity: "major" }],
      },
    });
    const params = seen as unknown as { messages: Anthropic.MessageParam[] };
    expect(params.messages).toHaveLength(1);
    expect(String(params.messages[0]?.content)).toContain("# Spec");
  });

  it("reports a refusal under its own name", async () => {
    const out = await runReview({ specMarkdown: "x", create: replying(answer({ summary: "no" }, "refusal")) });
    expect(out).toEqual({ ok: false, message: "the review declined to answer" });
  });
});

describe("timeoutMsFromEnv", () => {
  it("falls back when unset or invalid", () => {
    expect(timeoutMsFromEnv({}, 300_000)).toBe(300_000);
    expect(timeoutMsFromEnv({ SPEC_RESTATE_TIMEOUT_MS: "soon" }, 300_000)).toBe(300_000);
    expect(timeoutMsFromEnv({ SPEC_RESTATE_TIMEOUT_MS: "-5" }, 300_000)).toBe(300_000);
    expect(timeoutMsFromEnv({ SPEC_RESTATE_TIMEOUT_MS: "0" }, 300_000)).toBe(300_000);
  });

  it("parses an override", () => {
    expect(timeoutMsFromEnv({ SPEC_RESTATE_TIMEOUT_MS: "60000" }, 300_000)).toBe(60_000);
  });
});
