import { describe, expect, it } from "vitest";
import {
  buildArgs,
  CRITIC_DISALLOWED_TOOLS,
  decideAvailability,
  extractJson,
  validateCritiqueVerdict,
  validateReviewVerdict,
} from "./claude-cli";

const base = { mcpConfigPath: "/scratch/mcp-config.json" };

describe("buildArgs", () => {
  it("assembles the print-mode stream flags", () => {
    const args = buildArgs("hi", base);
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
    // Nothing is streamed to the browser any more — only the result event is read.
    expect(args).not.toContain("--include-partial-messages");
  });

  it("always pins the MCP config with --strict-mcp-config", () => {
    const args = buildArgs("hi", base);
    const i = args.indexOf("--mcp-config");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("/scratch/mcp-config.json");
    expect(args[i + 2]).toBe("--strict-mcp-config");
  });

  it("puts -p <prompt> last even with every option set", () => {
    const args = buildArgs("the prompt", { ...base, resumeSessionId: "s1", disallowedTools: ["Bash"] });
    expect(args.slice(-2)).toEqual(["-p", "the prompt"]);
  });

  it("passes --resume only when a session id is given", () => {
    expect(buildArgs("x", base)).not.toContain("--resume");
    const args = buildArgs("x", { ...base, resumeSessionId: "abc" });
    expect(args[args.indexOf("--resume") + 1]).toBe("abc");
  });

  it("joins disallowed tools into one comma list", () => {
    const args = buildArgs("x", { ...base, disallowedTools: CRITIC_DISALLOWED_TOOLS });
    expect(args[args.indexOf("--disallowed-tools") + 1]).toBe(CRITIC_DISALLOWED_TOOLS.join(","));
  });

  it("omits --disallowed-tools for an empty list", () => {
    expect(buildArgs("x", { ...base, disallowedTools: [] })).not.toContain("--disallowed-tools");
  });
});

describe("extractJson", () => {
  it("parses a bare JSON object", () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 });
  });

  it("parses an object embedded in prose", () => {
    expect(extractJson('Verdict below.\n{"a": [1, 2]}\nDone.')).toEqual({ a: [1, 2] });
  });

  it("throws when there is no object at all", () => {
    expect(() => extractJson("no json here")).toThrow();
  });

  it("throws on a garbage brace span", () => {
    expect(() => extractJson("{ not json }")).toThrow();
  });
});

describe("validateCritiqueVerdict", () => {
  it("passes a well-formed verdict through", () => {
    const raw = { grade: "understood", summary: "solid", gaps: ["missed OCC"], improvements: ["tighter scope"] };
    expect(validateCritiqueVerdict(raw)).toEqual(raw);
  });

  it("wraps bare-string arrays", () => {
    expect(validateCritiqueVerdict({ summary: "s", gaps: "missed X", improvements: "tighter" })).toEqual({
      grade: "partial",
      summary: "s",
      gaps: ["missed X"],
      improvements: ["tighter"],
    });
  });

  it("defaults missing arrays to [] and an unknown grade to partial", () => {
    expect(validateCritiqueVerdict({ summary: "s" })).toEqual({
      grade: "partial",
      summary: "s",
      gaps: [],
      improvements: [],
    });
    expect(validateCritiqueVerdict({ summary: "s", grade: "excellent" })?.grade).toBe("partial");
    expect(validateCritiqueVerdict({ summary: "s", grade: " SURFACE " })?.grade).toBe("surface");
  });

  it("drops non-string and blank entries", () => {
    expect(
      validateCritiqueVerdict({ summary: "s", gaps: ["a", 1, null, "  ", "b"], improvements: [{}, false] }),
    ).toEqual({ grade: "partial", summary: "s", gaps: ["a", "b"], improvements: [] });
  });

  it("enforces the caps a chatty reply ignored", () => {
    const out = validateCritiqueVerdict({
      summary: "s",
      gaps: ["1", "2", "3", "4", "5", "6"],
      improvements: ["a", "b", "c"],
    });
    expect(out?.gaps).toEqual(["1", "2", "3", "4"]);
    expect(out?.improvements).toEqual(["a", "b"]);
  });

  it.each([
    ["null", null],
    ["a string", "verdict"],
    ["a number", 42],
    ["an array", []],
    ["a missing summary", { gaps: ["x"] }],
    ["a blank summary", { summary: "  " }],
    ["a non-string summary", { summary: 3 }],
  ])("returns null for %s", (_label, raw) => {
    expect(validateCritiqueVerdict(raw)).toBeNull();
  });
});

describe("validateReviewVerdict", () => {
  it("passes a well-formed verdict through", () => {
    const raw = { summary: "coherent", notes: [{ title: "T", markdown: "M", severity: "major" }] };
    expect(validateReviewVerdict(raw)).toEqual(raw);
  });

  it.each([
    ["critical", "critical"],
    ["  CRITICAL ", "critical"],
    ["Major", "major"],
    ["blocker", "minor"],
    [7, "minor"],
    [undefined, "minor"],
  ])("coerces severity %j to %s", (rawSeverity, expected) => {
    const out = validateReviewVerdict({ summary: "s", notes: [{ title: "t", markdown: "m", severity: rawSeverity }] });
    expect(out?.notes[0].severity).toBe(expected);
  });

  it("drops notes without a usable title and markdown", () => {
    const out = validateReviewVerdict({
      summary: "s",
      notes: [
        { title: "keep", markdown: "body" },
        { title: "", markdown: "body" },
        { title: "no body" },
        { markdown: "no title" },
        "not an object",
        null,
      ],
    });
    expect(out?.notes).toEqual([{ title: "keep", markdown: "body", severity: "minor" }]);
  });

  it("wraps a single bare note object", () => {
    const out = validateReviewVerdict({ summary: "s", notes: { title: "t", markdown: "m" } });
    expect(out?.notes).toEqual([{ title: "t", markdown: "m", severity: "minor" }]);
  });

  it("defaults missing notes to []", () => {
    expect(validateReviewVerdict({ summary: "s" })).toEqual({ summary: "s", notes: [] });
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a missing summary", { notes: [] }],
    ["a blank summary", { summary: "", notes: [] }],
  ])("returns null for %s", (_label, raw) => {
    expect(validateReviewVerdict(raw)).toBeNull();
  });
});

describe("decideAvailability", () => {
  const resolvable = (): string => "/usr/local/bin/claude";

  it("is available with a resolvable binary and no kill switch", () => {
    expect(decideAvailability({}, resolvable)).toEqual({ available: true });
  });

  it("the SPEC_RESTATE_CRITIC=0 kill switch wins", () => {
    const out = decideAvailability({ SPEC_RESTATE_CRITIC: "0" }, resolvable);
    expect(out.available).toBe(false);
    expect(out.reason).toMatch(/SPEC_RESTATE_CRITIC/);
  });

  it("only the exact value \"0\" disables", () => {
    expect(decideAvailability({ SPEC_RESTATE_CRITIC: "1" }, resolvable).available).toBe(true);
  });

  it("an unresolvable binary means unavailable", () => {
    const out = decideAvailability({}, () => null);
    expect(out.available).toBe(false);
    expect(out.reason).toMatch(/claude/);
  });
});
