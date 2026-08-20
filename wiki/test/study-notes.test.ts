/**
 * Integration test for the real `study-notes` bundle (wiki-models/study): a reading-notes
 * outline (subtree-aware structure ops) plus a glossary whose terms are marked, defined in
 * the human's own words, and evaluated by a critic (`recordEvaluation`). Exercises the
 * alphabetical-by-construction glossary and its duplicate guard, the term FSM and its
 * write-gate (a checked term must redefine before content changes), stale-verdict
 * clearing, the finish gate, attention surfacing, and deterministic render.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { studyPageTypes } from "wiki-models/study";
import type { DeepReadonly, IItem, IWorkspaceHandle, PageId, PageState } from "../src/api";
import { InvariantViolationError, PreconditionUnmetError } from "../src/core/errors";
import { createTestWiki, type ITestWiki } from "../src/testing";

function els(state: DeepReadonly<PageState>, sectionKey: string, fieldKey: string): readonly DeepReadonly<IItem>[] {
  const f = state.sections.find((s) => s.key === sectionKey)?.fields[fieldKey];
  return f !== undefined && f.kind === "list" ? f.elements : [];
}

function titleOf(el: DeepReadonly<IItem>): string {
  const f = el.fields["title"];
  return f !== undefined && f.kind === "prose" ? f.value : "";
}

function scalarOf(el: DeepReadonly<IItem>, field: string): string {
  const f = el.fields[field];
  return f !== undefined && f.kind === "scalar" ? String(f.value) : "";
}

const depthOf = (el: DeepReadonly<IItem>): number => Number(scalarOf(el, "depth") || 0);

function blocksLen(el: DeepReadonly<IItem>, field: string): number {
  const f = el.fields[field];
  return f !== undefined && f.kind === "blocks" ? f.blocks.length : 0;
}

describe("study-notes model", () => {
  let harness: ITestWiki;
  let ws: IWorkspaceHandle;

  beforeAll(async () => {
    harness = await createTestWiki([...studyPageTypes]);
    ws = await harness.wiki.createWorkspace({ name: "Study" });
  });

  afterAll(async () => {
    await harness.stop();
  });

  async function stateOf(page: PageId): Promise<DeepReadonly<PageState>> {
    return (await ws.page(page)).state();
  }

  const notesOf = async (page: PageId): Promise<readonly DeepReadonly<IItem>[]> => els(await stateOf(page), "notes", "items");
  const termsOf = async (page: PageId): Promise<readonly DeepReadonly<IItem>[]> => els(await stateOf(page), "glossary", "terms");

  async function newPage(title: string): Promise<PageId> {
    return (await ws.createPage("study-notes", { title, parentId: null })).value;
  }

  async function capture(page: PageId, title: string, markdown: string, opts?: { afterId?: string; depth?: number }): Promise<string> {
    return ((await ws.mutate(page, "captureNote", { title, markdown, ...opts })).value as { noteId: string }).noteId;
  }

  async function mark(page: PageId, term: string, markdown?: string): Promise<string> {
    return ((await ws.mutate(page, "markTerm", { term, ...(markdown !== undefined ? { markdown } : {}) })).value as { termId: string }).termId;
  }

  it("is born capturing with empty notes and glossary", async () => {
    const page = await newPage("AI Engineering");
    const state = await stateOf(page);
    expect(state.status).toBe("capturing");
    expect(els(state, "notes", "items")).toHaveLength(0);
    expect(els(state, "glossary", "terms")).toHaveLength(0);
  });

  it("captures notes as an outline: afterId lands after the subtree, depth is validated", async () => {
    const page = await newPage("Outline");
    const a = await capture(page, "Transformers", "Attention is all you need.");
    const a1 = await capture(page, "Attention", "Q, K, V.", { afterId: a, depth: 1 });
    await capture(page, "Sampling", "Constructing outputs.", { afterId: a });

    const notes = await notesOf(page);
    expect(notes.map(titleOf)).toEqual(["Transformers", "Attention", "Sampling"]);
    expect(notes.map(depthOf)).toEqual([0, 1, 0]);

    // Depth may not skip a level.
    await expect(ws.mutate(page, "captureNote", { title: "Too deep", markdown: "x", afterId: a1, depth: 3 })).rejects.toThrow(
      InvariantViolationError,
    );
  });

  it("moves, indents, outdents and removes whole subtrees", async () => {
    const page = await newPage("Structure");
    const a = await capture(page, "A", "a");
    await capture(page, "A.1", "a1", { afterId: a, depth: 1 });
    const b = await capture(page, "B", "b");

    // Move B before A: subtree [A, A.1] stays together after it.
    await ws.mutate(page, "moveNote", { noteId: b, toIndex: 0 });
    expect((await notesOf(page)).map(titleOf)).toEqual(["B", "A", "A.1"]);

    // Indent A under B: A.1 travels, one level deeper.
    await ws.mutate(page, "indentNote", { noteId: a });
    expect((await notesOf(page)).map(depthOf)).toEqual([0, 1, 2]);

    await ws.mutate(page, "outdentNote", { noteId: a });
    expect((await notesOf(page)).map(depthOf)).toEqual([0, 0, 1]);
    await expect(ws.mutate(page, "outdentNote", { noteId: b })).rejects.toThrow(InvariantViolationError);

    // Removing A takes A.1 with it.
    await ws.mutate(page, "removeNote", { noteId: a });
    expect((await notesOf(page)).map(titleOf)).toEqual(["B"]);
  });

  it("keeps the glossary alphabetical by construction and refuses duplicates", async () => {
    const page = await newPage("Glossary order");
    await mark(page, "Temperature");
    await mark(page, "Embedding");
    await mark(page, "logit");

    expect((await termsOf(page)).map(titleOf)).toEqual(["Embedding", "logit", "Temperature"]);

    await expect(ws.mutate(page, "markTerm", { term: "  temperature " })).rejects.toThrow(/already in the glossary/);
  });

  it("walks the term FSM: marked → defined → checked, redefine clears the stale verdict", async () => {
    const page = await newPage("Term FSM");
    const id = await mark(page, "Entropy");
    expect((await termsOf(page))[0]!.status).toBe("marked");

    // Defining while marked is refused for evaluation, allowed for definition.
    await expect(ws.mutate(page, "recordEvaluation", { termId: id, grade: "understood", markdown: "x" })).rejects.toThrow(
      /evaluations run on a defined term/,
    );

    await ws.mutate(page, "defineTerm", { termId: id, markdown: "How much information a token carries, on average." });
    let el = (await termsOf(page))[0]!;
    expect(el.status).toBe("defined");

    await ws.mutate(page, "recordEvaluation", { termId: id, grade: "partial", markdown: "Misses the bits connection." });
    el = (await termsOf(page))[0]!;
    expect(el.status).toBe("checked");
    expect(scalarOf(el, "grade")).toBe("partial");
    expect(blocksLen(el, "feedback")).toBeGreaterThan(0);

    // A second evaluation without a redefine is refused — the verdict attests to this text.
    await expect(ws.mutate(page, "recordEvaluation", { termId: id, grade: "understood", markdown: "x" })).rejects.toThrow(
      /redefine it first/,
    );

    // Redefining honestly downgrades and clears the verdict.
    await ws.mutate(page, "defineTerm", { termId: id, markdown: "Average information per token; log2 gives bits." });
    el = (await termsOf(page))[0]!;
    expect(el.status).toBe("defined");
    expect(scalarOf(el, "grade")).toBe("");
    expect(blocksLen(el, "feedback")).toBe(0);
  });

  it("marks with an inline definition, renames into position, and unmarks", async () => {
    const page = await newPage("Term edits");
    const a = await mark(page, "Beta", "Defined at mark time.");
    await mark(page, "Alpha");
    expect((await termsOf(page)).map(titleOf)).toEqual(["Alpha", "Beta"]);
    expect((await termsOf(page))[1]!.status).toBe("defined");

    // Rename moves it to its new alphabetical slot; duplicates (case-insensitive) refused.
    await expect(ws.mutate(page, "renameTerm", { termId: a, term: "ALPHA" })).rejects.toThrow(/already in the glossary/);
    await ws.mutate(page, "renameTerm", { termId: a, term: "Zeta" });
    expect((await termsOf(page)).map(titleOf)).toEqual(["Alpha", "Zeta"]);

    await ws.mutate(page, "unmarkTerm", { termId: a });
    expect((await termsOf(page)).map(titleOf)).toEqual(["Alpha"]);
  });

  it("renaming a checked term returns it to defined and clears the verdict", async () => {
    const page = await newPage("Rename checked");
    const id = await mark(page, "Logit", "A raw pre-softmax score.");
    await ws.mutate(page, "recordEvaluation", { termId: id, grade: "understood", markdown: "Solid." });
    await ws.mutate(page, "renameTerm", { termId: id, term: "Logit vector" });
    const el = (await termsOf(page))[0]!;
    expect(el.status).toBe("defined");
    expect(scalarOf(el, "grade")).toBe("");
  });

  it("accepts a term only on the human's say-so, and reopens it with its verdict intact", async () => {
    const page = await newPage("Accept");
    const id = await mark(page, "Attention");
    // Accepting an undefined term is refused — there is nothing to understand yet.
    await expect(ws.mutate(page, "acceptTerm", { termId: id })).rejects.toThrow(/define it before accepting/);

    await ws.mutate(page, "defineTerm", { termId: id, markdown: "Weighing every token against every other." });
    await ws.mutate(page, "recordEvaluation", { termId: id, grade: "understood", markdown: "Right idea." });
    // The critic's verdict does NOT accept it: that stays the human's call.
    expect((await termsOf(page))[0]!.status).toBe("checked");

    await ws.mutate(page, "acceptTerm", { termId: id });
    let el = (await termsOf(page))[0]!;
    expect(el.status).toBe("accepted");
    expect(scalarOf(el, "grade")).toBe("understood");

    // Reopening keeps definition and verdict — neither changed.
    await ws.mutate(page, "reopenTerm", { termId: id });
    el = (await termsOf(page))[0]!;
    expect(el.status).toBe("defined");
    expect(scalarOf(el, "grade")).toBe("understood");
    await expect(ws.mutate(page, "reopenTerm", { termId: id })).rejects.toThrow(/only an accepted term reopens/);

    // Editing the text drops the now-stale verdict.
    await ws.mutate(page, "defineTerm", { termId: id, markdown: "Every token weighs every other token." });
    el = (await termsOf(page))[0]!;
    expect(el.status).toBe("defined");
    expect(scalarOf(el, "grade")).toBe("");
    expect(blocksLen(el, "feedback")).toBe(0);
  });

  it("accepts an unevaluated term, and an edit while accepted returns it to defined", async () => {
    const page = await newPage("Accept unevaluated");
    const id = await mark(page, "Softmax", "Turns scores into a distribution.");
    await ws.mutate(page, "acceptTerm", { termId: id });
    expect((await termsOf(page))[0]!.status).toBe("accepted");

    await ws.mutate(page, "defineTerm", { termId: id, markdown: "Exponentiate, then normalise." });
    expect((await termsOf(page))[0]!.status).toBe("defined");
  });

  it("gates finish on every term being defined, and reopens", async () => {
    const page = await newPage("Finish gate");
    await capture(page, "Notes", "Some notes.");
    await mark(page, "RAG");

    await expect(ws.mutate(page, "finish", {})).rejects.toThrow(PreconditionUnmetError);
    await expect(ws.mutate(page, "finish", {})).rejects.toThrow(/RAG/);

    const idRag = (await termsOf(page))[0]!.id;
    await ws.mutate(page, "defineTerm", { termId: idRag, markdown: "Retrieve context, then generate." });
    await ws.mutate(page, "finish", {});
    expect((await stateOf(page)).status).toBe("finished");

    // Finished pages are read-only until reopened.
    await expect(ws.mutate(page, "captureNote", { title: "X", markdown: "x" })).rejects.toThrow();
    await ws.mutate(page, "reopen", {});
    expect((await stateOf(page)).status).toBe("capturing");
  });

  it("surfaces marked terms as attention items", async () => {
    const page = await newPage("Attention");
    const id = await mark(page, "Perplexity");
    const view = await ws.page(page);
    const items = await view.attentionItems();
    expect(items.some((i) => i.elementId === id && i.status === "marked")).toBe(true);

    // Defining it is not the end of it — the term waits for the human to accept it.
    await ws.mutate(page, "defineTerm", { termId: id, markdown: "The exponential of cross entropy." });
    expect((await (await ws.page(page)).attentionItems()).some((i) => i.elementId === id)).toBe(true);

    await ws.mutate(page, "acceptTerm", { termId: id });
    expect((await (await ws.page(page)).attentionItems()).some((i) => i.elementId === id)).toBe(false);
  });

  it("renders deterministic Markdown: notes as a heading hierarchy, glossary alphabetical with critique", async () => {
    const page = await newPage("Render");
    const a = await capture(page, "Transformers", "Blocks all the way down.");
    await capture(page, "Attention", "Q, K, V.", { afterId: a, depth: 1 });
    const id = await mark(page, "Attention mechanism", "Weighs input tokens per output token.");
    await ws.mutate(page, "recordEvaluation", { termId: id, grade: "understood", markdown: "The mechanism is theirs." });
    await mark(page, "Dot product");

    const md = await (await ws.page(page)).toMarkdown();
    const again = await (await ws.page(page)).toMarkdown();
    expect(again).toBe(md);

    expect(md).toContain("# Render");
    expect(md).toContain("## Notes");
    expect(md).toContain("### Transformers");
    expect(md).toContain("#### Attention");
    expect(md).toContain("## Glossary");
    expect(md).toContain("### Attention mechanism");
    expect(md).toContain("Weighs input tokens per output token.");
    expect(md).toContain("**Critique:**");
    expect(md.indexOf("### Attention mechanism")).toBeLessThan(md.indexOf("### Dot product"));
  });
});
