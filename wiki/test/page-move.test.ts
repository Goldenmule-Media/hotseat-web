/**
 * Cross-workspace page moves, step by step: the source journal (begin → complete | abort), the
 * freeze while a move is pending, and the forwards a finished move leaves behind.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adrPageTypes } from "wiki-models/adr";
import { documentPageTypes } from "wiki-models/document";
import { tocPageTypes } from "wiki-models/toc";
import type { IWorkspaceHandle, PageId } from "../src/api";
import { Registry } from "../src/core/registry";
import { deserializeState, serializeState } from "../src/core/snapshot";
import { foldWorkspace } from "../src/core/workspace";
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
