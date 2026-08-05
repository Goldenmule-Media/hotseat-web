import { describe, expect, it } from "vitest";
import { evalTimeoutMsFromEnv, evaluationPrompt } from "./study-critic";

describe("evaluation prompt", () => {
  const input = {
    term: "Entropy",
    definition: "How much information a token carries on average.",
    context: "- **Entropy** - a measure of how much information a token carries.",
    subject: "Book - AI Engineering",
  };

  it("carries the term, the definition, the notes context and the subject", () => {
    const p = evaluationPrompt(input);
    expect(p).toContain("TERM: Entropy");
    expect(p).toContain("How much information a token carries on average.");
    expect(p).toContain("NOTES WHERE THE TERM APPEARS");
    expect(p).toContain("a measure of how much information");
    expect(p).toContain("SUBJECT: Book - AI Engineering");
  });

  it("omits the context and subject blocks when absent or blank", () => {
    const p = evaluationPrompt({ term: "RAG", definition: "Retrieve, then generate.", context: "  " });
    expect(p).not.toContain("NOTES WHERE THE TERM APPEARS");
    expect(p).not.toContain("SUBJECT:");
    expect(p).toContain("TERM: RAG");
  });

  it("demands one JSON object in the critique verdict shape", () => {
    const p = evaluationPrompt(input);
    expect(p).toContain("EXACTLY one JSON object and nothing else");
    expect(p).toContain('"grade"');
    expect(p).toContain('"summary"');
    expect(p).toContain('"gaps"');
    expect(p).toContain('"improvements"');
    expect(p).toContain("gaps: at most 4");
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
