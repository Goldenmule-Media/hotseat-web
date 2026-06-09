/**
 * Workspace rename. `rename()` appends a `WorkspaceRenamed` structural event (the display name
 * changes; the id never does) and syncs the namespace catalog so `listWorkspaces` agrees with
 * the per-workspace stream. The name must be non-empty; renaming to the current name is a
 * no-op commit; rename is blocked while the workspace is archived (like every structural verb
 * except unarchive).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { featurePageTypes } from "wiki-models/feature";
import type { IWiki, IWorkspaceHandle, WorkspaceId } from "../src/api";
import { createTestWiki, type ITestWiki } from "../src/testing";

const nameIn = async (wiki: IWiki, id: WorkspaceId): Promise<string | undefined> =>
  (await wiki.listWorkspaces()).find((w) => w.id === id)?.name;

describe("workspace rename", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;

  beforeAll(async () => {
    harness = await createTestWiki(featurePageTypes);
    wiki = harness.wiki;
    ws = await wiki.createWorkspace({ name: "Before" });
    await ws.createPage("feature-brief", { title: "A brief", parentId: null });
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("rename() changes the listed name and the folded state's name; the id is unchanged", async () => {
    const idBefore = ws.id;
    const { token } = await ws.rename("After");
    expect(await nameIn(wiki, ws.id)).toBe("After"); // catalog-folded list agrees
    expect((await ws.tree({ consistentWith: token })).title).toBe("After"); // folded state agrees
    expect(ws.id).toBe(idBefore);
  });

  it("trims surrounding whitespace", async () => {
    await ws.rename("  Padded  ");
    expect(await nameIn(wiki, ws.id)).toBe("Padded");
  });

  it("rejects an empty (or whitespace-only) name", async () => {
    await expect(ws.rename("   ")).rejects.toThrow(/non-empty/);
    expect(await nameIn(wiki, ws.id)).toBe("Padded");
  });

  it("renaming to the current name is a no-op (no event appended)", async () => {
    const before = (await ws.history()).length;
    await ws.rename("Padded");
    expect((await ws.history()).length).toBe(before);
  });

  it("is blocked while the workspace is archived", async () => {
    await ws.archive();
    await expect(ws.rename("While archived")).rejects.toThrow();
    await ws.unarchive();
    expect(await nameIn(wiki, ws.id)).toBe("Padded");
  });
});
