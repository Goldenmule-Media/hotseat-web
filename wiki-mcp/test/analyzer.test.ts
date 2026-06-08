/**
 * The built-in TS/JS analyzer. Asserts the
 * `ILanguageAnalyzer` contract over a sample TS snippet with nested declarations:
 * symbols carry name/kind/container + a `[defStart, defEnd)` offset range that slices
 * back to the declaration text; references are identifier occurrences keyed by name.
 * Also checks determinism (equal input → equal output) and JS/JSX dialect handling.
 */
import { describe, expect, it } from "vitest";

import { typescriptAnalyzer } from "../src/models/analyzers/index.js";
import { createLanguageRegistry } from "../src/models/analyzers/index.js";

const SNIPPET = `export function greet(name: string): string {
  return "hi " + name;
}

const TAU = 6.28;

export class Counter {
  private count = 0;
  increment(): number {
    return ++this.count;
  }
  get value(): number {
    return this.count;
  }
}

interface Shape {
  area(): number;
}

type Id = string | number;

enum Color { Red, Green }
`;

describe("TypeScript/JS analyzer", () => {
  it("extracts declarations as offset-ranged symbols (incl. nested members)", () => {
    const syms = typescriptAnalyzer.symbols(SNIPPET, "ts");
    const byName = (n: string) => syms.filter((s) => s.name === n);

    // top-level function
    const greet = byName("greet")[0];
    expect(greet).toBeDefined();
    expect(greet.kind).toBe("function");
    expect(greet.exported).toBe(true);
    // the def range slices back to the declaration source verbatim.
    expect(SNIPPET.slice(greet.defStart, greet.defEnd)).toMatch(/^export function greet/);

    // top-level const
    expect(byName("TAU")[0]?.kind).toBe("const");

    // class + its members (container is the class name)
    const counter = byName("Counter")[0];
    expect(counter.kind).toBe("class");
    expect(counter.exported).toBe(true);
    const inc = byName("increment")[0];
    expect(inc.kind).toBe("method");
    expect(inc.container).toBe("Counter");
    expect(byName("count")[0]?.kind).toBe("property");
    expect(byName("value")[0]?.kind).toBe("getter");
    expect(byName("value")[0]?.container).toBe("Counter");

    // interface + method signature
    expect(byName("Shape")[0]?.kind).toBe("interface");
    expect(byName("area")[0]?.kind).toBe("method");
    expect(byName("area")[0]?.container).toBe("Shape");

    // type alias + enum + enum members
    expect(byName("Id")[0]?.kind).toBe("type");
    expect(byName("Color")[0]?.kind).toBe("enum");
    expect(byName("Red")[0]?.kind).toBe("enum-member");
    expect(byName("Red")[0]?.container).toBe("Color");
  });

  it("extracts identifier references by name with offsets", () => {
    const refs = typescriptAnalyzer.references(SNIPPET, "name");
    // `name` appears as the param and again in the return expression.
    expect(refs.length).toBeGreaterThanOrEqual(2);
    for (const r of refs) {
      expect(r.name).toBe("name");
      expect(SNIPPET.slice(r.start, r.end)).toBe("name");
    }

    // all references (no name filter) include the declared symbols' identifiers.
    const all = typescriptAnalyzer.references(SNIPPET);
    expect(all.some((r) => r.name === "greet")).toBe(true);
    expect(all.some((r) => r.name === "Counter")).toBe(true);
  });

  it("is deterministic — equal input yields equal output", () => {
    expect(typescriptAnalyzer.symbols(SNIPPET, "ts")).toEqual(typescriptAnalyzer.symbols(SNIPPET, "ts"));
    expect(typescriptAnalyzer.references(SNIPPET)).toEqual(typescriptAnalyzer.references(SNIPPET));
  });

  it("parses JS and TSX dialects without throwing and finds symbols", () => {
    const js = "function f(){ return 1; } const g = () => f();";
    expect(typescriptAnalyzer.symbols(js, "js").some((s) => s.name === "f" && s.kind === "function")).toBe(true);

    const tsx = "export const App = () => <div className=\"x\">hi</div>;";
    const tsxSyms = typescriptAnalyzer.symbols(tsx, "tsx");
    expect(tsxSyms.some((s) => s.name === "App")).toBe(true);
  });

  it("the registry resolves ts/tsx/js/jsx to the built-in analyzer and unknown langs to undefined", () => {
    const reg = createLanguageRegistry();
    for (const lang of ["ts", "tsx", "js", "jsx", "mjs", "cjs", "TS"]) {
      expect(reg.get(lang)).toBe(typescriptAnalyzer);
    }
    expect(reg.get("python")).toBeUndefined();
    expect(reg.get("rust")).toBeUndefined();
  });
});
