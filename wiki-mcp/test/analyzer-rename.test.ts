/**
 * Type-aware single-source rename in the TS/JS analyzer (Phase 3). Built on a
 * single-file `ts.Program` + checker, so:
 *
 *  - occurrences that BIND to the target declaration are renamed (def + uses);
 *  - a SHADOWING inner binding of the same name is NOT renamed (scope-correct);
 *  - an unrelated same-name symbol is NOT renamed;
 *  - rename-by-offset disambiguates which binding the target is;
 *  - it is deterministic (equal input → equal edits) and pure (returns edits, never writes).
 */
import { describe, expect, it } from "vitest";

import { typescriptAnalyzer } from "../src/models/analyzers/index.js";
import type { AnalyzerTextEdit } from "../src/models/language-registry.js";

/** Apply edits to a source string (descending), mirroring the engine's replay. */
function applyEdits(source: string, edits: readonly AnalyzerTextEdit[]): string {
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  let out = source;
  for (const e of ordered) out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  return out;
}

describe("TS analyzer: type-aware rename", () => {
  it("renames the declaration and all bound uses of a top-level function", () => {
    const src = `function alpha(x: number): number { return alpha(x) + 1; }\nconst y = alpha(2);\n`;
    const r = typescriptAnalyzer.rename!(src, { name: "alpha" }, "gamma", "ts");
    expect(r.oldName).toBe("alpha");
    // def + recursive call + call site = 3 occurrences.
    expect(r.edits.length).toBe(3);
    expect(applyEdits(src, r.edits)).toBe(src.replaceAll("alpha", "gamma"));
  });

  it("does NOT rename a shadowing inner binding of the same name", () => {
    const src = [
      "function outer(value: number): number {",
      "  function inner(value: number): number { return value * 2; }", // `value` here SHADOWS the param
      "  return inner(value) + value;",
      "}",
      "",
    ].join("\n");

    // Rename the OUTER `value` parameter (by offset of its declaration).
    const declOffset = src.indexOf("value", src.indexOf("outer("));
    const r = typescriptAnalyzer.rename!(src, { offset: declOffset }, "amount", "ts");
    const renamed = applyEdits(src, r.edits);

    // The inner function's `value` param and its uses are UNTOUCHED.
    expect(renamed).toContain("function inner(value: number): number { return value * 2; }");
    // The outer uses ARE renamed.
    expect(renamed).toContain("return inner(amount) + amount;");
    expect(renamed).toContain("function outer(amount: number)");
    // The analyzer reports that a same-named binding was left alone.
    expect(r.unresolved.some((u) => u.includes("shadowed") || u.includes("unrelated"))).toBe(true);
  });

  it("does NOT rename an unrelated same-name symbol in a sibling scope", () => {
    const src = [
      "function a(): number { const n = 1; return n; }",
      "function b(): number { const n = 2; return n; }",
      "",
    ].join("\n");
    // Rename the `n` in function `a` only (the offset of its `const n` declaration).
    const declOffset = src.indexOf("const n") + "const ".length;
    const r = typescriptAnalyzer.rename!(src, { offset: declOffset }, "m", "ts");
    const renamed = applyEdits(src, r.edits);
    expect(renamed).toContain("function a(): number { const m = 1; return m; }");
    expect(renamed).toContain("function b(): number { const n = 2; return n; }");
  });

  it("reports unresolved when the target name is absent", () => {
    const src = `const x = 1;\n`;
    const r = typescriptAnalyzer.rename!(src, { name: "nope" }, "y", "ts");
    expect(r.edits.length).toBe(0);
    expect(r.unresolved.length).toBeGreaterThan(0);
  });

  it("is deterministic — equal input yields equal edits", () => {
    const src = `function f(){ return f(); }\n`;
    const a = typescriptAnalyzer.rename!(src, { name: "f" }, "g", "ts");
    const b = typescriptAnalyzer.rename!(src, { name: "f" }, "g", "ts");
    expect(a).toEqual(b);
  });
});
