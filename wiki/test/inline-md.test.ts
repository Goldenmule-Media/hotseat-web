/**
 * Inline-Markdown parser (`core/inline-md`) — the inverse of `render/blocks`'s
 * `renderInline`. Verifies the supported CommonMark subset, the intraword-`_` and flanking
 * rules that keep identifiers literal, the `isInertText` leaf predicate, and — the
 * load-bearing invariant — that parse∘render is a fixed point so render-verbatim round-trips.
 */
import { describe, expect, it } from "vitest";

import type { BlockId, IInline } from "../src/api";
import { parseInline, isInertText } from "../src/core/inline-md";
import { normalizeBlock } from "../src/core/ingestion";
import { renderInlines } from "../src/render/blocks";

// A label resolver is irrelevant here (no refs); throw if one sneaks in.
const noRefs = (): string => {
  throw new Error("no refs expected");
};

/** Parse → canonical-normalize (merge/sort marks) via the engine's block normalizer,
 *  matching what ingestion stores for a paragraph. */
function normalizeInlines(inlines: IInline[]): IInline[] {
  const block = normalizeBlock({ kind: "paragraph", id: "b" as BlockId, inlines });
  return block.kind === "paragraph" ? block.inlines : [];
}
function parse(text: string): IInline[] {
  return normalizeInlines(parseInline(text));
}

describe("parseInline — supported subset", () => {
  it("plain text is one unmarked run", () => {
    expect(parse("hello world")).toEqual([{ kind: "text", value: "hello world", marks: [] }]);
  });

  it("reifies a code span", () => {
    expect(parse("see `game/export_presets.cfg` now")).toEqual([
      { kind: "text", value: "see ", marks: [] },
      { kind: "code-span", value: "game/export_presets.cfg" },
      { kind: "text", value: " now", marks: [] },
    ]);
  });

  it("keeps an intraword underscore literal (the import_etc2_astc case)", () => {
    expect(parse("set import_etc2_astc and export_filter")).toEqual([
      { kind: "text", value: "set import_etc2_astc and export_filter", marks: [] },
    ]);
  });

  it("keeps a bare asterisk literal (2 * 3)", () => {
    expect(parse("compute 2 * 3 = 6")).toEqual([{ kind: "text", value: "compute 2 * 3 = 6", marks: [] }]);
  });

  it("emphasis: *x* and _x_ → emphasis mark", () => {
    expect(parse("an *italic* word")).toEqual([
      { kind: "text", value: "an ", marks: [] },
      { kind: "text", value: "italic", marks: ["emphasis"] },
      { kind: "text", value: " word", marks: [] },
    ]);
    expect(parse("an _italic_ word")).toEqual([
      { kind: "text", value: "an ", marks: [] },
      { kind: "text", value: "italic", marks: ["emphasis"] },
      { kind: "text", value: " word", marks: [] },
    ]);
  });

  it("strong: **x** and __x__ → strong mark", () => {
    expect(parse("a **bold** word")).toEqual([
      { kind: "text", value: "a ", marks: [] },
      { kind: "text", value: "bold", marks: ["strong"] },
      { kind: "text", value: " word", marks: [] },
    ]);
    expect(parse("a __bold__ word")).toEqual([
      { kind: "text", value: "a ", marks: [] },
      { kind: "text", value: "bold", marks: ["strong"] },
      { kind: "text", value: " word", marks: [] },
    ]);
  });

  it("nested strong+emphasis", () => {
    // ***x*** → emphasis inside strong (both marks on the run).
    const runs = parse("***wow***");
    expect(runs).toEqual([{ kind: "text", value: "wow", marks: ["emphasis", "strong"] }]);
  });

  it("a link → text run carrying a link mark", () => {
    expect(parse("[the docs](https://x.test/y)")).toEqual([
      { kind: "text", value: "the docs", marks: [{ kind: "link", href: "https://x.test/y" }] },
    ]);
  });

  it("emphasis inside a link label combines marks", () => {
    expect(parse("[*hi* there](u)")).toEqual([
      { kind: "text", value: "hi", marks: ["emphasis", { kind: "link", href: "u" }] },
      { kind: "text", value: " there", marks: [{ kind: "link", href: "u" }] },
    ]);
  });

  it("unclosed delimiters and malformed links stay literal", () => {
    expect(parse("a * b and [not a link")).toEqual([{ kind: "text", value: "a * b and [not a link", marks: [] }]);
    expect(parse("`unterminated code")).toEqual([{ kind: "text", value: "`unterminated code", marks: [] }]);
  });

  it("empty string → a single empty run", () => {
    expect(parseInline("")).toEqual([{ kind: "text", value: "", marks: [] }]);
  });
});

describe("isInertText — the leaf predicate", () => {
  it("inert: plain text, identifiers, bare delimiters", () => {
    expect(isInertText("plain prose")).toBe(true);
    expect(isInertText("import_etc2_astc")).toBe(true);
    expect(isInertText("a_b_c and export_filter")).toBe(true);
    expect(isInertText("2 * 3 = 6")).toBe(true);
    expect(isInertText("a stray [ bracket")).toBe(true);
  });

  it("NOT inert: anything that parses to structure", () => {
    expect(isInertText("`code`")).toBe(false);
    expect(isInertText("*em*")).toBe(false);
    expect(isInertText("**strong**")).toBe(false);
    expect(isInertText("[x](y)")).toBe(false);
  });
});

describe("parse∘render is a fixed point (round-trip)", () => {
  // For every renderer output, parsing it back then re-rendering must be byte-identical —
  // this is what lets a text leaf render verbatim and still reparse to the same AST.
  const cases = [
    "plain",
    "with `code` span",
    "an _emphasis_ here",
    "a **strong** here",
    "both **_nested_** marks",
    "a [link](https://e.test/p) inline",
    "identifier import_etc2_astc stays put",
    "math 2 * 3 stays put",
  ];
  for (const md of cases) {
    it(`round-trips: ${md}`, () => {
      const once = normalizeInlines(parseInline(md));
      const rendered = renderInlines(once, noRefs);
      const twice = normalizeInlines(parseInline(rendered));
      expect(renderInlines(twice, noRefs)).toBe(rendered);
      // And the AST itself is stable on the second parse.
      expect(twice).toEqual(once);
    });
  }
});
