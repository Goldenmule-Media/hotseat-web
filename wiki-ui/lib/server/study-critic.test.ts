import { describe, expect, it } from "vitest";
import { evalTimeoutMsFromEnv, evaluationPrompt, validateStudyVerdict } from "./study-critic";

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

  it("demands one JSON object in the bullets-plus-suggestion shape", () => {
    const p = evaluationPrompt(input);
    expect(p).toContain("EXACTLY one JSON object and nothing else");
    expect(p).toContain('"grade"');
    expect(p).toContain('"points"');
    expect(p).toContain('"suggestion"');
    expect(p).not.toContain('"summary"');
  });

  it("demands terse bullet-only output with a mandatory suggestion", () => {
    const p = evaluationPrompt(input);
    expect(p).toContain("BULLETS and nothing else — no summary sentence");
    expect(p).toContain("points: 1 to 3");
    expect(p).toContain("suggestion: ALWAYS");
    expect(p).toContain("BE TERSE");
  });
});

describe("validateStudyVerdict", () => {
  it("caps points at 3 and keeps the suggestion", () => {
    const v = validateStudyVerdict({ grade: "surface", points: ["a", "b", "c", "d"], suggestion: "Better." });
    expect(v).toEqual({ grade: "surface", points: ["a", "b", "c"], suggestion: "Better." });
  });

  it("folds a legacy summary/gaps reply into points", () => {
    const v = validateStudyVerdict({ grade: "partial", summary: "Reworded.", gaps: ["no mechanism"] });
    expect(v?.points).toEqual(["Reworded.", "no mechanism"]);
  });

  it("rejects an empty verdict", () => {
    expect(validateStudyVerdict({ grade: "understood" })).toBeNull();
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
