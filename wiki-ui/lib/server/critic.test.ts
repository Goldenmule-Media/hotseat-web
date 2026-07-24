import { describe, expect, it } from "vitest";
import {
  critiqueFirstPrompt,
  critiqueFollowUpPrompt,
  reviewPrompt,
  sseData,
  timeoutMsFromEnv,
} from "./critic";

describe("sseData", () => {
  it("frames one event as a single data line", () => {
    expect(sseData({ type: "delta", text: "hi" })).toBe('data: {"type":"delta","text":"hi"}\n\n');
  });

  it("keeps payload newlines escaped inside the one data line", () => {
    const frame = sseData({ type: "delta", text: "a\nb" });
    const [payload, ...rest] = frame.split("\n\n");
    expect(rest).toEqual([""]);
    expect(payload.split("\n")).toHaveLength(1);
  });
});

describe("critique prompts", () => {
  const sections = [
    { title: "Goals", markdown: "The goal is X." },
    { title: "Constraints", markdown: "Never do Y." },
  ];

  it("the first prompt embeds every source section and the restatement", () => {
    const p = critiqueFirstPrompt(sections, "My restatement.");
    expect(p).toContain("### Goals");
    expect(p).toContain("The goal is X.");
    expect(p).toContain("### Constraints");
    expect(p).toContain("Never do Y.");
    expect(p).toContain("My restatement.");
  });

  it("the follow-up prompt carries only the new restatement", () => {
    const p = critiqueFollowUpPrompt("Second attempt.");
    expect(p).toContain("Second attempt.");
    expect(p).toContain("unchanged from earlier in this session");
    expect(p).not.toContain("SOURCE SECTIONS");
  });

  it("both demand exactly one JSON object of the critique shape", () => {
    for (const p of [critiqueFirstPrompt(sections, "r"), critiqueFollowUpPrompt("r")]) {
      expect(p).toContain("EXACTLY ONE JSON object");
      expect(p).toContain('"gaps"');
      expect(p).toContain('"improvements"');
      expect(p).toContain('"summary"');
    }
  });
});

describe("review prompt", () => {
  it("embeds the spec and demands the notes shape with the severity enum", () => {
    const p = reviewPrompt("# Spec\n\nBody.");
    expect(p).toContain("# Spec");
    expect(p).toContain("EXACTLY ONE JSON object");
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
