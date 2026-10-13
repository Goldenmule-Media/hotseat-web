/**
 * The `wiki/admin` move saga: a dry run that writes nothing, a full move, a refusal that
 * aborts, and a move that stopped partway finishing when run again.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { adrPageTypes } from "wiki-models/adr";
import { documentPageTypes } from "wiki-models/document";
import { tocPageTypes } from "wiki-models/toc";
import type { IWorkspaceHandle, PageId, WorkspaceId } from "../src/api";
import { movePages, resumePageMove, type BlobCopier } from "../src/admin";
import { createTestWiki, type ITestWiki } from "../src/testing";

const BLOB = "b".repeat(64);

describe("movePages", () => {
  let harness: ITestWiki;
  let src: IWorkspaceHandle;
  let dst: IWorkspaceHandle;
  let coreTech: PageId;
  let kit: PageId;
  let usage: PageId;
  let copied: string[];
  const copyBlob: BlobCopier = async (id) => {
    copied.push(id);
  };
  const open = (id: WorkspaceId) => harness.wiki.openWorkspace(id);

  beforeEach(async () => {
    harness = await createTestWiki([...tocPageTypes, ...adrPageTypes, ...documentPageTypes]);
    src = await harness.wiki.createWorkspace({ name: "Godot Addons" });
    dst = await harness.wiki.createWorkspace({ name: "Sovereign Axe" });
    coreTech = (await dst.createPage("toc", { title: "Core Tech", parentId: null })).value;
    kit = (await src.createPage("toc", { title: "UI Kit", parentId: null })).value;
    usage = (await src.createPage("document", { title: "Usage", parentId: kit })).value;
    await src.mutate(usage, "addImage", { ref: `attachment:${BLOB}`, alt: "A diagram" });
    copied = [];
  });

  afterEach(async () => {
    await harness.stop();
  });

  const base = () => ({ open, from: src.id, to: dst.id, pageIds: [kit], parentId: coreTech, copyBlob });
  const countOf = async (ws: IWorkspaceHandle, type: string) => (await ws.history()).filter((e) => e.type === type).length;

  it("a dry run reports the plan and writes nothing on either side", async () => {
    const before = [(await src.history()).length, (await dst.history()).length];
    const report = await movePages({ ...base(), dryRun: true });
    expect(report).toMatchObject({ dryRun: true, roots: [kit], movedPageIds: [kit, usage], blobs: [BLOB] });
    expect(report.moveId).toBeUndefined();
    expect([(await src.history()).length, (await dst.history()).length]).toEqual(before);
    expect(copied).toEqual([]);
  });

  it("moves the subtree, copying its attachments first", async () => {
    const report = await movePages(base());
    expect(report.dryRun).toBe(false);
    expect(report.forwards).toEqual([
      { pageId: kit, workspaceId: dst.id },
      { pageId: usage, workspaceId: dst.id },
    ]);
    expect(copied).toEqual([BLOB]);
    const tree = await dst.tree({ consistentWith: report.targetToken! });
    expect(tree.children[0]!.children.map((c) => c.id)).toEqual([kit]);
    expect(await src.forwardOf(usage, { consistentWith: report.sourceToken! })).toMatchObject({ workspace: dst.id });
  });

  it("refuses up front when the pages need attachments and no copier was given", async () => {
    await expect(movePages({ ...base(), copyBlob: undefined })).rejects.toThrow(/no blob copier/);
    expect(await src.pendingMoves()).toHaveLength(0);
  });

  it("aborts when the target refuses, leaving the source as it was", async () => {
    const failing: BlobCopier = async () => {
      // The title clash lands between the preview and the import.
      await dst.createPage("toc", { title: "UI Kit", parentId: coreTech });
    };
    await expect(movePages({ ...base(), copyBlob: failing })).rejects.toMatchObject({ code: "DUPLICATE_TITLE" });
    expect(await src.pendingMoves()).toHaveLength(0);
    expect(await countOf(src, "PageMoveAborted")).toBe(1);
    await src.mutate(usage, "addParagraph", { inlines: ["writable again"] });
  });

  it("an outage leaves the move pending, and running it again finishes it", async () => {
    const flaky: BlobCopier = async () => {
      throw new Error("connection reset");
    };
    await expect(movePages({ ...base(), copyBlob: flaky })).rejects.toThrow(/connection reset/);
    expect(await src.pendingMoves()).toHaveLength(1);

    const report = await movePages(base());
    expect(report.resumed).toBe(true);
    expect(await src.pendingMoves()).toHaveLength(0);
    expect(await countOf(dst, "PagesImported")).toBe(1);
  });

  it("resumes a move that stopped after the import, without importing twice", async () => {
    const { value: move } = await src.beginPageMove({ to: dst.id, roots: [kit], toParentId: coreTech });
    await dst.importPages(await src.exportPageMove(move.moveId));

    const report = await resumePageMove({ open, from: src.id, moveId: move.moveId, copyBlob });
    expect(report).toMatchObject({ resumed: true, moveId: move.moveId });
    expect(await countOf(dst, "PagesImported")).toBe(1);
    expect(await countOf(src, "PageMoveCompleted")).toBe(1);
    await expect(resumePageMove({ open, from: src.id, moveId: move.moveId })).rejects.toThrow(/No pending move/);
  });

  it("a repeated import still reports success after the target was archived", async () => {
    const { value: move } = await src.beginPageMove({ to: dst.id, roots: [kit], toParentId: coreTech });
    const payload = await src.exportPageMove(move.moveId);
    await dst.importPages(payload);
    await dst.archive();
    const again = await dst.importPages(payload);
    expect(again.value.alreadyImported).toBe(true);
    await src.completePageMove(move.moveId);
  });
});
