import { describe, expect, it } from "vitest";
import { critiqueFirstPrompt, critiqueFollowUpPrompt, reviewPrompt, timeoutMsFromEnv } from "./critic";

describe("critique prompts", () => {
  const section = { title: "Goals", markdown: "The goal is X." };

  it("the first prompt carries the contract, the section and the restatement", () => {
    const p = critiqueFirstPrompt(section, "My restatement.");
    expect(p).toContain("SECTION: Goals");
    expect(p).toContain("The goal is X.");
    expect(p).toContain("My restatement.");
    expect(p).toContain("You are the critic in a spec-restatement studio");
  });

  it("the follow-up prompt re-sends the source (the session is page-wide, not section-wide)", () => {
    const p = critiqueFollowUpPrompt(section, "Second attempt.");
    expect(p).toContain("SECTION: Goals");
    expect(p).toContain("The goal is X.");
    expect(p).toContain("Second attempt.");
    // The role and the rules live in the session; only the shape reminder repeats.
    expect(p).not.toContain("You are the critic in a spec-restatement studio");
  });

  it("both demand one JSON object and nothing else", () => {
    for (const p of [critiqueFirstPrompt(section, "r"), critiqueFollowUpPrompt(section, "r")]) {
      expect(p).toContain("EXACTLY one JSON object and nothing else");
      expect(p).toContain('"grade"');
      expect(p).toContain('"summary"');
      expect(p).toContain('"gaps"');
      expect(p).toContain('"improvements"');
    }
  });

  it("caps what the critic may return", () => {
    const p = critiqueFirstPrompt(section, "r");
    expect(p).toContain("gaps: at most 4");
    expect(p).toContain("improvements: at most 2");
  });

  it("forbids the round-over-round recap the shared session would otherwise invite", () => {
    expect(critiqueFirstPrompt(section, "r")).toContain("never narrate what changed since your last critique");
  });
});

describe("review prompt", () => {
  it("embeds the spec and demands the notes shape with the severity enum", () => {
    const p = reviewPrompt("# Spec\n\nBody.");
    expect(p).toContain("# Spec");
    expect(p).toContain("EXACTLY one JSON object and nothing else");
    expect(p).toContain('"notes"');
    expect(p).toContain('"severity"');
    expect(p).toContain("critical");
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
