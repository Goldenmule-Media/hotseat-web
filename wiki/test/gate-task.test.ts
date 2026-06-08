/**
 * Computed gate-tasks on the implementation-checklist.
 *
 * A gate-task binds to a structural fact (`meta.computed = "all-cases-passed"`). Its
 * checkbox is COMPUTED at render from the sibling testing-plan's case statuses — so it
 * flips on its own as results land and CANNOT be hand-toggled (the engine refuses to
 * drive a computed element's FSM). Manual tasks still check/uncheck normally.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IWiki, IWorkspaceHandle, PageId } from "../src/api";
import { MutationNotAllowedError } from "../src/core/errors";
import { featurePageTypes } from "wiki-models/feature";
import { createTestWiki, type ITestWiki } from "../src/testing";

describe("implementation-checklist: computed gate-tasks can't lie or be hand-toggled", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;
  let checklist: PageId;
  let testPlan: PageId;
  let gateTask: string;

  beforeAll(async () => {
    harness = await createTestWiki(featurePageTypes);
    wiki = harness.wiki;
    ws = await wiki.createWorkspace({ name: "Gate" });
    const c = await ws.createPage("feature-brief", { title: "Bulk export", parentId: null });
    const children = await (await ws.page(c.value, { consistentWith: c.token })).children();
    checklist = children.find((ch) => ch.type === "implementation-checklist")!.id;
    testPlan = children.find((ch) => ch.type === "testing-plan")!.id;
    gateTask = ((await ws.mutate(checklist, "addGateTask", {
      text: "All testing-plan cases pass",
      computed: "all-cases-passed",
    })).value as { taskId: string }).taskId;
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("renders the gate-task UNCHECKED while the testing-plan has unpassed/zero cases", async () => {
    const md = await ws.toMarkdown(checklist);
    expect(await ws.toMarkdown(checklist)).toBe(md); // deterministic
    expect(md).toContain("[ ] All testing-plan cases pass");
  });

  it("flips the gate-task to CHECKED once every testing-plan case is passed (computed, cross-page)", async () => {
    const c1 = (await ws.mutate(testPlan, "addCase", { text: "10k-row export < 2s" })).value as { caseId: string };
    await ws.mutate(testPlan, "markReady", {});
    // Still failing/unpassed → gate stays unchecked.
    await ws.mutate(testPlan, "markCaseFailed", { caseId: c1.caseId });
    expect(await ws.toMarkdown(checklist)).toContain("[ ] All testing-plan cases pass");
    // Now pass it → the computed box flips, with no write to the checklist at all.
    await ws.mutate(testPlan, "markCasePassed", { caseId: c1.caseId });
    expect(await ws.toMarkdown(checklist)).toContain("[x] All testing-plan cases pass");
  });

  it("refuses to hand-check a computed gate-task", async () => {
    await expect(ws.mutate(checklist, "checkTask", { taskId: gateTask })).rejects.toBeInstanceOf(
      MutationNotAllowedError,
    );
  });

  it("still checks/unchecks MANUAL tasks normally (coexistence)", async () => {
    const manual = ((await ws.mutate(checklist, "addTask", { text: "Scaffold the app" })).value as { taskId: string }).taskId;
    await ws.mutate(checklist, "checkTask", { taskId: manual });
    expect(await ws.toMarkdown(checklist)).toContain("[x] Scaffold the app");
    await ws.mutate(checklist, "uncheckTask", { taskId: manual });
    expect(await ws.toMarkdown(checklist)).toContain("[ ] Scaffold the app");
  });
});
