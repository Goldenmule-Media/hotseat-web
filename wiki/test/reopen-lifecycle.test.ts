/**
 * Reverse edges out of the feature children's terminal states. The brief can move
 * backward (reopenPlanning, requestChanges) and feature-spec already had `reopen`
 * (sealed → drafting); this covers the matching back-edges added to the other two:
 *   - implementation-plan:      ready    → draft    (reopen)
 *   - implementation-checklist: complete → building (reopen)
 *
 * Each reopen must un-freeze the content the terminal state had sealed (sections are
 * `mutableIn` only in the working state), so a sealed bundle can be reworked and
 * re-finalized rather than being stuck forever.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IWiki, IWorkspaceHandle, PageId } from "../src/api";
import { MutationNotAllowedError } from "../src/core/errors";
import { featurePageTypes } from "wiki-models/feature";
import { createTestWiki, type ITestWiki } from "../src/testing";

describe("feature children: reopen backs out of a sealed terminal state", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;
  let plan: PageId;
  let checklist: PageId;

  beforeAll(async () => {
    harness = await createTestWiki(featurePageTypes);
    wiki = harness.wiki;
    ws = await wiki.createWorkspace({ name: "Reopen" });
    const briefCommit = await ws.createPage("feature-brief", { title: "Reopen repro", parentId: null });
    const children = await (await ws.page(briefCommit.value, { consistentWith: briefCommit.token })).children();
    plan = children.find((c) => c.type === "implementation-plan")!.id;
    checklist = children.find((c) => c.type === "implementation-checklist")!.id;
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("implementation-plan: ready → reopen → draft, restoring the frozen steps for editing", async () => {
    await ws.mutate(plan, "addStep", { text: "wire the projection tailer" });
    await ws.mutate(plan, "addDataModel", { language: "ts", source: "interface Foo { id: string }" });

    const ready = await ws.mutate(plan, "markReady", {});
    expect(await (await ws.page(plan, { consistentWith: ready.token })).status()).toBe("ready");

    // Authoring the steps is frozen in `ready` (`steps` is mutableIn ["draft"]).
    await expect(ws.mutate(plan, "addStep", { text: "too late" })).rejects.toBeInstanceOf(MutationNotAllowedError);

    // Reopen restores editing, and we can re-seal (the planHasDataModel gate still holds).
    const reopened = await ws.mutate(plan, "reopen", {});
    expect(await (await ws.page(plan, { consistentWith: reopened.token })).status()).toBe("draft");

    const added = await ws.mutate(plan, "addStep", { text: "added after reopen" });
    expect(await (await ws.page(plan, { consistentWith: added.token })).status()).toBe("draft");

    const resealed = await ws.mutate(plan, "markReady", {});
    expect(await (await ws.page(plan, { consistentWith: resealed.token })).status()).toBe("ready");
  });

  it("implementation-checklist: complete → reopen → building, restoring the frozen tasks for editing", async () => {
    await ws.mutate(checklist, "addTask", { text: "ship the migration" });

    const done = await ws.mutate(checklist, "markComplete", {});
    expect(await (await ws.page(checklist, { consistentWith: done.token })).status()).toBe("complete");

    // Authoring tasks is frozen in `complete` (`tasks` is mutableIn ["building"]).
    await expect(ws.mutate(checklist, "addTask", { text: "too late" })).rejects.toBeInstanceOf(
      MutationNotAllowedError,
    );

    const reopened = await ws.mutate(checklist, "reopen", {});
    expect(await (await ws.page(checklist, { consistentWith: reopened.token })).status()).toBe("building");

    const added = await ws.mutate(checklist, "addTask", { text: "added after reopen" });
    expect(await (await ws.page(checklist, { consistentWith: added.token })).status()).toBe("building");

    const recompleted = await ws.mutate(checklist, "markComplete", {});
    expect(await (await ws.page(checklist, { consistentWith: recompleted.token })).status()).toBe("complete");
  });
});
