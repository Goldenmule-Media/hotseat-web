/**
 * `parseBlocks` — block-level Markdown → the closed IBlock vocabulary.
 *
 * Covers every supported construct (paragraphs, ATX headings, fenced code, blockquotes,
 * nested lists, GFM tables, dividers), a mixed document, graceful degradation to
 * paragraphs, injected-id discipline, a render→reparse stability property against the
 * engine's real block renderer, and acceptance by the real blocks-field ingestion path
 * (a generated setField command through the command bus's dry-run validation).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IBlock, IWorkspaceHandle, PageId } from "../src/api";
import { definePageType, parseBlocks, t, z, zodSchema } from "../src/authoring";
import { contentHash, normalizeBlocks } from "../src/core/ingestion";
import { renderBlocks } from "../src/render/blocks";
import { createTestWiki, type ITestWiki } from "../src/testing";

/** Deterministic id source; each test builds its own so ids are stable per test. */
function ids(): () => string {
  let n = 0;
  return () => `b-${++n}`;
}

/** Structural equivalence helper: the same tree minus the (freshly-minted) ids. */
function stripIds(blocks: readonly IBlock[]): unknown[] {
  return blocks.map((b) => {
    const { id, ...rest } = b as IBlock & { id: string };
    void id;
    if (b.kind === "list") return { ...rest, items: b.items.map((item) => stripIds(item)) };
    if (b.kind === "quote") return { ...rest, blocks: stripIds(b.blocks) };
    return rest;
  });
}

describe("parseBlocks", () => {
  it("splits blank-line-separated paragraphs and reifies inline Markdown", () => {
    const out = parseBlocks("First para.\n\nSecond **bold** and `code`.", ids());
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: "paragraph" });
    const second = out[1]!;
    expect(second.kind).toBe("paragraph");
    if (second.kind === "paragraph") {
      expect(second.inlines).toContainEqual({ kind: "text", value: "bold", marks: ["strong"] });
      expect(second.inlines).toContainEqual({ kind: "code-span", value: "code" });
    }
  });

  it("joins a paragraph's continuation lines with a single space", () => {
    const out = parseBlocks("one\ntwo\nthree", ids());
    expect(out).toEqual([
      { kind: "paragraph", id: "b-1", inlines: [{ kind: "text", value: "one two three", marks: [] }] },
    ]);
  });

  it("parses ATX headings at every level", () => {
    const out = parseBlocks("# One\n\n### Three\n\n###### Six", ids());
    expect(out.map((b) => (b.kind === "heading" ? b.level : b.kind))).toEqual([1, 3, 6]);
  });

  it("parses a fenced code block: lang, verbatim source, real content hash", () => {
    const out = parseBlocks("```ts\nconst a = 1;\n  indented\n```", ids());
    expect(out).toEqual([
      {
        kind: "code",
        id: "b-1",
        lang: "ts",
        source: "const a = 1;\n  indented",
        hash: contentHash("const a = 1;\n  indented"),
      },
    ]);
  });

  it("defaults a lang-less fence to \"text\" and runs an unclosed fence to the end", () => {
    const out = parseBlocks("```\nplain\n```\n\n```js\nnever closed", ids());
    expect(out[0]).toMatchObject({ kind: "code", lang: "text", source: "plain" });
    expect(out[1]).toMatchObject({ kind: "code", lang: "js", source: "never closed" });
  });

  it("parses a blockquote, including nested block content", () => {
    const out = parseBlocks("> # Title\n> first\n>\n> second", ids());
    expect(out).toHaveLength(1);
    const q = out[0]!;
    expect(q.kind).toBe("quote");
    if (q.kind === "quote") {
      expect(q.blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "paragraph"]);
    }
  });

  it("parses unordered (- and *) and ordered (1.) lists", () => {
    const out = parseBlocks("- a\n- b\n* c\n\n1. x\n2. y", ids());
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: "list", ordered: false });
    expect(out[1]).toMatchObject({ kind: "list", ordered: true });
    if (out[0]!.kind === "list") expect(out[0]!.items).toHaveLength(3);
    if (out[1]!.kind === "list") expect(out[1]!.items).toHaveLength(2);
  });

  it("nests a two-space-indented sublist inside its parent item", () => {
    const out = parseBlocks("- a\n  - b\n  - c\n- d", ids());
    expect(out).toHaveLength(1);
    const listBlock = out[0]!;
    expect(listBlock.kind).toBe("list");
    if (listBlock.kind !== "list") return;
    expect(listBlock.items).toHaveLength(2);
    const firstItem = listBlock.items[0]!;
    expect(firstItem.map((b) => b.kind)).toEqual(["paragraph", "list"]);
    const nested = firstItem[1]!;
    if (nested.kind === "list") expect(nested.items).toHaveLength(2);
  });

  it("parses a GFM table with alignment and escaped pipes", () => {
    const out = parseBlocks("| A | B | C |\n| :--- | :---: | ---: |\n| a \\| x | b | c |", ids());
    expect(out).toHaveLength(1);
    const table = out[0]!;
    expect(table.kind).toBe("table");
    if (table.kind !== "table") return;
    expect(table.align).toEqual(["left", "center", "right"]);
    expect(table.header.map((cell) => cell[0])).toEqual([
      { kind: "text", value: "A", marks: [] },
      { kind: "text", value: "B", marks: [] },
      { kind: "text", value: "C", marks: [] },
    ]);
    expect(table.rows[0]![0]![0]).toEqual({ kind: "text", value: "a | x", marks: [] });
  });

  it("parses a thematic break as a divider", () => {
    expect(parseBlocks("---", ids())).toEqual([{ kind: "divider", id: "b-1" }]);
  });

  it("parses a mixed document in order", () => {
    const md = [
      "# Title",
      "",
      "Intro paragraph.",
      "",
      "- one",
      "- two",
      "",
      "```py",
      "x = 1",
      "```",
      "",
      "> quoted",
      "",
      "| H |",
      "| --- |",
      "| v |",
      "",
      "---",
    ].join("\n");
    const out = parseBlocks(md, ids());
    expect(out.map((b) => b.kind)).toEqual(["heading", "paragraph", "list", "code", "quote", "table", "divider"]);
  });

  it("degrades unsupported/malformed input to paragraphs without throwing or dropping content", () => {
    // No space after # → not a heading; a pipe row without a delimiter → not a table;
    // 7 hashes → not a heading.
    const out = parseBlocks("#nospace\n\n| not | a table |\n\n####### seven", ids());
    expect(out.map((b) => b.kind)).toEqual(["paragraph", "paragraph", "paragraph"]);
    const texts = out.map((b) => (b.kind === "paragraph" ? b.inlines.map((r) => ("value" in r ? r.value : "")).join("") : ""));
    expect(texts[0]).toBe("#nospace");
    expect(texts[1]).toBe("| not | a table |");
    expect(texts[2]).toBe("####### seven");
  });

  it("mints every block id from the injected generator only", () => {
    const out = parseBlocks("# H\n\npara\n\n- a\n  - b\n\n> q\n\n---", ids());
    const all: string[] = [];
    const collect = (blocks: readonly IBlock[]): void => {
      for (const b of blocks) {
        all.push(b.id);
        if (b.kind === "list") for (const item of b.items) collect(item);
        if (b.kind === "quote") collect(b.blocks);
      }
    };
    collect(out);
    expect(all.length).toBeGreaterThanOrEqual(7);
    expect(all.every((id) => /^b-\d+$/.test(id))).toBe(true);
    expect(new Set(all).size).toBe(all.length);
  });

  it("is stable under render→reparse (the engine's real block renderer)", () => {
    const md = [
      "# Title with `code` and **bold**",
      "",
      "A paragraph with _emphasis_ and a [link](https://example.com).",
      "",
      "- item one",
      "- item two",
      "  - nested",
      "",
      "1. first",
      "2. second",
      "",
      "```ts",
      "const x: number = 1;",
      "```",
      "",
      "> a quote",
      "> with two lines",
      "",
      "| Col A | Col B |",
      "| :--- | ---: |",
      "| a \\| pipe | b |",
      "",
      "---",
    ].join("\n");
    const label = (): string => "ref";
    const first = normalizeBlocks(parseBlocks(md, ids()));
    const rendered = renderBlocks(first, label);
    const second = normalizeBlocks(parseBlocks(rendered, ids()));
    expect(stripIds(second)).toEqual(stripIds(first));
    // And the render itself is a fixed point from there on.
    expect(renderBlocks(second, label)).toBe(rendered);
  });
});

// A minimal type with a blocks field so parseBlocks output can be pushed through the
// REAL ingestion path (generated setField → dry-run validatePage → block normal form).
const DocFixture = definePageType({
  type: "blockmd-fixture",
  version: 1,
  initialStatus: "draft",
  statusTransitions: [t("draft", "seal", "sealed")],
  sections: {
    doc: { name: "Doc", required: true, fields: { body: { kind: "blocks" } } },
  },
  sectionSet: { mode: "closed" },
  commands: {
    seal: { args: zodSchema(z.object({})), transition: { level: "page", event: "seal" } },
  },
  render: {
    title: "{title}",
    graphSections: false,
    sections: [{ section: "doc", field: "body", as: "blocks" }],
  },
});

describe("parseBlocks output through real blocks-field ingestion", () => {
  let harness: ITestWiki;
  let ws: IWorkspaceHandle;
  let pageId: PageId;

  beforeAll(async () => {
    harness = await createTestWiki([DocFixture]);
    ws = await harness.wiki.createWorkspace({ name: "Docs" });
    pageId = (await ws.createPage("blockmd-fixture", { title: "Doc", parentId: null })).value;
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("is accepted by the generated setField command's validation and renders back", async () => {
    const md = [
      "# Overview",
      "",
      "Some *emphasized* prose with `inline code`.",
      "",
      "- alpha",
      "- beta",
      "",
      "```sh",
      "echo hi",
      "```",
      "",
      "| K | V |",
      "| --- | --- |",
      "| a | 1 |",
      "",
      "> note",
    ].join("\n");
    const blocks = parseBlocks(md, ids());
    const { token } = await ws.mutate(pageId, "setDocBody", { value: { kind: "blocks", blocks } });
    const rendered = await ws.toMarkdown(pageId, { consistentWith: token });
    expect(rendered).toContain("# Overview");
    expect(rendered).toContain("_emphasized_");
    expect(rendered).toContain("`inline code`");
    expect(rendered).toContain("- alpha");
    expect(rendered).toContain("```sh\necho hi\n```");
    expect(rendered).toContain("| K | V |");
    expect(rendered).toContain("> note");
  });
});

describe("image blocks", () => {
  const ids = (): (() => string) => {
    let n = 0;
    return () => `b${++n}`;
  };

  it("parses a line that is exactly one image", () => {
    expect(parseBlocks("![A diagram](attachment:" + "a".repeat(64) + ")", ids())).toEqual([
      { kind: "image", id: "b1", ref: "attachment:" + "a".repeat(64), alt: "A diagram" },
    ]);
  });

  it("parses an optional title, and an ordinary URL ref", () => {
    expect(parseBlocks('![Cat](https://example.com/cat.png "A cat")', ids())).toEqual([
      { kind: "image", id: "b1", ref: "https://example.com/cat.png", alt: "Cat", title: "A cat" },
    ]);
  });

  it("leaves an image that is not the whole line as a paragraph", () => {
    // Mid-paragraph images keep the historic degradation (a literal `!` plus a link),
    // so nothing that parses today changes shape.
    const [block] = parseBlocks("see ![Cat](https://example.com/cat.png) here", ids());
    expect(block?.kind).toBe("paragraph");
    const [trailing] = parseBlocks("![Cat](https://example.com/cat.png).", ids());
    expect(trailing?.kind).toBe("paragraph");
  });

  it("round-trips as a parse fixed point", () => {
    for (const md of [
      "![A diagram](attachment:" + "b".repeat(64) + ")",
      '![Cat](https://example.com/cat.png "A cat")',
      "![](attachment:" + "c".repeat(64) + ")",
    ]) {
      const blocks = parseBlocks(md, ids());
      const rendered = renderBlocks(blocks, () => "");
      expect(rendered).toBe(md);
      expect(parseBlocks(rendered, ids())).toEqual(blocks);
    }
  });

  it("separates an image from surrounding paragraphs", () => {
    const blocks = parseBlocks("Before\n![Shot](attachment:" + "d".repeat(64) + ")\nAfter", ids());
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "image", "paragraph"]);
  });
});

describe("tab-indented nesting (Obsidian / Evernote exports)", () => {
  it("reads a leading tab as one indent, so a tab-nested sublist nests", () => {
    let n = 0;
    const blocks = parseBlocks("* Top one\n\t* Nested a\n\t* Nested b\n* Top two", () => `b${n++}`);
    expect(blocks).toHaveLength(1);
    const list = blocks[0] as Extract<IBlock, { kind: "list" }>;
    expect(list.kind).toBe("list");
    expect(list.items).toHaveLength(2);
    // The first item carries its paragraph PLUS the nested list, not literal "* Nested a".
    const sub = list.items[0].find((b) => b.kind === "list") as Extract<IBlock, { kind: "list" }>;
    expect(sub).toBeDefined();
    expect(sub.items).toHaveLength(2);
  });
});
