/**
 * `@children-content` — a page that shows what is IN its children, not just their names.
 *
 * The `toc` type carries both modes over the same children and a stored scalar picks one,
 * so a person toggles an index into a feed without changing the page's type or its tree.
 * Exercises the mode switch (including the unset default), newest-first `createdAt`
 * ordering, heading demotion, archived children dropping out, and the depth guard that
 * stops a feed of feeds recursing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import documentPageTypes from "wiki-models/document";
import tocPageTypes from "wiki-models/toc";
import type { IWiki, IWorkspaceHandle, PageId } from "../src/api";
import { createTestWiki, type ITestWiki } from "../src/testing";

function block(md: string, heading: string): string {
  const start = md.indexOf(`## ${heading}\n`);
  if (start < 0) return "";
  const after = md.slice(start + `## ${heading}\n`.length);
  const end = after.indexOf("\n## ");
  return (end < 0 ? after : after.slice(0, end)).trimEnd();
}

describe("toc: inline child content", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;
  let clock = "2024-01-01T00:00:00.000Z";

  beforeAll(async () => {
    harness = await createTestWiki([...tocPageTypes, ...documentPageTypes], { clock: () => clock });
    wiki = harness.wiki;
    ws = await wiki.createWorkspace({ name: "Feed" });
  });

  afterAll(async () => {
    await harness.stop();
  });

  /** A document child created at `at`, carrying one paragraph of body text. */
  async function child(parent: PageId, title: string, at: string, text: string): Promise<PageId> {
    clock = at;
    const id = (await ws.createPage("document", { title, parentId: parent })).value;
    await ws.mutate(id, "addParagraph", { inlines: [text] });
    return id;
  }

  it("defaults to the curated LINK list when the mode was never set", async () => {
    const toc = (await ws.createPage("toc", { title: "Index", parentId: null })).value;
    await child(toc, "First note", "2024-02-01T00:00:00.000Z", "alpha content");

    const contents = block(await ws.toMarkdown(toc), "Contents");
    // A link, not the child's body.
    expect(contents).toContain("[First note]");
    expect(contents).not.toContain("alpha content");
  });

  it("inlines each child's full content, newest first, once switched to inline", async () => {
    const toc = (await ws.createPage("toc", { title: "Journal", parentId: null })).value;
    await child(toc, "Oldest", "2024-03-01T00:00:00.000Z", "oldest body");
    await child(toc, "Middle", "2024-04-01T00:00:00.000Z", "middle body");
    await child(toc, "Newest", "2024-05-01T00:00:00.000Z", "newest body");

    await ws.mutate(toc, "setContentsMode", { mode: "inline" });
    const contents = block(await ws.toMarkdown(toc), "Contents");

    // Bodies are present, not just titles.
    expect(contents).toContain("oldest body");
    expect(contents).toContain("newest body");
    // Newest first, by createdAt.
    const order = ["Newest", "Middle", "Oldest"].map((t) => contents.indexOf(t));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeGreaterThanOrEqual(0);
  });

  it("demotes an inlined child's headings so its title sits under the section", async () => {
    const toc = (await ws.createPage("toc", { title: "Demote", parentId: null })).value;
    clock = "2024-06-01T00:00:00.000Z";
    const note = (await ws.createPage("document", { title: "A note", parentId: toc })).value;
    await ws.mutate(note, "addHeading", { level: 2, inlines: ["Inner heading"] });
    await ws.mutate(note, "addParagraph", { inlines: ["body"] });
    await ws.mutate(toc, "setContentsMode", { mode: "inline" });

    const contents = block(await ws.toMarkdown(toc), "Contents");
    // The child's own `# A note` became `### A note` — never a competing H1.
    expect(contents).toContain("### A note");
    expect(contents).not.toMatch(/^# A note$/m);
    // And its inner H2 moved down with it rather than colliding with the parent's H2s.
    expect(contents).toContain("#### Inner heading");
  });

  it("leaves a `#` inside fenced code alone when demoting", async () => {
    const toc = (await ws.createPage("toc", { title: "Fenced", parentId: null })).value;
    clock = "2024-07-01T00:00:00.000Z";
    const note = (await ws.createPage("document", { title: "Code note", parentId: toc })).value;
    await ws.mutate(note, "addCode", { language: "sh", source: "# not a heading\necho hi" });
    await ws.mutate(toc, "setContentsMode", { mode: "inline" });

    expect(block(await ws.toMarkdown(toc), "Contents")).toContain("# not a heading");
  });

  it("omits an archived child from the feed", async () => {
    const toc = (await ws.createPage("toc", { title: "Archiving", parentId: null })).value;
    await child(toc, "Kept", "2024-08-01T00:00:00.000Z", "kept body");
    const gone = await child(toc, "Dropped", "2024-08-02T00:00:00.000Z", "dropped body");
    await ws.mutate(toc, "setContentsMode", { mode: "inline" });

    expect(block(await ws.toMarkdown(toc), "Contents")).toContain("kept body");
    await ws.archivePage(gone);
    expect(block(await ws.toMarkdown(toc), "Contents")).not.toContain("dropped body");
  });

  it("switches back to links, restoring the curated index", async () => {
    const toc = (await ws.createPage("toc", { title: "Back and forth", parentId: null })).value;
    await child(toc, "Some note", "2024-09-01T00:00:00.000Z", "visible body");

    await ws.mutate(toc, "setContentsMode", { mode: "inline" });
    expect(block(await ws.toMarkdown(toc), "Contents")).toContain("visible body");

    await ws.mutate(toc, "setContentsMode", { mode: "links" });
    const links = block(await ws.toMarkdown(toc), "Contents");
    expect(links).toContain("[Some note]");
    expect(links).not.toContain("visible body");
  });

  it("stops recursing at the depth guard — a feed of feeds of feeds degrades to links", async () => {
    const outer = (await ws.createPage("toc", { title: "Outer", parentId: null })).value;
    clock = "2024-10-01T00:00:00.000Z";
    const mid = (await ws.createPage("toc", { title: "Mid", parentId: outer })).value;
    clock = "2024-10-02T00:00:00.000Z";
    const inner = (await ws.createPage("toc", { title: "Inner", parentId: mid })).value;
    await child(inner, "Deep note", "2024-10-03T00:00:00.000Z", "deep body");
    for (const t of [outer, mid, inner]) await ws.mutate(t, "setContentsMode", { mode: "inline" });

    // Renders, terminates, and shows the intermediate levels.
    const md = await ws.toMarkdown(outer);
    expect(md).toContain("Mid");
    expect(md).toContain("Inner");
    // Past the guard the deepest level is a link list, so its body is not inlined here.
    expect(md).not.toContain("deep body");
    // …but that same page still inlines its own child when rendered directly.
    expect(await ws.toMarkdown(inner)).toContain("deep body");
  });

  it("drops the chrome an inlined child does not need — status, empty sections, lone heading", async () => {
    const toc = (await ws.createPage("toc", { title: "Chrome", parentId: null })).value;
    await child(toc, "An entry", "2024-12-01T00:00:00.000Z", "the body");
    await ws.mutate(toc, "setContentsMode", { mode: "inline" });

    const contents = block(await ws.toMarkdown(toc), "Contents");
    expect(contents).toContain("the body");
    // No per-entry status badge — a feed of hundreds would repeat it hundreds of times.
    expect(contents).not.toContain("**Status:**");
    // No empty References / Child pages sections.
    expect(contents).not.toContain("References");
    expect(contents).not.toContain("Child pages");
    // A document's whole content is one section, and the entry's own title already heads
    // it, so that section's heading is noise too.
    expect(contents).not.toContain("Body");
  });

  it("still shows that chrome when the child is opened on its own", async () => {
    const toc = (await ws.createPage("toc", { title: "Own page", parentId: null })).value;
    const entry = await child(toc, "Standalone", "2024-12-03T00:00:00.000Z", "its body");
    await ws.mutate(toc, "setContentsMode", { mode: "inline" });

    // Suppression is a property of being INLINED, not of the page.
    const own = await ws.toMarkdown(entry);
    expect(own).toContain("**Status:**");
    expect(own).toContain("## Body");
    expect(own).toContain("its body");
  });

  it("keeps a body's own blank lines when it strips the section heading", async () => {
    const toc = (await ws.createPage("toc", { title: "Blank lines", parentId: null })).value;
    clock = "2024-12-02T00:00:00.000Z";
    const note = (await ws.createPage("document", { title: "Two paragraphs", parentId: toc })).value;
    await ws.mutate(note, "addParagraph", { inlines: ["first para"] });
    await ws.mutate(note, "addParagraph", { inlines: ["second para"] });
    await ws.mutate(toc, "setContentsMode", { mode: "inline" });

    // The heading/body split is the FIRST newline, not the first blank line — splitting on
    // the blank line would swallow everything before it.
    const contents = block(await ws.toMarkdown(toc), "Contents");
    expect(contents).toContain("first para");
    expect(contents).toContain("second para");
  });

  it("renders byte-identically for equal state", async () => {
    const mk = async (title: string): Promise<PageId> => {
      const t = (await ws.createPage("toc", { title, parentId: null })).value;
      await child(t, `${title} child`, "2024-11-01T00:00:00.000Z", "same body");
      await ws.mutate(t, "setContentsMode", { mode: "inline" });
      return t;
    };
    const a = (await ws.toMarkdown(await mk("Det A"))).replaceAll("Det A", "X");
    const b = (await ws.toMarkdown(await mk("Det B"))).replaceAll("Det B", "X");
    expect(a).toBe(b);
  });
});
