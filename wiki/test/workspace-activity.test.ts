/**
 * `workspaceActivity` — when each workspace last changed, for "recently changed first"
 * listings. It reads each stream's LAST commit alone (a HEAD plus a read from just inside
 * the tail), never a fold, so it stays cheap enough to call for every workspace; a
 * workspace whose stream can't be read is simply absent from the map. Timestamps come from
 * the injected clock, so a later write must always sort after an earlier one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { featurePageTypes } from "wiki-models/feature";
import type { IWiki, IWorkspaceHandle } from "../src/api";
import { createTestWiki, type ITestWiki } from "../src/testing";

describe("workspace activity", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let older: IWorkspaceHandle;
  let newer: IWorkspaceHandle;

  beforeAll(async () => {
    harness = await createTestWiki(featurePageTypes);
    wiki = harness.wiki;
    older = await wiki.createWorkspace({ name: "Older" });
    newer = await wiki.createWorkspace({ name: "Newer" });
    await newer.createPage("feature-brief", { title: "A brief", parentId: null });
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("reports the newest event's time for every id, newest workspace last-changed later", async () => {
    const activity = await wiki.workspaceActivity([older.id, newer.id]);
    expect(Object.keys(activity).sort()).toEqual([older.id, newer.id].sort());
    expect(activity[newer.id]! > activity[older.id]!).toBe(true);
  });

  it("advances when the workspace changes", async () => {
    const before = (await wiki.workspaceActivity([older.id]))[older.id]!;
    await older.createPage("feature-brief", { title: "Later", parentId: null });
    const after = (await wiki.workspaceActivity([older.id]))[older.id]!;
    expect(after > before).toBe(true);
  });

  it("omits an unknown workspace rather than failing (and does not create its stream)", async () => {
    const activity = await wiki.workspaceActivity(["ws:does-not-exist" as never, newer.id]);
    expect(activity["ws:does-not-exist" as never]).toBeUndefined();
    expect(activity[newer.id]).toBeDefined();
    expect((await wiki.listWorkspaces()).map((w) => w.id)).not.toContain("ws:does-not-exist");
  });
});
