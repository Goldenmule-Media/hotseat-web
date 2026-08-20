/**
 * The `article-notes` bundle end to end: authoring the source, notes and summary,
 * the deterministic Markdown, and the `summarize` gate.
 *
 * The gate is the point of the type. It is DECLARATIVE — `requiredIn: ["summarized"]`
 * on the link, the date and the summary — so the test asserts not just that summarize
 * is refused, but that the refusal names what is missing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IWorkspaceHandle, PageId } from "../src/api";
import articlePageTypes, { ArticleNotes } from "wiki-models/article";
import { createTestWiki, type ITestWiki } from "../src/testing";

const LINK = "https://example.com/an-article";
const DATE = "2026-08-19";
const REF = `attachment:${"a".repeat(64)}`;

describe("article-notes: bundle contract", () => {
  it("default-exports exactly one page type, with a two-state human-gated FSM", () => {
    expect(articlePageTypes).toHaveLength(1);
    expect(articlePageTypes[0]).toBe(ArticleNotes);
    const def = ArticleNotes.__def;
    expect(def.type).toBe("article-notes");
    expect(def.initialStatus).toBe("reading");
    // Both edges are human gates: nothing here is an agent's to drive.
    expect(def.statusTransitions.map((t) => [t.fromState, t.event, t.toState, t.meta?.agency])).toEqual([
      ["reading", "summarize", "summarized", "human"],
      ["summarized", "reopen", "reading", "human"],
    ]);
  });
});

describe("article-notes: authoring and render", () => {
  let harness: ITestWiki;
  let ws: IWorkspaceHandle;

  beforeAll(async () => {
    harness = await createTestWiki(articlePageTypes);
    ws = await harness.wiki.createWorkspace({ name: "Reading" });
  });
  afterAll(async () => harness.stop());

  let seq = 0;
  const newPage = async (): Promise<PageId> =>
    (await ws.createPage("article-notes", { title: `The Shape of Data ${seq++}`, parentId: null })).value;

  it("renders placeholders on a fresh page, titled by the article's own title", async () => {
    const md = await ws.toMarkdown(await newPage());
    expect(md).toContain("# The Shape of Data 0");
    expect(md).toContain("_No source recorded._");
    expect(md).toContain("_No notes yet._");
    expect(md).toContain("_Not summarized yet._");
  });

  it("captures a source, notes (Markdown and images) and a summary, then summarizes", async () => {
    const page = await newPage();
    await ws.mutate(page, "setLink", { link: LINK });
    await ws.mutate(page, "setDate", { date: DATE });
    await ws.mutate(page, "addNote", { markdown: "The premise is that shape precedes meaning." });
    await ws.mutate(page, "addNote", { markdown: `![Figure 2](${REF})` });
    await ws.mutate(page, "addNote", { markdown: "> A quote worth keeping.\n\nAnd a reaction to it." });
    await ws.mutate(page, "writeSummary", { markdown: "Worth rereading. The middle third is the argument." });
    await ws.mutate(page, "summarize", {});

    const md = await ws.toMarkdown(page);
    expect(md).toContain(`**Link:** ${LINK}`);
    expect(md).toContain(`**Date:** ${DATE}`);
    expect(md).toContain("Worth rereading.");
    // Notes stack as top-level blocks: no synthesized heading, no ordinal, and the
    // image ref survives verbatim for a consumer to resolve.
    expect(md).toContain("The premise is that shape precedes meaning.");
    expect(md).toContain(`![Figure 2](${REF})`);
    expect(md).toContain("> A quote worth keeping.");
    expect(md).not.toMatch(/^###\s+1\./m);
    expect(md).not.toMatch(/[ \t]+$/m);
    expect(await (await ws.page(page)).status()).toBe("summarized");
  });

  it("refuses summarize while the link, date or summary is unauthored, naming what is missing", async () => {
    const page = await newPage();
    await expect(ws.mutate(page, "summarize", {})).rejects.toThrow(/source\.link|source\.date|summary\.body/);

    await ws.mutate(page, "setLink", { link: LINK });
    await ws.mutate(page, "setDate", { date: DATE });
    // Everything but the summary — still refused, and the reason now names only it.
    await expect(ws.mutate(page, "summarize", {})).rejects.toThrow(/summary\.body/);

    await ws.mutate(page, "writeSummary", { markdown: "Read it." });
    await expect(ws.mutate(page, "summarize", {})).resolves.toBeDefined();
  });

  it("validates the date and the link at the schema, not by convention", async () => {
    const page = await newPage();
    await expect(ws.mutate(page, "setDate", { date: "19 August 2026" })).rejects.toBeDefined();
    await expect(ws.mutate(page, "setLink", { link: "not a url" })).rejects.toBeDefined();
  });

  it("reorders, revises and removes notes, and reopens for more", async () => {
    const page = await newPage();
    const first = ((await ws.mutate(page, "addNote", { markdown: "First." })).value as { noteId: string }).noteId;
    await ws.mutate(page, "addNote", { markdown: "Second." });
    const third = ((await ws.mutate(page, "addNote", { markdown: "Third." })).value as { noteId: string }).noteId;

    await ws.mutate(page, "moveNote", { noteId: third, toIndex: 0 });
    await ws.mutate(page, "reviseNote", { noteId: first, markdown: "First, revised." });
    const md = await ws.toMarkdown(page);
    expect(md.indexOf("Third.")).toBeLessThan(md.indexOf("First, revised."));

    await ws.mutate(page, "removeNote", { noteId: third });
    expect(await ws.toMarkdown(page)).not.toContain("Third.");

    await expect(ws.mutate(page, "moveNote", { noteId: first, toIndex: 99 })).rejects.toThrow(/past the last note/);
    await expect(ws.mutate(page, "reviseNote", { noteId: "nope", markdown: "x" })).rejects.toThrow(/not found/);
  });

  it("closes notes to writing once summarized, and reopens them", async () => {
    const page = await newPage();
    await ws.mutate(page, "setLink", { link: LINK });
    await ws.mutate(page, "setDate", { date: DATE });
    await ws.mutate(page, "writeSummary", { markdown: "Done." });
    await ws.mutate(page, "summarize", {});

    // notes.mutableIn is ["reading"] only: a summarized page's notes are settled.
    await expect(ws.mutate(page, "addNote", { markdown: "Late thought." })).rejects.toBeDefined();
    await ws.mutate(page, "reopen", {});
    await expect(ws.mutate(page, "addNote", { markdown: "Late thought." })).resolves.toBeDefined();
  });

  it("renders byte-identically from equal content", async () => {
    // Two pages differ only by the title the engine forces to be unique, so equal
    // content must produce identical bytes everywhere below the H1.
    const build = async (title: string): Promise<string> => {
      const page = (await ws.createPage("article-notes", { title, parentId: null })).value;
      await ws.mutate(page, "setLink", { link: LINK });
      await ws.mutate(page, "setDate", { date: DATE });
      await ws.mutate(page, "addNote", { markdown: `![Fig](${REF})` });
      await ws.mutate(page, "writeSummary", { markdown: "Same." });
      const md = await ws.toMarkdown(page);
      return md.slice(md.indexOf("\n"));
    };
    expect(await build("Stable One")).toBe(await build("Stable Two"));
  });
});
