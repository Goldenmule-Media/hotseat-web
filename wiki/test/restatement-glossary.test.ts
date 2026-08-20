/**
 * Integration test for the real `restatement-glossary` bundle
 * (wiki-models/restatement-glossary): a STANDALONE glossary — no notes, no source text.
 * It shares one implementation with `study-notes` (wiki-models/src/shared/glossary.ts), so
 * this covers the loop end to end on the new page FSM (`collecting` → `finished`) and
 * pins the coupling both studios rely on: the two types expose the same glossary command
 * names over the same `glossary.terms` keys.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { restatementGlossaryPageTypes } from "wiki-models/restatement-glossary";
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

function blocksLen(el: DeepReadonly<IItem>, field: string): number {
  const f = el.fields[field];
  return f !== undefined && f.kind === "blocks" ? f.blocks.length : 0;
}

describe("restatement-glossary model", () => {
  let harness: ITestWiki;
  let ws: IWorkspaceHandle;

  beforeAll(async () => {
    harness = await createTestWiki([...restatementGlossaryPageTypes]);
    ws = await harness.wiki.createWorkspace({ name: "Glossary" });
  });

  afterAll(async () => {
    await harness.stop();
  });

  async function stateOf(page: PageId): Promise<DeepReadonly<PageState>> {
    return (await ws.page(page)).state();
  }

  const termsOf = async (page: PageId): Promise<readonly DeepReadonly<IItem>[]> => els(await stateOf(page), "glossary", "terms");

  async function newPage(title: string): Promise<PageId> {
    return (await ws.createPage("restatement-glossary", { title, parentId: null })).value;
  }

  async function mark(page: PageId, term: string, markdown?: string): Promise<string> {
    return ((await ws.mutate(page, "markTerm", { term, ...(markdown !== undefined ? { markdown } : {}) })).value as { termId: string })
      .termId;
  }

  it("is born collecting with an empty glossary and no notes section", async () => {
    const page = await newPage("Distributed systems");
    const state = await stateOf(page);
    expect(state.status).toBe("collecting");
    expect(els(state, "glossary", "terms")).toHaveLength(0);
    expect(state.sections.map((s) => s.key)).toEqual(["glossary"]);
  });

  it("keeps terms alphabetical by construction and refuses duplicates", async () => {
    const page = await newPage("Order");
    await mark(page, "Quorum");
    await mark(page, "Idempotence");
    await mark(page, "linearizability");

    expect((await termsOf(page)).map(titleOf)).toEqual(["Idempotence", "linearizability", "Quorum"]);
    await expect(ws.mutate(page, "markTerm", { term: "  quorum " })).rejects.toThrow(/already in the glossary/);
  });

  it("marks a term with its definition in one commit, born defined", async () => {
    const page = await newPage("Born defined");
    const id = await mark(page, "Lease", "A lock that expires on its own.");
    const el = (await termsOf(page))[0]!;
    expect(el.id).toBe(id);
    expect(el.status).toBe("defined");
  });

  it("walks the term FSM: marked → defined → checked, redefine clears the stale verdict", async () => {
    const page = await newPage("Term FSM");
    const id = await mark(page, "Consensus");
    expect((await termsOf(page))[0]!.status).toBe("marked");

    await expect(ws.mutate(page, "recordEvaluation", { termId: id, grade: "understood", markdown: "x" })).rejects.toThrow(
      /evaluations run on a defined term/,
    );

    await ws.mutate(page, "defineTerm", { termId: id, markdown: "Everyone agrees on one value, despite failures." });
    expect((await termsOf(page))[0]!.status).toBe("defined");

    await ws.mutate(page, "recordEvaluation", { termId: id, grade: "partial", markdown: "Misses the failure model." });
    let el = (await termsOf(page))[0]!;
    expect(el.status).toBe("checked");
    expect(scalarOf(el, "grade")).toBe("partial");
    expect(blocksLen(el, "feedback")).toBeGreaterThan(0);

    // A second verdict on a checked term is refused — it must redefine first.
    await expect(ws.mutate(page, "recordEvaluation", { termId: id, grade: "understood", markdown: "y" })).rejects.toThrow(
      /redefine it first/,
    );

    // Editing the definition downgrades it honestly and drops the stale verdict.
    await ws.mutate(page, "defineTerm", { termId: id, markdown: "Agreement on one value even when nodes crash." });
    el = (await termsOf(page))[0]!;
    expect(el.status).toBe("defined");
    expect(scalarOf(el, "grade")).toBe("");
    expect(blocksLen(el, "feedback")).toBe(0);
  });

  it("renames a term: it repositions and a checked term returns to defined", async () => {
    const page = await newPage("Rename");
    const id = await mark(page, "Zed", "The last one.");
    await mark(page, "Alpha", "The first one.");
    await ws.mutate(page, "recordEvaluation", { termId: id, grade: "understood", markdown: "Fine." });

    await ws.mutate(page, "renameTerm", { termId: id, term: "Aardvark" });
    const terms = await termsOf(page);
    expect(terms.map(titleOf)).toEqual(["Aardvark", "Alpha"]);
    expect(terms[0]!.status).toBe("defined");
    expect(scalarOf(terms[0]!, "grade")).toBe("");

    await expect(ws.mutate(page, "renameTerm", { termId: id, term: "alpha" })).rejects.toThrow(/already in the glossary/);
  });

  it("accepts a term and reopens it, and unmarks one", async () => {
    const page = await newPage("Accept");
    const id = await mark(page, "Backpressure", "Slowing the producer when the consumer lags.");
    await expect(ws.mutate(page, "reopenTerm", { termId: id })).rejects.toThrow(InvariantViolationError);

    await ws.mutate(page, "acceptTerm", { termId: id });
    expect((await termsOf(page))[0]!.status).toBe("accepted");

    await ws.mutate(page, "reopenTerm", { termId: id });
    expect((await termsOf(page))[0]!.status).toBe("defined");

    const bare = await mark(page, "Jitter");
    await expect(ws.mutate(page, "acceptTerm", { termId: bare })).rejects.toThrow(/define it before accepting it/);

    await ws.mutate(page, "unmarkTerm", { termId: bare });
    expect((await termsOf(page)).map(titleOf)).toEqual(["Backpressure"]);
  });

  it("gates finish on every term being defined, and reopens", async () => {
    const page = await newPage("Finish gate");
    await mark(page, "Sharding");

    await expect(ws.mutate(page, "finish", {})).rejects.toThrow(PreconditionUnmetError);
    await expect(ws.mutate(page, "finish", {})).rejects.toThrow(/Sharding/);

    const id = (await termsOf(page))[0]!.id;
    await ws.mutate(page, "defineTerm", { termId: id, markdown: "Splitting data across nodes by key." });
    await ws.mutate(page, "finish", {});
    expect((await stateOf(page)).status).toBe("finished");

    // A finished glossary is read-only until reopened.
    await expect(ws.mutate(page, "markTerm", { term: "Replication" })).rejects.toThrow();
    await ws.mutate(page, "reopen", {});
    expect((await stateOf(page)).status).toBe("collecting");
  });

  it("surfaces every unaccepted term as an attention item", async () => {
    const page = await newPage("Attention");
    const id = await mark(page, "Vector clock");
    const items = await (await ws.page(page)).attentionItems();
    expect(items.some((i) => i.elementId === id && i.status === "marked")).toBe(true);

    await ws.mutate(page, "defineTerm", { termId: id, markdown: "Per-node counters ordering events." });
    expect((await (await ws.page(page)).attentionItems()).some((i) => i.elementId === id)).toBe(true);

    await ws.mutate(page, "acceptTerm", { termId: id });
    expect((await (await ws.page(page)).attentionItems()).some((i) => i.elementId === id)).toBe(false);
  });

  it("renders deterministic Markdown: one Glossary section, alphabetical, with the critique", async () => {
    const page = await newPage("Render");
    const id = await mark(page, "Write-ahead log", "Record the intent before doing the work.");
    await ws.mutate(page, "recordEvaluation", { termId: id, grade: "understood", markdown: "The ordering is theirs." });
    await mark(page, "Anti-entropy");

    const md = await (await ws.page(page)).toMarkdown();
    expect(await (await ws.page(page)).toMarkdown()).toBe(md);

    expect(md).toContain("# Render");
    expect(md).toContain("## Glossary");
    expect(md).toContain("### Write-ahead log");
    expect(md).toContain("Record the intent before doing the work.");
    expect(md).toContain("**Critique:**");
    expect(md).not.toContain("## Notes");
    expect(md.indexOf("### Anti-entropy")).toBeLessThan(md.indexOf("### Write-ahead log"));
  });

  it("exposes the same glossary commands and keys as study-notes — the contract one studio drives", () => {
    const GLOSSARY_COMMANDS = ["markTerm", "defineTerm", "renameTerm", "unmarkTerm", "recordEvaluation", "acceptTerm", "reopenTerm"];
    const glossaryCommandsOf = (def: { commands: Record<string, unknown> }): string[] =>
      Object.keys(def.commands)
        .filter((c) => GLOSSARY_COMMANDS.includes(c))
        .sort();

    const study = studyPageTypes[0]!.__def;
    const glossary = restatementGlossaryPageTypes[0]!.__def;

    expect(glossaryCommandsOf(glossary)).toEqual([...GLOSSARY_COMMANDS].sort());
    expect(glossaryCommandsOf(glossary)).toEqual(glossaryCommandsOf(study));
    // Both drive `glossary.terms` with an identically-named element type.
    expect(Object.keys(glossary.sections["glossary"]!.fields)).toEqual(["terms"]);
    expect(glossary.elements?.["glossary-term"]).toBe(study.elements?.["glossary-term"]);
  });
});
