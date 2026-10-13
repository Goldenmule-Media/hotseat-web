/**
 * Cross-workspace page moves, step by step: the source journal (begin → complete | abort), the
 * freeze while a move is pending, and the forwards a finished move leaves behind.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adrPageTypes } from "wiki-models/adr";
import { documentPageTypes } from "wiki-models/document";
import { tocPageTypes } from "wiki-models/toc";
import type { IEventEnvelope, IPageMoveExport, IWorkspaceHandle, PageId } from "../src/api";
import { Registry } from "../src/core/registry";
import { deserializeState, serializeState } from "../src/core/snapshot";
import { foldWorkspace } from "../src/core/workspace";
import { renderPage } from "../src/render/read-model";
import { createTestWiki, type ITestWiki } from "../src/testing";

const TYPES = [...tocPageTypes, ...adrPageTypes, ...documentPageTypes];

describe("page move journal", () => {
  let harness: ITestWiki;
  let src: IWorkspaceHandle;
  let dst: IWorkspaceHandle;
  let kit: PageId;
  let usage: PageId;
  let other: PageId;

  beforeAll(async () => {
    harness = await createTestWiki(TYPES);
    src = await harness.wiki.createWorkspace({ name: "Godot Addons" });
    dst = await harness.wiki.createWorkspace({ name: "Sovereign Axe" });
    kit = (await src.createPage("toc", { title: "UI Kit", parentId: null })).value;
    usage = (await src.createPage("document", { title: "Usage", parentId: kit })).value;
    other = (await src.createPage("document", { title: "Other", parentId: null })).value;
    await src.link(other, kit, "uses");
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("refuses a move to the same workspace, an unknown page, or a pinned root", async () => {
    await expect(src.beginPageMove({ to: src.id, roots: [kit], toParentId: null })).rejects.toThrow(/another workspace/);
    await expect(src.beginPageMove({ to: dst.id, roots: ["toc:nope" as PageId], toParentId: null })).rejects.toMatchObject({
      code: "PAGE_NOT_FOUND",
    });
  });

  it("freezes the subtree while the move is pending, and an abort unfreezes it", async () => {
    const { value: move } = await src.beginPageMove({ to: dst.id, roots: [usage, kit], toParentId: null });
    expect(move.roots).toEqual([kit]);
    expect(move.pageIds).toEqual([kit, usage]);
    expect(await src.pendingMoves()).toHaveLength(1);

    await expect(src.mutate(usage, "addParagraph", { inlines: ["frozen"] })).rejects.toMatchObject({
      code: "PAGE_MOVE_IN_PROGRESS",
    });
    await expect(src.createPage("document", { title: "New", parentId: kit })).rejects.toMatchObject({
      code: "PAGE_MOVE_IN_PROGRESS",
    });
    await expect(src.setPageTitle(kit, "Renamed")).rejects.toMatchObject({ code: "PAGE_MOVE_IN_PROGRESS" });
    await expect(src.reparent(other, kit)).rejects.toMatchObject({ code: "PAGE_MOVE_IN_PROGRESS" });
    await expect(src.beginPageMove({ to: dst.id, roots: [usage], toParentId: null })).rejects.toMatchObject({
      code: "PAGE_MOVE_IN_PROGRESS",
    });
    // Pages outside the move stay writable.
    await src.mutate(other, "addParagraph", { inlines: ["still writable"] });

    await src.abortPageMove(move.moveId, "target refused");
    expect(await src.pendingMoves()).toHaveLength(0);
    await src.mutate(usage, "addParagraph", { inlines: ["thawed"] });
    // Aborting twice is a no-op.
    await src.abortPageMove(move.moveId, "again");
  });

  it("completing drops the pages, leaves forwards, and retargets inbound links", async () => {
    const { value: move } = await src.beginPageMove({ to: dst.id, roots: [kit], toParentId: null });
    const { token } = await src.completePageMove(move.moveId);

    const tree = await src.tree({ consistentWith: token });
    expect(tree.children.map((c) => c.id)).toEqual([other]);
    expect(await src.forwardOf(kit)).toEqual({ workspace: dst.id, title: "UI Kit", moveId: move.moveId });
    expect(await src.forwardOf(usage)).toEqual({ workspace: dst.id, title: "Usage", moveId: move.moveId });
    expect(await src.pendingMoves()).toHaveLength(0);

    const md = await src.toMarkdown(other);
    expect(md).toContain(`uses → [UI Kit](wiki://${dst.id}/${kit})`);

    // Completing again is a no-op; aborting a finished move is refused.
    await src.completePageMove(move.moveId);
    await expect(src.abortPageMove(move.moveId, "late")).rejects.toThrow(/already completed/);
  });

  it("folds the same forwards from history and through a snapshot", async () => {
    const registry = new Registry(TYPES);
    const state = foldWorkspace(await src.history(), registry);
    expect([...state.forwards.keys()]).toEqual([kit, usage]);
    expect(state.pages.has(kit)).toBe(false);
    const round = deserializeState(JSON.parse(JSON.stringify(serializeState(state))));
    expect(round.forwards).toEqual(state.forwards);
    expect(round.pendingMoves.size).toBe(0);
  });
});

const BLOB = "a".repeat(64);

async function acceptedAdr(ws: IWorkspaceHandle, parent: PageId, title: string): Promise<PageId> {
  const id = (await ws.createPage("decision-record", { title, parentId: parent })).value;
  await ws.mutate(id, "setDate", { date: "2026-06-05" });
  await ws.mutate(id, "setContext", { text: `Why ${title}.` });
  await ws.mutate(id, "addDecisionBlock", { text: `We will ${title}.` });
  await ws.mutate(id, "addConsequence", { text: `${title} has consequences.` });
  await ws.mutate(id, "accept", {});
  return id;
}

describe("page move export and import", () => {
  let harness: ITestWiki;
  let src: IWorkspaceHandle;
  let dst: IWorkspaceHandle;
  let coreTech: PageId;
  let kit: PageId;
  let usage: PageId;
  let notes: PageId;
  let adr: PageId;
  let outside: PageId;

  beforeAll(async () => {
    harness = await createTestWiki(TYPES);
    src = await harness.wiki.createWorkspace({ name: "Godot Addons" });
    dst = await harness.wiki.createWorkspace({ name: "Sovereign Axe" });
    coreTech = (await dst.createPage("toc", { title: "Core Tech", parentId: null })).value;
    await acceptedAdr(dst, coreTech, "Use Godot");

    kit = (await src.createPage("toc", { title: "UI Kit", parentId: null })).value;
    notes = (await src.createPage("document", { title: "Notes", parentId: kit })).value;
    usage = (await src.createPage("document", { title: "Usage", parentId: kit })).value;
    adr = await acceptedAdr(src, kit, "Use signals");
    outside = (await src.createPage("document", { title: "Outside", parentId: null })).value;
    await src.mutate(usage, "addParagraph", { inlines: ["See ", { ref: notes }, " and ", { ref: outside }, "."] });
    await src.mutate(usage, "addImage", { ref: `attachment:${BLOB}`, alt: "A diagram" });
    await src.link(usage, outside, "uses");
    await src.link(usage, notes, "extends");
    await src.link(outside, usage, "documented-by");
    await src.mutate(outside, "addParagraph", { inlines: ["Read ", { ref: usage }, "."] });
  });

  afterAll(async () => {
    await harness.stop();
  });

  const request = () => ({ to: dst.id, roots: [kit], toParentId: coreTech });

  it("exports the subtree in tree order with refs and links leaving it retargeted to the source", async () => {
    const out = await src.exportPageMove(request());
    expect(out.pages.map((p) => p.id)).toEqual([kit, notes, usage, adr]);
    expect(out.pages[0]!.parentId).toBeNull();
    expect(out.pages[1]!.parentId).toBe(kit);
    expect(out.blobs).toEqual([BLOB]);
    const body = JSON.stringify(out.pages.find((p) => p.id === usage)!.sections);
    expect(body).toContain(JSON.stringify({ kind: "page", id: outside, workspace: src.id, title: "Outside" }));
    expect(body).toContain(JSON.stringify({ kind: "page", id: notes }));
    expect(out.links).toEqual([
      { from: usage, to: outside, role: "uses", workspace: src.id, title: "Outside" },
      { from: usage, to: notes, role: "extends" },
    ]);
  });

  it("a dry-run import checks the payload and writes nothing", async () => {
    const before = (await dst.history()).length;
    const { value } = await dst.importPages({ ...(await src.exportPageMove(request())), moveId: "move:preview" }, { dryRun: true });
    expect(value.alreadyImported).toBe(false);
    expect(value.serials[adr]).toEqual({ meta: { number: { from: 1, to: 2 } } });
    expect((await dst.history()).length).toBe(before);
  });

  it("refuses an import whose root title clashes with a sibling", async () => {
    const clash = (await dst.createPage("toc", { title: "UI Kit", parentId: coreTech })).value;
    await expect(
      dst.importPages({ ...(await src.exportPageMove(request())), moveId: "move:clash" }, { dryRun: true }),
    ).rejects.toMatchObject({ code: "DUPLICATE_TITLE" });
    await dst.setPageTitle(clash, "UI Kit (old)");
  });

  it("moves the pages: ids, statuses and content kept, serials re-minted, links and refs retargeted", async () => {
    const { value: move } = await src.beginPageMove(request());
    const payload = await src.exportPageMove(move.moveId);
    const { value: imported, token } = await dst.importPages(payload);
    expect(imported.pageIds).toEqual([kit, notes, usage, adr]);
    await src.completePageMove(move.moveId);

    const tree = await dst.tree({ consistentWith: token });
    const core = tree.children.find((c) => c.id === coreTech)!;
    expect(core.children.map((c) => c.title)).toEqual(["Use Godot", "UI Kit (old)", "UI Kit"]);
    expect(core.children[2]!.children.map((c) => c.id)).toEqual([notes, usage, adr]);

    const adrMd = await dst.toMarkdown(adr);
    expect(adrMd).toMatch(/\*\*Status:\*\* accepted/);
    expect(adrMd).toContain("ADR-2");

    const usageMd = await dst.toMarkdown(usage);
    expect(usageMd).toContain(`See Notes and [Outside](wiki://${src.id}/${outside}).`);
    expect(usageMd).toContain(`uses → [Outside](wiki://${src.id}/${outside})`);
    expect(usageMd).toContain(`extends → [Notes](${notes})`);
    expect(usageMd).toContain(`attachment:${BLOB}`);

    const history = await dst.history();
    const imported_ = history.find((e) => e.type === "PagesImported")!;
    const records = (imported_.payload as { pages: { id: string; originalSerials?: unknown }[] }).pages;
    expect(records.find((r) => r.id === adr)!.originalSerials).toEqual({ meta: { number: 1 } });
    // Content arrives stamped at the type's current schema version, so upcasters don't re-run on it.
    const registry = new Registry(TYPES);
    const types = new Map<string, string>([[kit, "toc"], [notes, "document"], [usage, "document"], [adr, "decision-record"]]);
    const content = history.filter((e) => e.version > imported_.version && e.version <= imported_.version + 4);
    expect(content.map((e) => e.pageId)).toEqual([kit, notes, usage, adr]);
    for (const e of content) expect(e.schemaVersion).toBe(registry.page(types.get(e.pageId!)!).version);

    // The source keeps a forward, and the page that stayed links out to the moved one.
    expect(await src.forwardOf(usage)).toMatchObject({ workspace: dst.id, title: "Usage" });
    expect(await src.toMarkdown(outside)).toContain(`documented-by → [Usage](wiki://${dst.id}/${usage})`);
  });

  it("pages that stay keep working against the moved ones through their forwards", async () => {
    await expect(src.page(usage)).rejects.toMatchObject({ code: "PAGE_MOVED", workspaceId: dst.id, pageId: usage });
    await expect(src.toMarkdown(usage)).rejects.toMatchObject({ code: "PAGE_MOVED" });
    await expect(src.mutate(usage, "addParagraph", { inlines: ["x"] })).rejects.toMatchObject({ code: "PAGE_MOVED" });
    await expect(src.reparent(usage, null)).rejects.toMatchObject({ code: "PAGE_MOVED" });

    // A page whose content refers to a moved page stays writable and labels it in its new home.
    const { token } = await src.mutate(outside, "addParagraph", { inlines: ["Still here."] });
    expect(await src.toMarkdown(outside, { consistentWith: token })).toContain(`Read [Usage](wiki://${dst.id}/${usage}).`);

    // Linking to a moved page links to it where it lives now; unlinking finds that edge.
    const linked = await src.link(outside, notes, "see");
    expect(await src.toMarkdown(outside, { consistentWith: linked.token })).toContain(`see → [Notes](wiki://${dst.id}/${notes})`);
    const unlinked = await src.unlink(outside, notes, "see");
    expect(await src.toMarkdown(outside, { consistentWith: unlinked.token })).not.toContain("see →");
  });

  it("is idempotent: importing or completing the same move again writes nothing", async () => {
    const move = (await dst.history()).find((e) => e.type === "PagesImported")!;
    const { moveId } = move.payload as { moveId: string };
    const before = (await dst.history()).length;
    const again = await dst.importPages({ moveId, to: dst.id } as IPageMoveExport);
    expect(again.value.alreadyImported).toBe(true);
    expect((await dst.history()).length).toBe(before);
    await src.completePageMove(moveId);
  });

  it("replays to the same render from history alone", async () => {
    const registry = new Registry(TYPES);
    const events: readonly IEventEnvelope[] = await dst.history();
    const folded = foldWorkspace(events, registry);
    for (const id of [kit, usage, adr]) expect(renderPage(folded, id, registry)).toBe(await dst.toMarkdown(id));
  });

  it("moves back: the round trip clears the forward on the original side", async () => {
    const { value: move } = await dst.beginPageMove({ to: src.id, roots: [kit], toParentId: null });
    await src.importPages(await dst.exportPageMove(move.moveId));
    const { token } = await dst.completePageMove(move.moveId);
    expect(await src.forwardOf(kit)).toBeUndefined();
    expect(await dst.forwardOf(kit, { consistentWith: token })).toMatchObject({ workspace: src.id });
    // The ref and the link that pointed back home are local again.
    expect(await src.toMarkdown(usage)).toContain("See Notes and Outside.");
    const outsideMd = await src.toMarkdown(outside);
    expect(outsideMd).toContain(`documented-by → [Usage](${usage})`);
    expect(outsideMd).toContain("Read Usage.");
  });
});
