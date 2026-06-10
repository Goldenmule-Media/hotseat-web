/**
 * `document` page type — a general-purpose, lifecycle-free document: the ENTIRE content
 * is one ordered `blocks` field curating the full engine block vocabulary (paragraphs,
 * headings, code, lists, quotes, tables, dividers) with rich inline runs (bold/italic/
 * link marks, code spans, integrity-checked page refs). Single `active` status, zero FSM
 * transitions — always editable; structural archive handles removal. Determinism: ids
 * arrive via the injected deterministic `newId()`; equal state must render byte-identical
 * Markdown.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import documentPageTypes, { Document } from "wiki-models/document";
import type { DeepReadonly, IField, IWiki, IWorkspaceHandle, PageId, PageState } from "../src/api";
import { StaleEditError } from "../src/core/errors";
import { contentHash } from "../src/core/ingestion";
import { createTestWiki, type ITestWiki } from "../src/testing";

/** The body section's blocks field from a page state. */
function blocksField(state: DeepReadonly<PageState>) {
  const f: DeepReadonly<IField> | undefined = state.sections.find((s) => s.key === "body")?.fields["body"];
  if (f === undefined || f.kind !== "blocks") throw new Error("body.body is not a blocks field");
  return f;
}

/** The rendered "## Body" block (title/status stripped, graph sections stripped). */
async function bodyOf(ws: IWorkspaceHandle, doc: PageId): Promise<string> {
  const md = await ws.toMarkdown(doc);
  const start = md.indexOf("## Body\n");
  expect(start).toBeGreaterThanOrEqual(0);
  const tail = md.slice(start + "## Body\n".length);
  const end = tail.indexOf("\n## References");
  return (end >= 0 ? tail.slice(0, end) : tail).trimEnd();
}

async function addBlockTo(ws: IWorkspaceHandle, doc: PageId, command: string, args: Record<string, unknown>): Promise<string> {
  return ((await ws.mutate(doc, command, args)).value as { blockId: string }).blockId;
}

describe("document: bundle contract and FSM shape", () => {
  it("default-exports an array of exactly one page type tagged `document`", () => {
    expect(documentPageTypes).toHaveLength(1);
    expect(documentPageTypes[0]).toBe(Document);
    expect(Document.__def.type).toBe("document");
  });

  it("is single-state: `active` initial, no transitions, hence no agency edges", async () => {
    const harness = await createTestWiki(documentPageTypes);
    try {
      const fsm = harness.wiki.fsmOf("document");
      expect(fsm.initial).toBe("active");
      expect(fsm.states).toEqual(["active"]);
      expect(fsm.transitions).toEqual([]);
      // The instance-free authoring surface exposes the curated content commands and
      // not a single page-transition command.
      const desc = harness.wiki.describeType("document");
      const names = desc.commands.map((c) => c.name);
      for (const n of [
        "addParagraph",
        "addHeading",
        "addCode",
        "addList",
        "addQuote",
        "addTable",
        "addDivider",
        "setParagraph",
        "setHeading",
        "setList",
        "setQuote",
        "setTable",
        "moveBlock",
        "removeBlock",
      ]) {
        expect(names).toContain(n);
      }
      // Subsumed by inline runs: a {ref} run replaces addPageRef, a {text, href} run
      // replaces addExternalLink.
      expect(names).not.toContain("addPageRef");
      expect(names).not.toContain("addExternalLink");
      expect(desc.commands.filter((c) => c.transition?.level === "page")).toEqual([]);
    } finally {
      await harness.stop();
    }
  });
});

describe("document: authoring and deterministic rendering", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;
  let doc: PageId;
  let codeId: string;
  let prefaceId: string;

  const body = () => bodyOf(ws, doc);
  const addBlock = (command: string, args: Record<string, unknown>) => addBlockTo(ws, doc, command, args);

  beforeAll(async () => {
    harness = await createTestWiki(documentPageTypes);
    wiki = harness.wiki;
    ws = await wiki.createWorkspace({ name: "Docs" });
    doc = (await ws.createPage("document", { title: "Scratch", parentId: null })).value;
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("creates with an empty body that renders the placeholder, byte-identically", async () => {
    const md = await ws.toMarkdown(doc);
    expect(md.startsWith("# Scratch\n")).toBe(true);
    expect(md).toContain("**Status:** active");
    expect(await body()).toBe("_Empty document._");
    expect(await ws.toMarkdown(doc)).toBe(md); // equal state → byte-identical render
  });

  it("authors heading → paragraph → code → paragraph in exactly that order (golden)", async () => {
    await addBlock("addHeading", { level: 2, inlines: ["Intro"] });
    await addBlock("addParagraph", { inlines: ["Hello world."] });
    codeId = await addBlock("addCode", { language: "ts", source: "export const x = 1;" });
    await addBlock("addParagraph", { inlines: ["Done."] });
    expect(await body()).toBe(
      ["## Intro", "Hello world.", "```ts\nexport const x = 1;\n```", "Done."].join("\n\n"),
    );
  });

  it("inserts at an explicit index", async () => {
    prefaceId = await addBlock("addParagraph", { inlines: ["Preface."], index: 0 });
    expect((await body()).startsWith("Preface.\n\n## Intro")).toBe(true);
  });

  it("moveBlock reorders and setParagraph replaces in place (same id)", async () => {
    await ws.mutate(doc, "moveBlock", { blockId: prefaceId, toIndex: 4 });
    await ws.mutate(doc, "setParagraph", { blockId: prefaceId, inlines: ["The end."] });
    expect(await body()).toBe(
      ["## Intro", "Hello world.", "```ts\nexport const x = 1;\n```", "Done.", "The end."].join("\n\n"),
    );
    const ids = blocksField(await (await ws.page(doc)).state()).blocks.map((b) => String(b.id));
    expect(ids[4]).toBe(prefaceId); // replaced in place, id stable
  });

  it("rejects removeBlock on an unknown id, leaving state and render unchanged", async () => {
    const before = await ws.toMarkdown(doc);
    await expect(ws.mutate(doc, "removeBlock", { blockId: "no-such-block" })).rejects.toThrow();
    expect(await ws.toMarkdown(doc)).toBe(before);
    await ws.mutate(doc, "removeBlock", { blockId: prefaceId }); // the happy path removes
    expect(await body()).toBe(
      ["## Intro", "Hello world.", "```ts\nexport const x = 1;\n```", "Done."].join("\n\n"),
    );
  });

  it("canonicalizes the code hash at ingestion and guards edits with expectedHash", async () => {
    const blk = blocksField(await (await ws.page(doc)).state()).blocks.find((b) => String(b.id) === codeId);
    if (blk === undefined || blk.kind !== "code") throw new Error("not a code block");
    expect(blk.hash).toBe(contentHash(blk.source)); // "" was recomputed at ingestion

    // A stale hash is rejected with the typed error; the current hash applies.
    const edit = [{ start: 0, end: 0, replacement: "// doc\n" }];
    await expect(
      ws.mutate(doc, "applyBodyBodyBlockEdits", { block: codeId, edits: edit, expectedHash: "deadbeef" }),
    ).rejects.toBeInstanceOf(StaleEditError);
    const c = await ws.mutate(doc, "applyBodyBodyBlockEdits", { block: codeId, edits: edit, expectedHash: blk.hash });
    const after = blocksField(await (await ws.page(doc, { consistentWith: c.token })).state()).blocks.find(
      (b) => String(b.id) === codeId,
    );
    if (after === undefined || after.kind !== "code") throw new Error("not a code block");
    expect(after.source).toBe("// doc\nexport const x = 1;");
    expect(after.hash).toBe(contentHash(after.source));
  });

  it("a {ref} run threads an integrity-checked page ref (render-derived label); a dangling id aborts", async () => {
    const other = (await ws.createPage("document", { title: "Other notes", parentId: null })).value;
    await addBlock("addParagraph", { inlines: ["See ", { ref: String(other) }] });
    expect(await body()).toContain("See Other notes");
    // Renames reflow: the label is render-derived, not snapshotted.
    await ws.setPageTitle(other, "Other notes (renamed)");
    expect(await body()).toContain("See Other notes (renamed)");

    const before = await ws.toMarkdown(doc);
    await expect(ws.mutate(doc, "addParagraph", { inlines: [{ ref: "document:does-not-exist" }] })).rejects.toThrow();
    expect(await ws.toMarkdown(doc)).toBe(before);
  });

  it("a {text, href} run renders a Markdown link from the link mark", async () => {
    await addBlock("addParagraph", { inlines: [{ text: "the upstream spec", href: "https://example.com/spec" }] });
    expect(await body()).toContain("[the upstream spec](https://example.com/spec)");
  });

  it("setParagraph rejects a non-paragraph target instead of silently converting it", async () => {
    const before = await ws.toMarkdown(doc);
    await expect(ws.mutate(doc, "setParagraph", { blockId: codeId, inlines: ["oops"] })).rejects.toThrow(
      /only edits paragraph/,
    );
    expect(await ws.toMarkdown(doc)).toBe(before); // the code block survives
  });

  it("rejects malformed args at the curated schema: empty runs, mixed run shapes, fence-corrupting language", async () => {
    await expect(ws.mutate(doc, "addParagraph", { inlines: [] })).rejects.toThrow();
    await expect(ws.mutate(doc, "addParagraph", { inlines: [""] })).rejects.toThrow();
    // A strict union: a run mixing shapes fails instead of silently dropping keys.
    await expect(ws.mutate(doc, "addParagraph", { inlines: [{ text: "x", code: "y" }] })).rejects.toThrow();
    await expect(ws.mutate(doc, "addHeading", { level: 7, inlines: ["x"] })).rejects.toThrow();
    // "```" + language renders verbatim into the fence line — whitespace/backticks are barred.
    await expect(ws.mutate(doc, "addCode", { language: "ts\n# pwned", source: "x" })).rejects.toThrow();
    await expect(ws.mutate(doc, "addCode", { language: "", source: "x" })).rejects.toThrow();
  });
});

describe("document: inline runs — marks, code spans, normalization, rejection", () => {
  let harness: ITestWiki;
  let ws: IWorkspaceHandle;
  let doc: PageId;

  beforeAll(async () => {
    harness = await createTestWiki(documentPageTypes);
    ws = await harness.wiki.createWorkspace({ name: "Docs" });
    doc = (await ws.createPage("document", { title: "Runs", parentId: null })).value;
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("renders bold/italic/combined/link marks and code spans (golden)", async () => {
    await addBlockTo(ws, doc, "addParagraph", {
      inlines: [
        "plain ",
        { text: "bold", bold: true },
        " ",
        { text: "italic", italic: true },
        " ",
        { text: "both", bold: true, italic: true },
        " ",
        { code: "x.y()" },
        " ",
        { text: "site", href: "https://example.com" },
        " ",
        { text: "bold link", bold: true, href: "https://example.com/b" },
        ".",
      ],
    });
    expect(await bodyOf(ws, doc)).toBe(
      "plain **bold** _italic_ **_both_** `x.y()` [site](https://example.com) [**bold link**](https://example.com/b).",
    );
  });

  it("merges adjacent equal-mark runs at ingestion (canonical form in folded state)", async () => {
    const id = await addBlockTo(ws, doc, "addParagraph", { inlines: ["ab", "c", { text: "d", bold: true }] });
    const blk = blocksField(await (await ws.page(doc)).state()).blocks.find((b) => String(b.id) === id);
    if (blk === undefined || blk.kind !== "paragraph") throw new Error("not a paragraph");
    expect(blk.inlines).toHaveLength(2);
    expect(blk.inlines[0]).toEqual({ kind: "text", value: "abc", marks: [] });
    expect(await bodyOf(ws, doc)).toContain("abc**d**");
  });

  it("rejects Markdown syntax inside a text run — structure must be reified as runs", async () => {
    const before = await ws.toMarkdown(doc);
    await expect(ws.mutate(doc, "addParagraph", { inlines: ["**bold**"] })).rejects.toThrow(/Markdown syntax/);
    await expect(ws.mutate(doc, "addParagraph", { inlines: [{ text: "_x_", italic: true }] })).rejects.toThrow();
    expect(await ws.toMarkdown(doc)).toBe(before);
  });
});

describe("document: lists, quotes, tables, dividers", () => {
  let harness: ITestWiki;
  let ws: IWorkspaceHandle;

  async function newDoc(title: string): Promise<PageId> {
    return (await ws.createPage("document", { title, parentId: null })).value;
  }

  beforeAll(async () => {
    harness = await createTestWiki(documentPageTypes);
    ws = await harness.wiki.createWorkspace({ name: "Docs" });
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("addList renders unordered bullets and ordered numbering with marked items (golden)", async () => {
    const doc = await newDoc("Lists");
    await addBlockTo(ws, doc, "addList", {
      ordered: false,
      items: [["one"], [{ text: "two", bold: true }], ["three ", { code: "z" }]],
    });
    await addBlockTo(ws, doc, "addList", { ordered: true, items: [["first"], ["second"]] });
    expect(await bodyOf(ws, doc)).toBe(["- one\n- **two**\n- three `z`", "1. first\n2. second"].join("\n\n"));
  });

  it("addQuote renders multi-paragraph block quotes (golden)", async () => {
    const doc = await newDoc("Quotes");
    await addBlockTo(ws, doc, "addQuote", { paragraphs: [["A quote."], [{ text: "Second", italic: true }, " para."]] });
    expect(await bodyOf(ws, doc)).toBe("> A quote.\n>\n> _Second_ para.");
  });

  it("addTable renders header, alignment row, and cells — including empty cells (golden)", async () => {
    const doc = await newDoc("Tables");
    await addBlockTo(ws, doc, "addTable", {
      header: [["Name"], ["Value"]],
      rows: [
        [["a"], [{ code: "1" }]],
        [[{ text: "b", italic: true }], []],
      ],
      align: ["left", "right"],
    });
    expect(await bodyOf(ws, doc)).toBe(
      ["| Name | Value |", "| :--- | ---: |", "| a | `1` |", "| _b_ |  |"].join("\n"),
    );
  });

  it("addDivider renders a horizontal rule between blocks (golden)", async () => {
    const doc = await newDoc("Dividers");
    await addBlockTo(ws, doc, "addParagraph", { inlines: ["above"] });
    await addBlockTo(ws, doc, "addDivider", {});
    await addBlockTo(ws, doc, "addParagraph", { inlines: ["below"] });
    expect(await bodyOf(ws, doc)).toBe("above\n\n---\n\nbelow");
  });

  it("rejects a malformed table — align width mismatch, non-rectangular rows — leaving state unchanged", async () => {
    const doc = await newDoc("Bad tables");
    const before = await ws.toMarkdown(doc);
    await expect(
      ws.mutate(doc, "addTable", { header: [["A"], ["B"]], rows: [], align: ["left"] }),
    ).rejects.toThrow(/align/);
    await expect(
      ws.mutate(doc, "addTable", { header: [["A"], ["B"]], rows: [[["only one cell"]]] }),
    ).rejects.toThrow(/rectangular/);
    expect(await ws.toMarkdown(doc)).toBe(before);
  });

  it("a dangling {ref} inside a list item or table cell aborts the commit (deep integrity walk)", async () => {
    const doc = await newDoc("Deep refs");
    const before = await ws.toMarkdown(doc);
    await expect(
      ws.mutate(doc, "addList", { ordered: false, items: [[{ ref: "document:does-not-exist" }]] }),
    ).rejects.toThrow();
    await expect(
      ws.mutate(doc, "addTable", { header: [[{ ref: "document:does-not-exist" }]], rows: [] }),
    ).rejects.toThrow();
    expect(await ws.toMarkdown(doc)).toBe(before);
  });

  it("set* commands replace in place (ids stable) and render the new content (golden)", async () => {
    const doc = await newDoc("Edits");
    const h = await addBlockTo(ws, doc, "addHeading", { level: 2, inlines: ["Old"] });
    const l = await addBlockTo(ws, doc, "addList", { ordered: false, items: [["a"]] });
    const q = await addBlockTo(ws, doc, "addQuote", { paragraphs: [["old quote"]] });
    const t = await addBlockTo(ws, doc, "addTable", { header: [["H"]], rows: [] });

    await ws.mutate(doc, "setHeading", { blockId: h, level: 3, inlines: ["New ", { text: "title", bold: true }] });
    await ws.mutate(doc, "setList", { blockId: l, ordered: true, items: [["x"], ["y"]] });
    await ws.mutate(doc, "setQuote", { blockId: q, paragraphs: [["new quote"]] });
    await ws.mutate(doc, "setTable", { blockId: t, header: [["H"]], rows: [[["v"]]], align: ["center"] });

    expect(await bodyOf(ws, doc)).toBe(
      ["### New **title**", "1. x\n2. y", "> new quote", "| H |\n| :---: |\n| v |"].join("\n\n"),
    );
    const ids = blocksField(await (await ws.page(doc)).state()).blocks.map((b) => String(b.id));
    expect(ids).toEqual([h, l, q, t]); // edited in place — ids and order stable
  });

  it("each set* rejects a wrong-kind target instead of silently converting it", async () => {
    const doc = await newDoc("Guards");
    const p = await addBlockTo(ws, doc, "addParagraph", { inlines: ["a paragraph"] });
    const h = await addBlockTo(ws, doc, "addHeading", { level: 2, inlines: ["a heading"] });
    const before = await ws.toMarkdown(doc);
    await expect(ws.mutate(doc, "setHeading", { blockId: p, level: 2, inlines: ["x"] })).rejects.toThrow(
      /only edits heading/,
    );
    await expect(ws.mutate(doc, "setList", { blockId: h, ordered: false, items: [["x"]] })).rejects.toThrow(
      /only edits list/,
    );
    await expect(ws.mutate(doc, "setQuote", { blockId: p, paragraphs: [["x"]] })).rejects.toThrow(/only edits quote/);
    await expect(ws.mutate(doc, "setTable", { blockId: h, header: [["x"]], rows: [] })).rejects.toThrow(
      /only edits table/,
    );
    expect(await ws.toMarkdown(doc)).toBe(before);
  });
});

describe("document: determinism across instances", () => {
  it("the identical command sequence under injected ids renders byte-identical Markdown", async () => {
    const run = async (): Promise<string> => {
      const harness = await createTestWiki(documentPageTypes);
      try {
        const ws = await harness.wiki.createWorkspace({ name: "Docs" });
        const doc = (await ws.createPage("document", { title: "Twin", parentId: null })).value;
        await ws.mutate(doc, "addHeading", { level: 2, inlines: ["A"] });
        await ws.mutate(doc, "addParagraph", { inlines: [{ text: "B", bold: true }, "."] });
        await ws.mutate(doc, "addList", { ordered: true, items: [["one"], ["two"]] });
        await ws.mutate(doc, "addCode", { language: "ts", source: "const c = 3;" });
        return await ws.toMarkdown(doc);
      } finally {
        await harness.stop();
      }
    };
    const [first, second] = await Promise.all([run(), run()]);
    expect(first).toBe(second);
  });
});
