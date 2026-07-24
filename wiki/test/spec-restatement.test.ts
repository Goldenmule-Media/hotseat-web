/**
 * Integration test for the real `spec-restatement` bundle (wiki-models/spec-restatement):
 * an AI drafts ordered spec sections, a human proves understanding by RESTATING them
 * (atomic replace, born human-verified), a holistic AI review records notes, and a human
 * approve gate closes the loop. Exercises the element-status write-gate (`mutableIn`),
 * the empty-draft submit precondition, produces-emitted page transitions, positioning of
 * restated runs, attention/describeMutations surfacing, and deterministic render.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { specRestatementPageTypes } from "wiki-models/spec-restatement";
import type { DeepReadonly, IItem, IWorkspaceHandle, PageId, PageState } from "../src/api";
import { InvariantViolationError, MutationNotAllowedError, PreconditionUnmetError } from "../src/core/errors";
import { createTestWiki, type ITestWiki } from "../src/testing";

function els(state: DeepReadonly<PageState>, sectionKey: string, fieldKey: string): readonly DeepReadonly<IItem>[] {
  const f = state.sections.find((s) => s.key === sectionKey)?.fields[fieldKey];
  return f !== undefined && f.kind === "list" ? f.elements : [];
}

function titleOf(el: DeepReadonly<IItem>): string {
  const f = el.fields["title"];
  return f !== undefined && f.kind === "prose" ? f.value : "";
}

function proseOf(state: DeepReadonly<PageState>, sectionKey: string, fieldKey: string): string {
  const f = state.sections.find((s) => s.key === sectionKey)?.fields[fieldKey];
  return f !== undefined && f.kind === "prose" ? f.value : "";
}

describe("spec-restatement model", () => {
  let harness: ITestWiki;
  let ws: IWorkspaceHandle;

  beforeAll(async () => {
    harness = await createTestWiki([...specRestatementPageTypes]);
    ws = await harness.wiki.createWorkspace({ name: "Specs" });
  });

  afterAll(async () => {
    await harness.stop();
  });

  async function stateOf(page: PageId, token?: string): Promise<DeepReadonly<PageState>> {
    return (await ws.page(page, token !== undefined ? { consistentWith: token } : undefined)).state();
  }

  /** A page with drafted sections, submitted for restatement. */
  async function restatableSpec(title: string, sections: [string, string][]): Promise<{ page: PageId; ids: string[] }> {
    const page = (await ws.createPage("spec-restatement", { title, parentId: null })).value;
    const ids: string[] = [];
    for (const [t, md] of sections) {
      ids.push(((await ws.mutate(page, "draftSection", { title: t, markdown: md })).value as { sectionId: string }).sectionId);
    }
    await ws.mutate(page, "submitForRestatement", {});
    return { page, ids };
  }

  it("drives the full lifecycle: draft → restate → holistic review → fix loop → approve", async () => {
    const p = (await ws.createPage("spec-restatement", { title: "Search", parentId: null })).value;
    const s1 = ((await ws.mutate(p, "draftSection", { title: "Indexing", markdown: "AI: indexing." })).value as { sectionId: string }).sectionId;
    const s2 = ((await ws.mutate(p, "draftSection", { title: "Querying", markdown: "AI: querying." })).value as { sectionId: string }).sectionId;
    const s3 = ((await ws.mutate(p, "draftSection", { title: "Ranking", markdown: "AI: ranking." })).value as { sectionId: string }).sectionId;
    const sub = await ws.mutate(p, "submitForRestatement", {});
    expect((await stateOf(p, sub.token)).status).toBe("restating");

    // The human accepts ONE merged restatement of s1+s2: old ids vanish, the new element is
    // born human-verified and sits where the first removed element sat.
    const r1 = await ws.mutate(p, "restateSections", {
      removeIds: [s1, s2],
      sections: [{ title: "Indexing and querying", markdown: "In my words: one merged pass." }],
    });
    const items1 = els(await stateOf(p, r1.token), "sections", "items");
    expect(items1.map(titleOf)).toEqual(["Indexing and querying", "Ranking"]);
    expect(items1[0]!.status).toBe("human-verified");
    expect(items1.map((e) => e.id)).not.toContain(s1);
    expect(items1.map((e) => e.id)).not.toContain(s2);
    expect(items1[1]!.id).toBe(s3);

    await ws.mutate(p, "restateSections", { removeIds: [s3], sections: [{ title: "Ranking", markdown: "Ranking, restated." }] });

    // Holistic review: summary + open notes + the page transition land in ONE commit.
    const before = (await ws.history()).length;
    const rec = await ws.mutate(p, "recordHolisticReview", {
      summary: "Faithful; two gaps.",
      notes: [
        { title: "Missing failure modes", markdown: "What about a stale index?", severity: "major" },
        { title: "Terminology drift", markdown: "Sharding vs partitioning.", severity: "minor" },
      ],
    });
    expect((await ws.history({ consistentWith: rec.token })).length).toBe(before + 1);
    const state2 = await stateOf(p, rec.token);
    expect(state2.status).toBe("reviewing");
    expect(proseOf(state2, "review", "summary")).toBe("Faithful; two gaps.");
    const notes2 = els(state2, "review", "notes");
    expect(notes2.map((n) => n.status)).toEqual(["open", "open"]);
    const [n1, n2] = notes2.map((n) => n.id);

    // Fix loop while reviewing: resolve one note, restate the affected section again.
    await ws.mutate(p, "resolveNote", { noteId: n1! });
    const rankId = els(await stateOf(p), "sections", "items").find((e) => titleOf(e) === "Ranking")!.id;
    await ws.mutate(p, "restateSections", {
      removeIds: [rankId],
      sections: [{ title: "Ranking", markdown: "Ranking, with staleness handling." }],
    });

    // Second pass: still-open notes are replaced, the resolved one is kept as history.
    const rr = await ws.mutate(p, "rerunHolisticReview", {
      summary: "Second pass: solid.",
      notes: [{ title: "Staleness section unreferenced", markdown: "Link it from the overview.", severity: "minor" }],
    });
    const notes3 = els(await stateOf(p, rr.token), "review", "notes");
    expect(notes3.map((n) => n.id)).toContain(n1);
    expect(notes3.map((n) => n.id)).not.toContain(n2);
    const open3 = notes3.filter((n) => n.status === "open");
    expect(open3).toHaveLength(1);
    expect(titleOf(open3[0]!)).toBe("Staleness section unreferenced");

    // Resolve it with a recorded resolution, then the human approves.
    const res = await ws.mutate(p, "resolveNote", { noteId: open3[0]!.id, resolution: "Referenced from the overview." });
    const resolved = els(await stateOf(p, res.token), "review", "notes").find((n) => n.id === open3[0]!.id)!;
    expect(resolved.status).toBe("resolved");
    const resolution = resolved.fields["resolution"];
    expect(resolution !== undefined && resolution.kind === "prose" ? resolution.value : "").toBe("Referenced from the overview.");
    const ok = await ws.mutate(p, "approve", {});
    expect((await stateOf(p, ok.token)).status).toBe("approved");
  });

  it("refuses submitForRestatement while no sections are drafted (empty-draft precondition)", async () => {
    const p = (await ws.createPage("spec-restatement", { title: "Empty draft", parentId: null })).value;
    const attempt = ws.mutate(p, "submitForRestatement", {});
    await expect(attempt).rejects.toThrow(PreconditionUnmetError);
    await expect(attempt).rejects.toThrow(/draft at least one section/);
    await ws.mutate(p, "draftSection", { title: "Only section", markdown: "Body." });
    await ws.mutate(p, "submitForRestatement", {});
    expect((await stateOf(p)).status).toBe("restating");
  });

  it("refuses recordHolisticReview while any section is ai-draft, naming the offending titles", async () => {
    const { page } = await restatableSpec("Unverified", [["Alpha", "A."], ["Beta", "B."]]);
    const attempt = ws.mutate(page, "recordHolisticReview", { summary: "Too soon.", notes: [] });
    await expect(attempt).rejects.toThrow(PreconditionUnmetError);
    await expect(attempt).rejects.toThrow(/Alpha, Beta/);
  });

  it("refuses approve while review notes are open, naming their titles", async () => {
    const { page, ids } = await restatableSpec("Open notes", [["Gamma", "G."]]);
    await ws.mutate(page, "restateSections", { removeIds: [ids[0]!], sections: [{ title: "Gamma", markdown: "Restated." }] });
    await ws.mutate(page, "recordHolisticReview", {
      summary: "One gap.",
      notes: [{ title: "Gap in gamma", markdown: "Cover the cold path.", severity: "major" }],
    });
    const attempt = ws.mutate(page, "approve", {});
    await expect(attempt).rejects.toThrow(PreconditionUnmetError);
    await expect(attempt).rejects.toThrow(/Gap in gamma/);
  });

  it("fails restateSections loudly when a removeId no longer exists (OCC conflict surfacing)", async () => {
    const { page, ids } = await restatableSpec("Stale ids", [["Delta", "D."]]);
    const attempt = ws.mutate(page, "restateSections", {
      removeIds: [ids[0]!, "ghost-1"],
      sections: [{ title: "Delta", markdown: "Restated." }],
    });
    await expect(attempt).rejects.toThrow(InvariantViolationError);
    await expect(attempt).rejects.toThrow(/ghost-1/);
    // Nothing landed: the original section is untouched.
    expect(els(await stateOf(page), "sections", "items").map((e) => e.id)).toEqual([ids[0]!]);
  });

  it("acceptSections flips multiple ai-draft sections to human-verified in one commit, content untouched", async () => {
    const { page, ids } = await restatableSpec("Accept as-is", [["One", "1."], ["Two", "2."], ["Three", "3."]]);
    const before = (await ws.history()).length;
    const acc = await ws.mutate(page, "acceptSections", { sectionIds: [ids[0]!, ids[1]!] });
    expect((await ws.history({ consistentWith: acc.token })).length).toBe(before + 1);
    const items = els(await stateOf(page, acc.token), "sections", "items");
    expect(items.map((e) => e.status)).toEqual(["human-verified", "human-verified", "ai-draft"]);
    expect(items.map(titleOf)).toEqual(["One", "Two", "Three"]);
    expect(await ws.toMarkdown(page)).toContain("1.");
  });

  it("unacceptSections sends verified sections back to ai-draft without content changes", async () => {
    const { page, ids } = await restatableSpec("Unaccept", [["Kept", "Body kept."]]);
    await ws.mutate(page, "acceptSections", { sectionIds: [ids[0]!] });
    const un = await ws.mutate(page, "unacceptSections", { sectionIds: [ids[0]!] });
    const item = els(await stateOf(page, un.token), "sections", "items")[0]!;
    expect(item.id).toBe(ids[0]!);
    expect(item.status).toBe("ai-draft");
    expect(titleOf(item)).toBe("Kept");
    expect(await ws.toMarkdown(page)).toContain("Body kept.");
  });

  it("acceptSections throws loudly, naming a section that is not ai-draft (and a missing id)", async () => {
    const { page, ids } = await restatableSpec("Accept guard", [["Solid", "S."]]);
    await ws.mutate(page, "acceptSections", { sectionIds: [ids[0]!] });
    const again = ws.mutate(page, "acceptSections", { sectionIds: [ids[0]!] });
    await expect(again).rejects.toThrow(InvariantViolationError);
    await expect(again).rejects.toThrow(new RegExp(`not ai-draft.*${ids[0]!}`));
    const ghost = ws.mutate(page, "acceptSections", { sectionIds: ["ghost-9"] });
    await expect(ghost).rejects.toThrow(/not found in sections\.items: ghost-9/);
  });

  it("unacceptSections throws loudly, naming a section that is not human-verified", async () => {
    const { page, ids } = await restatableSpec("Unaccept guard", [["Still draft", "D."]]);
    const attempt = ws.mutate(page, "unacceptSections", { sectionIds: [ids[0]!] });
    await expect(attempt).rejects.toThrow(InvariantViolationError);
    await expect(attempt).rejects.toThrow(new RegExp(`not human-verified: ${ids[0]!}`));
  });

  it("accept/unaccept refuse outside restating/reviewing, naming the actual page status", async () => {
    // drafting: the page was never submitted.
    const p = (await ws.createPage("spec-restatement", { title: "Too early", parentId: null })).value;
    const early = ((await ws.mutate(p, "draftSection", { title: "Alpha", markdown: "A." })).value as { sectionId: string }).sectionId;
    const inDrafting = ws.mutate(p, "acceptSections", { sectionIds: [early] });
    await expect(inDrafting).rejects.toThrow(PreconditionUnmetError);
    await expect(inDrafting).rejects.toThrow(/page is "drafting"/);

    // approved: run one spec to the terminal gate, then try to unaccept.
    const { page, ids } = await restatableSpec("Sealed", [["Omega", "O."]]);
    await ws.mutate(page, "acceptSections", { sectionIds: [ids[0]!] });
    await ws.mutate(page, "recordHolisticReview", { summary: "Clean.", notes: [] });
    await ws.mutate(page, "approve", {});
    const inApproved = ws.mutate(page, "unacceptSections", { sectionIds: [ids[0]!] });
    await expect(inApproved).rejects.toThrow(PreconditionUnmetError);
    await expect(inApproved).rejects.toThrow(/page is "approved"/);
  });

  it("reviseSection on a human-verified section downgrades it to ai-draft in the same commit", async () => {
    const { page, ids } = await restatableSpec("Revise", [["Epsilon", "E."]]);
    await ws.mutate(page, "restateSections", { removeIds: [ids[0]!], sections: [{ title: "Epsilon", markdown: "Restated." }] });
    const verified = els(await stateOf(page), "sections", "items")[0]!;
    expect(verified.status).toBe("human-verified");
    const rev = await ws.mutate(page, "reviseSection", { sectionId: verified.id, markdown: "Tightened by the agent." });
    const after = els(await stateOf(page, rev.token), "sections", "items")[0]!;
    expect(after.id).toBe(verified.id);
    expect(after.status).toBe("ai-draft");
    expect(await ws.toMarkdown(page)).toContain("Tightened by the agent.");
  });

  it("holds the element write-gate against generated structural commands on a verified section", async () => {
    const { page, ids } = await restatableSpec("Gate", [["Zeta", "Z."]]);
    await ws.mutate(page, "restateSections", { removeIds: [ids[0]!], sections: [{ title: "Zeta", markdown: "Restated." }] });
    const verified = els(await stateOf(page), "sections", "items")[0]!;
    await expect(
      ws.mutate(page, "setSectionsItemsBody", { id: verified.id, value: { kind: "blocks", blocks: [] } }),
    ).rejects.toThrow(MutationNotAllowedError);
  });

  // ── structural edits (the studio's left panel: add / move / join / split) ──────

  it("addSection inserts a human-written section, born human-verified, before `beforeId`", async () => {
    const { page, ids } = await restatableSpec("Structure", [["Alpha", "A."], ["Beta", "B."]]);
    const add = await ws.mutate(page, "addSection", { title: "Between", markdown: "Mine.", beforeId: ids[1]! });
    const items = els(await stateOf(page, add.token), "sections", "items");
    expect(items.map(titleOf)).toEqual(["Alpha", "Between", "Beta"]);
    expect(items[1]!.status).toBe("human-verified");
    expect((add.value as { sectionId: string }).sectionId).toBe(items[1]!.id);
    // beforeId the FIRST section reaches the very top; no beforeId appends.
    await ws.mutate(page, "addSection", { title: "Overview", markdown: "Mine, first.", beforeId: ids[0]! });
    const end = await ws.mutate(page, "addSection", { title: "Last", markdown: "Also mine." });
    expect(els(await stateOf(page, end.token), "sections", "items").map(titleOf)).toEqual([
      "Overview",
      "Alpha",
      "Between",
      "Beta",
      "Last",
    ]);
  });

  it("moveSection reorders without touching content or status", async () => {
    const { page, ids } = await restatableSpec("Reorder", [["Alpha", "A."], ["Beta", "B."], ["Gamma", "G."]]);
    await ws.mutate(page, "restateSections", { removeIds: [ids[1]!], sections: [{ title: "Beta", markdown: "Mine." }] });
    const beta = els(await stateOf(page), "sections", "items").find((e) => titleOf(e) === "Beta")!;
    const mv = await ws.mutate(page, "moveSection", { sectionId: beta.id, toIndex: 0 });
    const items = els(await stateOf(page, mv.token), "sections", "items");
    expect(items.map(titleOf)).toEqual(["Beta", "Alpha", "Gamma"]);
    // A verified section stays verified where it lands — moving is not a content change.
    expect(items[0]!.id).toBe(beta.id);
    expect(items[0]!.status).toBe("human-verified");
    await expect(ws.mutate(page, "moveSection", { sectionId: beta.id, toIndex: 3 })).rejects.toThrow(
      InvariantViolationError,
    );
  });

  it("joinSections merges the next section into this one, keeping THIS id", async () => {
    const { page, ids } = await restatableSpec("Join", [["Alpha", "A body."], ["Beta", "B body."], ["Gamma", "G."]]);
    const j = await ws.mutate(page, "joinSections", { sectionId: ids[0]!, absorbId: ids[1]! });
    const items = els(await stateOf(page, j.token), "sections", "items");
    expect(items.map(titleOf)).toEqual(["Alpha", "Gamma"]);
    expect(items[0]!.id).toBe(ids[0]!); // the survivor's id is stable — drafts/critiques survive
    const md = await ws.toMarkdown(page);
    expect(md).toContain("A body.\n\nB body.");
    // Only adjacent sections join, and only in that order.
    await expect(ws.mutate(page, "joinSections", { sectionId: items[1]!.id, absorbId: items[0]!.id })).rejects.toThrow(
      InvariantViolationError,
    );
  });

  it("joining two verified sections stays verified; absorbing an ai-draft returns to ai-draft", async () => {
    const { page, ids } = await restatableSpec("Provenance", [["Alpha", "A."], ["Beta", "B."], ["Gamma", "G."]]);
    for (const [i, title] of [
      [0, "Alpha"],
      [1, "Beta"],
    ] as const) {
      await ws.mutate(page, "restateSections", { removeIds: [ids[i]!], sections: [{ title, markdown: `${title} mine.` }] });
    }
    const verified = els(await stateOf(page), "sections", "items");
    const both = await ws.mutate(page, "joinSections", { sectionId: verified[0]!.id, absorbId: verified[1]!.id });
    const merged = els(await stateOf(page, both.token), "sections", "items")[0]!;
    expect(merged.status).toBe("human-verified");

    // …but pulling unrestated AI text into it makes the whole section unrestated again.
    const mixed = await ws.mutate(page, "joinSections", { sectionId: merged.id, absorbId: ids[2]! });
    const after = els(await stateOf(page, mixed.token), "sections", "items");
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe("ai-draft");
    expect(await ws.toMarkdown(page)).toContain("G.");
  });

  it("splitSection keeps the top id and status, and inserts the bottom right after it", async () => {
    const { page, ids } = await restatableSpec("Split", [["Alpha", "First half.\n\nSecond half."], ["Beta", "B."]]);
    const sp = await ws.mutate(page, "splitSection", {
      sectionId: ids[0]!,
      topMarkdown: "First half.",
      bottomMarkdown: "Second half.",
      newTitle: "Alpha, part two",
    });
    const items = els(await stateOf(page, sp.token), "sections", "items");
    expect(items.map(titleOf)).toEqual(["Alpha", "Alpha, part two", "Beta"]);
    expect(items[0]!.id).toBe(ids[0]!); // the top half's id is stable
    expect(items.map((e) => e.status)).toEqual(["ai-draft", "ai-draft", "ai-draft"]);
    expect((sp.value as { newSectionId: string }).newSectionId).toBe(items[1]!.id);
    const md = await ws.toMarkdown(page);
    expect(md).toContain("### Alpha\nFirst half.");
    expect(md).toContain("### Alpha, part two\nSecond half.");
  });

  it("splitting a verified section leaves BOTH halves verified (same words, two buckets)", async () => {
    const { page, ids } = await restatableSpec("Split verified", [["Alpha", "A."]]);
    await ws.mutate(page, "restateSections", {
      removeIds: [ids[0]!],
      sections: [{ title: "Alpha", markdown: "Mine, one.\n\nMine, two." }],
    });
    const verified = els(await stateOf(page), "sections", "items")[0]!;
    const sp = await ws.mutate(page, "splitSection", {
      sectionId: verified.id,
      topMarkdown: "Mine, one.",
      bottomMarkdown: "Mine, two.",
      newTitle: "Alpha (cont.)",
    });
    const items = els(await stateOf(page, sp.token), "sections", "items");
    expect(items.map((e) => e.status)).toEqual(["human-verified", "human-verified"]);
    expect(items[0]!.id).toBe(verified.id);
  });

  it("refuses the structural human commands outside restating/reviewing", async () => {
    const p = (await ws.createPage("spec-restatement", { title: "Structure too early", parentId: null })).value;
    const a = ((await ws.mutate(p, "draftSection", { title: "Alpha", markdown: "A." })).value as { sectionId: string })
      .sectionId;
    const b = ((await ws.mutate(p, "draftSection", { title: "Beta", markdown: "B." })).value as { sectionId: string })
      .sectionId;
    await expect(ws.mutate(p, "addSection", { title: "Mine", markdown: "Text." })).rejects.toThrow(
      PreconditionUnmetError,
    );
    await expect(ws.mutate(p, "joinSections", { sectionId: a, absorbId: b })).rejects.toThrow(PreconditionUnmetError);
    await expect(
      ws.mutate(p, "splitSection", { sectionId: a, topMarkdown: "x", bottomMarkdown: "y", newTitle: "Y" }),
    ).rejects.toThrow(PreconditionUnmetError);
    // …but the drafting agent may still reorder what it drafted.
    const mv = await ws.mutate(p, "moveSection", { sectionId: b, toIndex: 0 });
    expect(els(await stateOf(p, mv.token), "sections", "items").map(titleOf)).toEqual(["Beta", "Alpha"]);
  });

  it("renders deterministic Markdown at a mid-lifecycle state (byte-exact)", async () => {
    const p = (await ws.createPage("spec-restatement", { title: "Render demo", parentId: null })).value;
    const a = ((await ws.mutate(p, "draftSection", { title: "Alpha", markdown: "AI alpha." })).value as { sectionId: string }).sectionId;
    await ws.mutate(p, "draftSection", { title: "Beta", markdown: "Beta body.\n\nWith a second paragraph." });
    await ws.mutate(p, "submitForRestatement", {});
    await ws.mutate(p, "restateSections", { removeIds: [a], sections: [{ title: "Alpha restated", markdown: "Alpha in **my** words." }] });

    const md = await ws.toMarkdown(p);
    const expected =
      [
        "# Spec: Render demo",
        "**Status:** restating",
        "## Sections\n### Alpha restated\nAlpha in **my** words.\n\n### Beta\nBeta body.\n\nWith a second paragraph.",
        "## Review\n_Not reviewed._",
        "## Open notes\n_None._",
      ].join("\n\n") + "\n";
    expect(md).toBe(expected);
    expect(await ws.toMarkdown(p)).toBe(md);
  });

  it("surfaces ai-draft sections via attention and the blocked review edge via describeMutations", async () => {
    const { page, ids } = await restatableSpec("Discovery", [["Alpha", "A."], ["Beta", "B."]]);
    const view = await ws.page(page);
    const items = await view.attentionItems();
    expect(items.map((i) => i.elementId).sort()).toEqual([...ids].sort());
    expect(items.every((i) => i.elementType === "spec-section" && i.status === "ai-draft")).toBe(true);

    // recordHolisticReview is the command that fires the requestHolisticReview edge: it is
    // surfaced blocked, with the unmet reason naming the still-ai-draft sections.
    const desc = await view.describeMutations();
    const rec = desc.find((d) => d.name === "recordHolisticReview")!;
    expect(rec.available).toBe(false);
    expect(rec.unmet).toMatch(/Alpha, Beta/);

    // Restating one section drops it from attention; the other stays.
    const r = await ws.mutate(page, "restateSections", { removeIds: [ids[0]!], sections: [{ title: "Alpha", markdown: "Mine." }] });
    const left = await (await ws.page(page, { consistentWith: r.token })).attentionItems();
    expect(left.map((i) => i.elementId)).toEqual([ids[1]!]);
  });
});
