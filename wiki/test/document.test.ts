/**
 * `document` page type — a general-purpose, lifecycle-free document: the ENTIRE content
 * is one ordered `blocks` field (the first bundle to use blocks as the whole page).
 * Single `active` status, zero FSM transitions — always editable; structural archive
 * handles removal. Determinism: ids arrive via the injected deterministic `newId()`;
 * equal state must render byte-identical Markdown.
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
      for (const n of ["addParagraph", "addHeading", "addCode", "addPageRef", "addExternalLink", "setParagraph", "moveBlock", "removeBlock"]) {
        expect(names).toContain(n);
      }
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

  /** The rendered "## Body" block (title/status stripped, graph sections stripped). */
  async function body(): Promise<string> {
    const md = await ws.toMarkdown(doc);
    const start = md.indexOf("## Body\n");
    expect(start).toBeGreaterThanOrEqual(0);
    const tail = md.slice(start + "## Body\n".length);
    const end = tail.indexOf("\n## References");
    return (end >= 0 ? tail.slice(0, end) : tail).trimEnd();
  }

  async function addBlock(command: string, args: Record<string, unknown>): Promise<string> {
    return ((await ws.mutate(doc, command, args)).value as { blockId: string }).blockId;
  }

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
    await addBlock("addHeading", { level: 2, text: "Intro" });
    await addBlock("addParagraph", { text: "Hello world." });
    codeId = await addBlock("addCode", { language: "ts", source: "export const x = 1;" });
    await addBlock("addParagraph", { text: "Done." });
    expect(await body()).toBe(
      ["## Intro", "Hello world.", "```ts\nexport const x = 1;\n```", "Done."].join("\n\n"),
    );
  });

  it("inserts at an explicit index", async () => {
    prefaceId = await addBlock("addParagraph", { text: "Preface.", index: 0 });
    expect((await body()).startsWith("Preface.\n\n## Intro")).toBe(true);
  });

  it("moveBlock reorders and setParagraph replaces in place (same id)", async () => {
    await ws.mutate(doc, "moveBlock", { blockId: prefaceId, toIndex: 4 });
    await ws.mutate(doc, "setParagraph", { blockId: prefaceId, text: "The end." });
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

  it("addPageRef threads an integrity-checked ref (render-derived label); a dangling id aborts", async () => {
    const other = (await ws.createPage("document", { title: "Other notes", parentId: null })).value;
    await addBlock("addPageRef", { pageId: String(other), text: "See" });
    expect(await body()).toContain("See Other notes");
    // Renames reflow: the label is render-derived, not snapshotted.
    await ws.setPageTitle(other, "Other notes (renamed)");
    expect(await body()).toContain("See Other notes (renamed)");

    const before = await ws.toMarkdown(doc);
    await expect(ws.mutate(doc, "addPageRef", { pageId: "document:does-not-exist" })).rejects.toThrow();
    expect(await ws.toMarkdown(doc)).toBe(before);
  });

  it("addExternalLink renders a Markdown link from the link mark", async () => {
    await addBlock("addExternalLink", { href: "https://example.com/spec", text: "the upstream spec" });
    expect(await body()).toContain("[the upstream spec](https://example.com/spec)");
  });

  it("setParagraph rejects a non-paragraph target instead of silently converting it", async () => {
    const before = await ws.toMarkdown(doc);
    await expect(ws.mutate(doc, "setParagraph", { blockId: codeId, text: "oops" })).rejects.toThrow(/only edits paragraphs/);
    expect(await ws.toMarkdown(doc)).toBe(before); // the code block survives
  });

  it("rejects malformed args at the curated schema: empty text, fence-corrupting language", async () => {
    await expect(ws.mutate(doc, "addParagraph", { text: "" })).rejects.toThrow();
    // "```" + language renders verbatim into the fence line — whitespace/backticks are barred.
    await expect(ws.mutate(doc, "addCode", { language: "ts\n# pwned", source: "x" })).rejects.toThrow();
    await expect(ws.mutate(doc, "addCode", { language: "", source: "x" })).rejects.toThrow();
  });
});

describe("document: determinism across instances", () => {
  it("the identical command sequence under injected ids renders byte-identical Markdown", async () => {
    const run = async (): Promise<string> => {
      const harness = await createTestWiki(documentPageTypes);
      try {
        const ws = await harness.wiki.createWorkspace({ name: "Docs" });
        const doc = (await ws.createPage("document", { title: "Twin", parentId: null })).value;
        await ws.mutate(doc, "addHeading", { level: 2, text: "A" });
        await ws.mutate(doc, "addParagraph", { text: "B." });
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
