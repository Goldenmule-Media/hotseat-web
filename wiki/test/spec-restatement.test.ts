/**
 * Integration test for the real `spec-restatement` bundle (wiki-models/spec-restatement):
 * a page is born carrying the REQUIRED SLOT rubric (seeded empty), an AI authors the slots
 * and any further sections, a human proves understanding by RESTATING them (atomic replace,
 * born human-verified), a holistic AI review records notes, and a human approve gate closes
 * the loop. Exercises the seeded rubric and its Tier-1 gates (coverage, shape, citation
 * integrity), outline depth and subsection structure, the element-status write-gate
 * (`mutableIn`) and its structural-field exemption, produces-emitted page transitions,
 * positioning of restated runs, attention/describeMutations surfacing, and deterministic
 * render.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { specRestatementPageTypes } from "wiki-models/spec-restatement";
import type { DeepReadonly, IItem, IWorkspaceHandle, PageId, PageState } from "../src/api";
import { InvariantViolationError, MutationNotAllowedError, PreconditionUnmetError } from "../src/core/errors";
import { createTestWiki, type ITestWiki } from "../src/testing";

/** The required slots, in the order they are seeded. */
const SLOTS = [
  "motivation",
  "overview",
  "data-model",
  "algorithm",
  "invariants",
  "failure-semantics",
  "data-dependencies",
  "migration",
  "staged-plan",
] as const;

const SLOT_TITLES = [
  "Motivation",
  "Overview",
  "Data model & types",
  "Algorithm",
  "Invariants & limits",
  "Failure & concurrency semantics",
  "Data dependencies",
  "Migration & existing data",
  "Staged plan",
];

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

const slotOf = (el: DeepReadonly<IItem>): string => scalarOf(el, "slot");
const depthOf = (el: DeepReadonly<IItem>): number => Number(scalarOf(el, "depth") || 0);

function proseOf(state: DeepReadonly<PageState>, sectionKey: string, fieldKey: string): string {
  const f = state.sections.find((s) => s.key === sectionKey)?.fields[fieldKey];
  return f !== undefined && f.kind === "prose" ? f.value : "";
}

/** Body markdown that satisfies each slot's SHAPE gate (types are code, invariants a list). */
function slotBody(slot: string): string {
  if (slot === "data-model") return "The shape:\n\n```ts\ntype Thing = { id: string };\n```";
  if (slot === "invariants") return "- A thing's id never changes.\n- At most 100 things.";
  return `Body for ${slot}.`;
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

  /** Every section on the page, in order. */
  async function sectionsOf(page: PageId, token?: string): Promise<readonly DeepReadonly<IItem>[]> {
    return els(await stateOf(page, token), "sections", "items");
  }

  /** Only the sections the spec added beyond the rubric — what most structural tests assert on. */
  async function extraOf(page: PageId, token?: string): Promise<readonly DeepReadonly<IItem>[]> {
    return (await sectionsOf(page, token)).filter((e) => slotOf(e) === "");
  }

  /** Author every required slot, so the rubric gates pass. */
  async function fillRubric(page: PageId): Promise<void> {
    for (const slot of SLOTS) await ws.mutate(page, "writeSlot", { slot, markdown: slotBody(slot) });
  }

  /** Human-verify every section still in ai-draft (the holistic-review precondition). */
  async function acceptAllDrafts(page: PageId): Promise<void> {
    const ids = (await sectionsOf(page)).filter((e) => e.status === "ai-draft").map((e) => e.id);
    if (ids.length > 0) await ws.mutate(page, "acceptSections", { sectionIds: ids });
  }

  /** A page with the rubric authored plus `sections` drafted, submitted for restatement. */
  async function restatableSpec(title: string, sections: [string, string][]): Promise<{ page: PageId; ids: string[] }> {
    const page = (await ws.createPage("spec-restatement", { title, parentId: null })).value;
    await fillRubric(page);
    const ids: string[] = [];
    for (const [t, md] of sections) {
      ids.push(((await ws.mutate(page, "draftSection", { title: t, markdown: md })).value as { sectionId: string }).sectionId);
    }
    await ws.mutate(page, "submitForRestatement", {});
    return { page, ids };
  }

  // ── the seeded rubric ─────────────────────────────────────────────────────────

  it("seeds every required slot, empty and ai-draft, on a brand-new page", async () => {
    const p = (await ws.createPage("spec-restatement", { title: "Fresh", parentId: null })).value;
    const items = await sectionsOf(p);
    expect(items.map(titleOf)).toEqual(SLOT_TITLES);
    expect(items.map(slotOf)).toEqual([...SLOTS]);
    expect(items.every((e) => e.status === "ai-draft")).toBe(true);
    expect(items.every((e) => depthOf(e) === 0)).toBe(true);
    // Empty: present in the outline, contributing no body to the render.
    const body = items[0]!.fields["body"];
    expect(body !== undefined && body.kind === "blocks" ? body.blocks : null).toEqual([]);
    // Seeded ids are derived, so the same page replays to the same ids.
    expect(items[0]!.id).toContain("motivation");
  });

  it("refuses submitForRestatement while any required slot is empty, naming them", async () => {
    const p = (await ws.createPage("spec-restatement", { title: "Blank rubric", parentId: null })).value;
    const attempt = ws.mutate(p, "submitForRestatement", {});
    await expect(attempt).rejects.toThrow(PreconditionUnmetError);
    await expect(attempt).rejects.toThrow(/still empty: Motivation, Overview/);

    await fillRubric(p);
    await ws.mutate(p, "submitForRestatement", {});
    expect((await stateOf(p)).status).toBe("restating");
  });

  it("refuses submit when the data-model slot carries no types and the invariants slot is not a list", async () => {
    const p = (await ws.createPage("spec-restatement", { title: "Shapeless", parentId: null })).value;
    for (const slot of SLOTS) await ws.mutate(p, "writeSlot", { slot, markdown: `Prose about ${slot}.` });
    const attempt = ws.mutate(p, "submitForRestatement", {});
    await expect(attempt).rejects.toThrow(PreconditionUnmetError);
    await expect(attempt).rejects.toThrow(/must define the data as types — add a fenced code block/);
    await expect(attempt).rejects.toThrow(/must be a list of atomic rules/);

    await ws.mutate(p, "writeSlot", { slot: "data-model", markdown: slotBody("data-model") });
    await ws.mutate(p, "writeSlot", { slot: "invariants", markdown: slotBody("invariants") });
    await ws.mutate(p, "submitForRestatement", {});
    expect((await stateOf(p)).status).toBe("restating");
  });

  it("refuses submit on a `(see X)` naming no section on the page — the drift the rubric exists to catch", async () => {
    const p = (await ws.createPage("spec-restatement", { title: "Dangling", parentId: null })).value;
    await fillRubric(p);
    await ws.mutate(p, "writeSlot", {
      slot: "algorithm",
      markdown: "The store checks the condition at write time (see Enforcement).",
    });
    const attempt = ws.mutate(p, "submitForRestatement", {});
    await expect(attempt).rejects.toThrow(PreconditionUnmetError);
    await expect(attempt).rejects.toThrow(/name no section on this page.*Enforcement/s);

    // Naming a section that DOES exist resolves it — including a multi-target citation.
    await ws.mutate(p, "writeSlot", {
      slot: "algorithm",
      markdown: "The store checks the condition at write time (see Invariants & limits and Overview).",
    });
    await ws.mutate(p, "submitForRestatement", {});
    expect((await stateOf(p)).status).toBe("restating");
  });

  it("writeSlot on a verified slot downgrades it to ai-draft in the same commit", async () => {
    const { page } = await restatableSpec("Reslot", []);
    await ws.mutate(page, "acceptSections", {
      sectionIds: [(await sectionsOf(page)).find((e) => slotOf(e) === "overview")!.id],
    });
    const w = await ws.mutate(page, "writeSlot", { slot: "overview", markdown: "Rewritten by the agent." });
    const overview = (await sectionsOf(page, w.token)).find((e) => slotOf(e) === "overview")!;
    expect(overview.status).toBe("ai-draft");
    expect(await ws.toMarkdown(page)).toContain("Rewritten by the agent.");
  });

  it("re-creates a missing slot section, so a page predating the rubric is not dead-ended", async () => {
    const p = (await ws.createPage("spec-restatement", { title: "Legacy", parentId: null })).value;
    // Simulate the pre-rubric shape: strip the slot tag off every seeded section.
    for (const el of await sectionsOf(p)) {
      await ws.mutate(p, "setSectionsItemsSlot", { id: el.id, value: { kind: "scalar", value: "" } });
    }
    expect((await sectionsOf(p)).every((e) => slotOf(e) === "")).toBe(true);
    await expect(ws.mutate(p, "submitForRestatement", {})).rejects.toThrow(/required slots deleted/);

    for (const slot of SLOTS) await ws.mutate(p, "writeSlot", { slot, markdown: slotBody(slot) });
    const items = await sectionsOf(p);
    expect(items.filter((e) => slotOf(e) !== "")).toHaveLength(SLOTS.length);
    await ws.mutate(p, "submitForRestatement", {});
    expect((await stateOf(p)).status).toBe("restating");
  });

  it("protects slot sections from removal, join-away, and indent", async () => {
    const { page } = await restatableSpec("Protected", []);
    const overview = (await sectionsOf(page)).find((e) => slotOf(e) === "overview")!;
    const motivation = (await sectionsOf(page)).find((e) => slotOf(e) === "motivation")!;
    await expect(ws.mutate(page, "removeSection", { sectionId: overview.id })).rejects.toThrow(
      /required slot\(s\): Overview/,
    );
    await expect(ws.mutate(page, "joinSections", { sectionId: motivation.id, absorbId: overview.id })).rejects.toThrow(
      /fills the required "Overview" slot/,
    );
    await expect(ws.mutate(page, "indentSection", { sectionId: overview.id })).rejects.toThrow(
      /stays a top-level section/,
    );
  });

  it("carries a slot tag onto its restatement, and refuses a restatement that would drop one", async () => {
    const { page } = await restatableSpec("Slot restate", []);
    const motivation = (await sectionsOf(page)).find((e) => slotOf(e) === "motivation")!;
    const overview = (await sectionsOf(page)).find((e) => slotOf(e) === "overview")!;
    const r = await ws.mutate(page, "restateSections", {
      removeIds: [motivation.id],
      sections: [{ title: "Why we are doing this", markdown: "In my words." }],
    });
    const after = (await sectionsOf(page, r.token))[0]!;
    expect(titleOf(after)).toBe("Why we are doing this");
    expect(slotOf(after)).toBe("motivation");
    expect(after.status).toBe("human-verified");

    // Two slot sections collapsed into one would leave an obligation homeless.
    await expect(
      ws.mutate(page, "restateSections", {
        removeIds: [after.id, overview.id],
        sections: [{ title: "Both at once", markdown: "Merged." }],
      }),
    ).rejects.toThrow(/would drop required slot\(s\): Overview/);
  });

  // ── subsections (outline depth) ───────────────────────────────────────────────

  it("drafts a subsection under a parent and renders it one heading level deeper", async () => {
    const p = (await ws.createPage("spec-restatement", { title: "Nested", parentId: null })).value;
    await fillRubric(p);
    const parent = ((await ws.mutate(p, "draftSection", { title: "Synchronization", markdown: "How data arrives." }))
      .value as { sectionId: string }).sectionId;
    await ws.mutate(p, "draftSection", {
      title: "When an auth operation commits",
      markdown: "Record the reference.",
      afterId: parent,
      depth: 1,
    });
    const extra = await extraOf(p);
    expect(extra.map(titleOf)).toEqual(["Synchronization", "When an auth operation commits"]);
    expect(extra.map(depthOf)).toEqual([0, 1]);
    const md = await ws.toMarkdown(p);
    expect(md).toContain("### Synchronization\nHow data arrives.");
    expect(md).toContain("#### When an auth operation commits\nRecord the reference.");
  });

  it("refuses a depth that skips a heading level", async () => {
    const p = (await ws.createPage("spec-restatement", { title: "Skipper", parentId: null })).value;
    await ws.mutate(p, "draftSection", { title: "Top", markdown: "T." });
    await expect(ws.mutate(p, "draftSection", { title: "Way under", markdown: "W.", depth: 2 })).rejects.toThrow(
      /skips a level.*deepest legal depth here is 1/,
    );
  });

  it("indent/outdent move a section and its whole subtree, leaving verified sections verified", async () => {
    const { page } = await restatableSpec("Indent", [["Parent", "P."], ["Child", "C."], ["Grandchild", "G."]]);
    const [parent, child, grand] = (await extraOf(page)).map((e) => e.id);
    await ws.mutate(page, "indentSection", { sectionId: child! });
    await ws.mutate(page, "indentSection", { sectionId: grand! });
    await ws.mutate(page, "indentSection", { sectionId: grand! });
    expect((await extraOf(page)).map(depthOf)).toEqual([0, 1, 2]);

    // Verified sections survive re-nesting: depth is structure, not content.
    await ws.mutate(page, "acceptSections", { sectionIds: [child!, grand!] });
    const out = await ws.mutate(page, "outdentSection", { sectionId: child! });
    const after = await extraOf(page, out.token);
    expect(after.map(depthOf)).toEqual([0, 0, 1]); // the subtree shifted as one
    expect(after.slice(1).map((e) => e.status)).toEqual(["human-verified", "human-verified"]);

    await expect(ws.mutate(page, "outdentSection", { sectionId: parent! })).rejects.toThrow(
      /already a top-level section/,
    );
  });

  it("moveSection carries subsections with it and clamps depth to what the destination allows", async () => {
    const { page } = await restatableSpec("Move subtree", [["Alpha", "A."], ["Beta", "B."], ["Beta child", "BC."]]);
    const ids = (await extraOf(page)).map((e) => e.id);
    await ws.mutate(page, "indentSection", { sectionId: ids[2]! });
    expect((await extraOf(page)).map(depthOf)).toEqual([0, 0, 1]);

    // Move Beta (with its child) to the very top of the page.
    const mv = await ws.mutate(page, "moveSection", { sectionId: ids[1]!, toIndex: 0 });
    const all = await sectionsOf(page, mv.token);
    expect(all.slice(0, 2).map(titleOf)).toEqual(["Beta", "Beta child"]);
    expect(all.slice(0, 2).map(depthOf)).toEqual([0, 1]); // relative structure preserved
    expect((await extraOf(page, mv.token)).map(titleOf)).toEqual(["Beta", "Beta child", "Alpha"]);
  });

  it("removeSection deletes the whole subtree", async () => {
    const { page } = await restatableSpec("Delete subtree", [["Keep", "K."], ["Doomed", "D."], ["Doomed child", "DC."]]);
    const ids = (await extraOf(page)).map((e) => e.id);
    await ws.mutate(page, "indentSection", { sectionId: ids[2]! });
    const rm = await ws.mutate(page, "removeSection", { sectionId: ids[1]! });
    expect((await extraOf(page, rm.token)).map(titleOf)).toEqual(["Keep"]);
    expect(await ws.toMarkdown(page)).not.toContain("DC.");
  });

  it("splitSection can make the bottom half a SUBSECTION of the top", async () => {
    const { page, ids } = await restatableSpec("Split deeper", [["Long", "Top part.\n\nBottom part."]]);
    const sp = await ws.mutate(page, "splitSection", {
      sectionId: ids[0]!,
      topMarkdown: "Top part.",
      bottomMarkdown: "Bottom part.",
      newTitle: "The detail",
      asSubsection: true,
    });
    const extra = await extraOf(page, sp.token);
    expect(extra.map(titleOf)).toEqual(["Long", "The detail"]);
    expect(extra.map(depthOf)).toEqual([0, 1]);
    expect(await ws.toMarkdown(page)).toContain("#### The detail\nBottom part.");
  });

  it("refuses to join away a section that has subsections of its own", async () => {
    const { page } = await restatableSpec("Join guard", [["Alpha", "A."], ["Beta", "B."], ["Beta child", "BC."]]);
    const ids = (await extraOf(page)).map((e) => e.id);
    await ws.mutate(page, "indentSection", { sectionId: ids[2]! });
    await expect(ws.mutate(page, "joinSections", { sectionId: ids[0]!, absorbId: ids[1]! })).rejects.toThrow(
      /has subsections of its own/,
    );
  });

  // ── lifecycle ─────────────────────────────────────────────────────────────────

  it("drives the full lifecycle: draft → restate → holistic review → fix loop → approve", async () => {
    const p = (await ws.createPage("spec-restatement", { title: "Search", parentId: null })).value;
    await fillRubric(p);
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
    const items1 = await extraOf(p, r1.token);
    expect(items1.map(titleOf)).toEqual(["Indexing and querying", "Ranking"]);
    expect(items1[0]!.status).toBe("human-verified");
    expect(items1.map((e) => e.id)).not.toContain(s1);
    expect(items1.map((e) => e.id)).not.toContain(s2);
    expect(items1[1]!.id).toBe(s3);

    await ws.mutate(p, "restateSections", { removeIds: [s3], sections: [{ title: "Ranking", markdown: "Ranking, restated." }] });
    await acceptAllDrafts(p);

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
    const rankId = (await sectionsOf(p)).find((e) => titleOf(e) === "Ranking")!.id;
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

  it("re-checks the rubric at approve, because review merges and renames sections", async () => {
    const { page } = await restatableSpec("Late drift", []);
    await acceptAllDrafts(page);
    await ws.mutate(page, "recordHolisticReview", { summary: "Clean.", notes: [] });
    // A revision during review introduces a citation to a section that does not exist.
    await ws.mutate(page, "reviseSection", {
      sectionId: (await sectionsOf(page)).find((e) => slotOf(e) === "algorithm")!.id,
      markdown: "Now defers to the ordering rules (see Ordering Consistency).",
    });
    const attempt = ws.mutate(page, "approve", {});
    await expect(attempt).rejects.toThrow(PreconditionUnmetError);
    await expect(attempt).rejects.toThrow(/Ordering Consistency/);
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
    await acceptAllDrafts(page);
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
    expect((await extraOf(page)).map((e) => e.id)).toEqual([ids[0]!]);
  });

  it("acceptSections flips multiple ai-draft sections to human-verified in one commit, content untouched", async () => {
    const { page, ids } = await restatableSpec("Accept as-is", [["One", "1."], ["Two", "2."], ["Three", "3."]]);
    const before = (await ws.history()).length;
    const acc = await ws.mutate(page, "acceptSections", { sectionIds: [ids[0]!, ids[1]!] });
    expect((await ws.history({ consistentWith: acc.token })).length).toBe(before + 1);
    const items = await extraOf(page, acc.token);
    expect(items.map((e) => e.status)).toEqual(["human-verified", "human-verified", "ai-draft"]);
    expect(items.map(titleOf)).toEqual(["One", "Two", "Three"]);
    expect(await ws.toMarkdown(page)).toContain("1.");
  });

  it("unacceptSections sends verified sections back to ai-draft without content changes", async () => {
    const { page, ids } = await restatableSpec("Unaccept", [["Kept", "Body kept."]]);
    await ws.mutate(page, "acceptSections", { sectionIds: [ids[0]!] });
    const un = await ws.mutate(page, "unacceptSections", { sectionIds: [ids[0]!] });
    const item = (await extraOf(page, un.token))[0]!;
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
    await acceptAllDrafts(page);
    await ws.mutate(page, "recordHolisticReview", { summary: "Clean.", notes: [] });
    await ws.mutate(page, "approve", {});
    const inApproved = ws.mutate(page, "unacceptSections", { sectionIds: [ids[0]!] });
    await expect(inApproved).rejects.toThrow(PreconditionUnmetError);
    await expect(inApproved).rejects.toThrow(/page is "approved"/);
  });

  it("reviseSection on a human-verified section downgrades it to ai-draft in the same commit", async () => {
    const { page, ids } = await restatableSpec("Revise", [["Epsilon", "E."]]);
    await ws.mutate(page, "restateSections", { removeIds: [ids[0]!], sections: [{ title: "Epsilon", markdown: "Restated." }] });
    const verified = (await extraOf(page))[0]!;
    expect(verified.status).toBe("human-verified");
    const rev = await ws.mutate(page, "reviseSection", { sectionId: verified.id, markdown: "Tightened by the agent." });
    const after = (await extraOf(page, rev.token))[0]!;
    expect(after.id).toBe(verified.id);
    expect(after.status).toBe("ai-draft");
    expect(await ws.toMarkdown(page)).toContain("Tightened by the agent.");
  });

  it("holds the element write-gate against generated structural commands on a verified section", async () => {
    const { page, ids } = await restatableSpec("Gate", [["Zeta", "Z."]]);
    await ws.mutate(page, "restateSections", { removeIds: [ids[0]!], sections: [{ title: "Zeta", markdown: "Restated." }] });
    const verified = (await extraOf(page))[0]!;
    await expect(
      ws.mutate(page, "setSectionsItemsBody", { id: verified.id, value: { kind: "blocks", blocks: [] } }),
    ).rejects.toThrow(MutationNotAllowedError);
    // …but `depth` is declared structural, so it stays writable while verified.
    await ws.mutate(page, "setSectionsItemsDepth", { id: verified.id, value: { kind: "scalar", value: 0 } });
  });

  // ── structural edits (the studio's left panel: add / move / join / split) ──────

  it("addSection inserts a human-written section, born human-verified, before `beforeId`", async () => {
    const { page, ids } = await restatableSpec("Structure", [["Alpha", "A."], ["Beta", "B."]]);
    const add = await ws.mutate(page, "addSection", { title: "Between", markdown: "Mine.", beforeId: ids[1]! });
    const items = await extraOf(page, add.token);
    expect(items.map(titleOf)).toEqual(["Alpha", "Between", "Beta"]);
    expect(items[1]!.status).toBe("human-verified");
    expect((add.value as { sectionId: string }).sectionId).toBe(items[1]!.id);
    // beforeId the FIRST drafted section, and no beforeId appends.
    await ws.mutate(page, "addSection", { title: "Preamble", markdown: "Mine, first.", beforeId: ids[0]! });
    const end = await ws.mutate(page, "addSection", { title: "Last", markdown: "Also mine." });
    expect((await extraOf(page, end.token)).map(titleOf)).toEqual([
      "Preamble",
      "Alpha",
      "Between",
      "Beta",
      "Last",
    ]);
  });

  it("moveSection reorders without touching content or status", async () => {
    const { page, ids } = await restatableSpec("Reorder", [["Alpha", "A."], ["Beta", "B."], ["Gamma", "G."]]);
    await ws.mutate(page, "restateSections", { removeIds: [ids[1]!], sections: [{ title: "Beta", markdown: "Mine." }] });
    const beta = (await extraOf(page)).find((e) => titleOf(e) === "Beta")!;
    const mv = await ws.mutate(page, "moveSection", { sectionId: beta.id, toIndex: 0 });
    const items = await extraOf(page, mv.token);
    expect(items.map(titleOf)).toEqual(["Beta", "Alpha", "Gamma"]);
    // A verified section stays verified where it lands — moving is not a content change.
    expect(items[0]!.id).toBe(beta.id);
    expect(items[0]!.status).toBe("human-verified");
    const past = (await sectionsOf(page)).length + 1;
    await expect(ws.mutate(page, "moveSection", { sectionId: beta.id, toIndex: past })).rejects.toThrow(
      InvariantViolationError,
    );
  });

  it("joinSections merges the next section into this one, keeping THIS id", async () => {
    const { page, ids } = await restatableSpec("Join", [["Alpha", "A body."], ["Beta", "B body."], ["Gamma", "G."]]);
    const j = await ws.mutate(page, "joinSections", { sectionId: ids[0]!, absorbId: ids[1]! });
    const items = await extraOf(page, j.token);
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
    const verified = await extraOf(page);
    const both = await ws.mutate(page, "joinSections", { sectionId: verified[0]!.id, absorbId: verified[1]!.id });
    const merged = (await extraOf(page, both.token))[0]!;
    expect(merged.status).toBe("human-verified");

    // …but pulling unrestated AI text into it makes the whole section unrestated again.
    const mixed = await ws.mutate(page, "joinSections", { sectionId: merged.id, absorbId: ids[2]! });
    const after = await extraOf(page, mixed.token);
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
    const items = await extraOf(page, sp.token);
    expect(items.map(titleOf)).toEqual(["Alpha", "Alpha, part two", "Beta"]);
    expect(items[0]!.id).toBe(ids[0]!); // the top half's id is stable
    expect(items.map((e) => e.status)).toEqual(["ai-draft", "ai-draft", "ai-draft"]);
    expect(items.map(depthOf)).toEqual([0, 0, 0]); // a plain split is a sibling
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
    const verified = (await extraOf(page))[0]!;
    const sp = await ws.mutate(page, "splitSection", {
      sectionId: verified.id,
      topMarkdown: "Mine, one.",
      bottomMarkdown: "Mine, two.",
      newTitle: "Alpha (cont.)",
    });
    const items = await extraOf(page, sp.token);
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
    await expect(ws.mutate(p, "removeSection", { sectionId: b })).rejects.toThrow(PreconditionUnmetError);
    await expect(ws.mutate(p, "joinSections", { sectionId: a, absorbId: b })).rejects.toThrow(PreconditionUnmetError);
    await expect(
      ws.mutate(p, "splitSection", { sectionId: a, topMarkdown: "x", bottomMarkdown: "y", newTitle: "Y" }),
    ).rejects.toThrow(PreconditionUnmetError);
    // …but the drafting agent may still restructure what it drafted.
    const at = (await sectionsOf(p)).findIndex((e) => e.id === a);
    const mv = await ws.mutate(p, "moveSection", { sectionId: b, toIndex: at });
    expect((await extraOf(p, mv.token)).map(titleOf)).toEqual(["Beta", "Alpha"]);
    await ws.mutate(p, "indentSection", { sectionId: a });
    expect((await extraOf(p)).map(depthOf)).toEqual([0, 1]);
  });

  it("renders deterministic Markdown at a mid-lifecycle state (byte-exact)", async () => {
    const p = (await ws.createPage("spec-restatement", { title: "Render demo", parentId: null })).value;
    for (const slot of SLOTS) await ws.mutate(p, "writeSlot", { slot, markdown: `${slot} body.` });
    const a = ((await ws.mutate(p, "draftSection", { title: "Alpha", markdown: "AI alpha." })).value as { sectionId: string }).sectionId;
    const beta = ((await ws.mutate(p, "draftSection", { title: "Beta", markdown: "Beta body." })).value as { sectionId: string }).sectionId;
    await ws.mutate(p, "draftSection", { title: "Beta detail", markdown: "A nested note.", afterId: beta, depth: 1 });
    await ws.mutate(p, "reviseSection", { sectionId: a, markdown: "Alpha in **my** words." });

    const md = await ws.toMarkdown(p);
    const expected =
      [
        "# Spec: Render demo",
        "**Status:** drafting",
        "## Sections\n" +
          [
            ...SLOT_TITLES.map((t, i) => `### ${t}\n${SLOTS[i]} body.`),
            "### Alpha\nAlpha in **my** words.",
            "### Beta\nBeta body.",
            "#### Beta detail\nA nested note.",
          ].join("\n\n"),
        "## Review\n_Not reviewed._",
        "## Open notes\n_None._",
      ].join("\n\n") + "\n";
    expect(md).toBe(expected);
    expect(await ws.toMarkdown(p)).toBe(md);
  });

  it("surfaces ai-draft sections via attention and the blocked review edge via describeMutations", async () => {
    const { page, ids } = await restatableSpec("Discovery", [["Alpha", "A."], ["Beta", "B."]]);
    const slotIds = (await sectionsOf(page)).filter((e) => slotOf(e) !== "").map((e) => e.id);
    const view = await ws.page(page);
    const items = await view.attentionItems();
    expect(items.map((i) => i.elementId).sort()).toEqual([...slotIds, ...ids].sort());
    expect(items.every((i) => i.elementType === "spec-section" && i.status === "ai-draft")).toBe(true);

    // recordHolisticReview is the command that fires the requestHolisticReview edge: it is
    // surfaced blocked, with the unmet reason naming the still-ai-draft sections.
    const desc = await view.describeMutations();
    const rec = desc.find((d) => d.name === "recordHolisticReview")!;
    expect(rec.available).toBe(false);
    expect(rec.unmet).toMatch(/Alpha, Beta/);

    // Restating one section drops it from attention; the others stay.
    const r = await ws.mutate(page, "restateSections", { removeIds: [ids[0]!], sections: [{ title: "Alpha", markdown: "Mine." }] });
    const left = await (await ws.page(page, { consistentWith: r.token })).attentionItems();
    expect(left.map((i) => i.elementId)).not.toContain(ids[0]!);
    expect(left.map((i) => i.elementId)).toContain(ids[1]!);
  });
});
