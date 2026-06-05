/**
 * Workspace-level archive / unarchive (the workspace twin of page archival). `archive()` hides
 * the workspace from `listWorkspaces` (status "archived") and blocks structural mutation;
 * `unarchive()` is the reversible way back — the ONE structural verb allowed to run while the
 * workspace is archived. Both sync the namespace catalog so the engine's `listWorkspaces`
 * (catalog-folded) agrees with the per-workspace stream status.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { featurePageTypes } from "wiki-models/feature";
import type { IWiki, IWorkspaceHandle, WorkspaceId } from "../src/api";
import { createTestWiki, type ITestWiki } from "../src/testing";

const statusIn = async (wiki: IWiki, id: WorkspaceId): Promise<string | undefined> =>
  (await wiki.listWorkspaces()).find((w) => w.id === id)?.status;

describe("workspace archive / unarchive", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;

  beforeAll(async () => {
    harness = await createTestWiki(featurePageTypes);
    wiki = harness.wiki;
    ws = await wiki.createWorkspace({ name: "Throwaway" });
    await ws.createPage("feature-brief", { title: "A brief", parentId: null });
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("starts active and listed", async () => {
    expect(await statusIn(wiki, ws.id)).toBe("active");
    expect(await ws.status()).toBe("active");
  });

  it("archive() flips listWorkspaces to archived and blocks structural mutation", async () => {
    await ws.archive();
    expect(await statusIn(wiki, ws.id)).toBe("archived"); // catalog-folded list agrees
    expect(await ws.status()).toBe("archived");
    await expect(ws.createPage("feature-brief", { title: "blocked", parentId: null })).rejects.toThrow();
  });

  it("unarchive() runs WHILE archived and restores the workspace", async () => {
    await ws.unarchive(); // the guard exempts this verb even though the workspace is archived
    expect(await statusIn(wiki, ws.id)).toBe("active");
    expect(await ws.status()).toBe("active");
    // mutation works again
    const p = await ws.createPage("feature-brief", { title: "restored", parentId: null });
    expect(String(p.value).startsWith("feature-brief:")).toBe(true);
  });

  it("archive → unarchive → archive round-trips (reversible, not a one-way door)", async () => {
    await ws.archive();
    expect(await statusIn(wiki, ws.id)).toBe("archived");
    await ws.unarchive();
    expect(await statusIn(wiki, ws.id)).toBe("active");
  });
});
