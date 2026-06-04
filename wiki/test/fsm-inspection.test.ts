/**
 * FSM inspection (the wiki-ui model-inspection feature). Two engine surfaces back the
 * UI graph: `IWiki.fsmOf(type)` exposes a page type's status FSM as a serializable
 * descriptor, and `IPageView.describeMutations()` reports PRECONDITION-AWARE
 * availability — `available` reflects FSM-legality AND the command's pure
 * preconditions, with the first failing precondition's reason surfaced as `unmet`
 * (so the UI can render a transition as "blocked — here's why").
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IWiki, IWorkspaceHandle, PageId } from "../src/api";
import { UnknownPageTypeError } from "../src/core/errors";
import { featurePageTypes } from "wiki-models/feature";
import { createTestWiki, type ITestWiki } from "../src/testing";

describe("IWiki.fsmOf — serializable status-FSM descriptor", () => {
  let harness: ITestWiki;
  let wiki: IWiki;

  beforeAll(async () => {
    harness = await createTestWiki(featurePageTypes);
    wiki = harness.wiki;
  });
  afterAll(async () => {
    await harness.stop();
  });

  it("describes feature-brief: initial status, the full state set (initial first), every edge", () => {
    const fsm = wiki.fsmOf("feature-brief");
    expect(fsm.type).toBe("feature-brief");
    expect(fsm.initial).toBe("draft");
    expect(fsm.states[0]).toBe("draft"); // initial first
    expect(new Set(fsm.states)).toEqual(
      new Set(["draft", "planning", "building", "review", "shipped", "abandoned"]),
    );
    expect(fsm.transitions).toHaveLength(10);
    expect(fsm.transitions).toEqual(
      expect.arrayContaining([
        { from: "draft", event: "beginPlanning", to: "planning" },
        { from: "building", event: "submitForReview", to: "review" },
        { from: "review", event: "ship", to: "shipped" },
        { from: "review", event: "abandon", to: "abandoned" },
      ]),
    );
  });

  it("is JSON-serializable — no functions or cycles cross the engine→UI boundary", () => {
    const fsm = wiki.fsmOf("feature-brief");
    expect(JSON.parse(JSON.stringify(fsm))).toEqual(fsm);
  });

  it("throws UnknownPageTypeError for an unregistered type", () => {
    expect(() => wiki.fsmOf("does-not-exist")).toThrow(UnknownPageTypeError);
  });
});

describe("describeMutations — precondition-aware availability + unmet reason", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;
  let brief: PageId;
  let checklist: PageId;
  let testPlan: PageId;
  let caseId: string;
  let taskId: string;

  const shipDescriptor = async (token?: string) => {
    const view = await ws.page(brief, token !== undefined ? { consistentWith: token } : undefined);
    const descriptors = await view.describeMutations();
    return descriptors.find((d) => d.name === "ship")!;
  };

  beforeAll(async () => {
    harness = await createTestWiki(featurePageTypes);
    wiki = harness.wiki;
    ws = await wiki.createWorkspace({ name: "FSM overlay" });
    const created = await ws.createPage("feature-brief", { title: "Inspector", parentId: null });
    brief = created.value;
    const kids = await (await ws.page(brief, { consistentWith: created.token })).children();
    const plan = kids.find((k) => k.type === "implementation-plan")!.id;
    checklist = kids.find((k) => k.type === "implementation-checklist")!.id;
    testPlan = kids.find((k) => k.type === "testing-plan")!.id;

    // Walk to `review` with the beginImplementation content gates satisfied, but the
    // ship gates (checklist task done, case passed) deliberately NOT yet satisfied.
    await ws.mutate(brief, "beginPlanning", {});
    await ws.mutate(plan, "addStep", { text: "Do the thing" });
    await ws.mutate(plan, "addDataModel", { language: "ts", source: "interface X {}" });
    caseId = ((await ws.mutate(testPlan, "addCase", { text: "covers it" })).value as { caseId: string }).caseId;
    await ws.mutate(brief, "beginImplementation", {});
    taskId = ((await ws.mutate(checklist, "addTask", { text: "build" })).value as { taskId: string }).taskId;
    await ws.mutate(brief, "submitForReview", {});
  });
  afterAll(async () => {
    await harness.stop();
  });

  it("reports ship as unavailable WITH a reason while a ship gate is unmet (in review)", async () => {
    expect(await (await ws.page(brief)).status()).toBe("review");
    const ship = await shipDescriptor();
    expect(ship.available).toBe(false);
    expect(typeof ship.unmet).toBe("string");
    expect(ship.unmet!.length).toBeGreaterThan(0);
  });

  it("distinguishes FSM-illegal (no reason) from precondition-blocked (with reason)", async () => {
    const descriptors = await (await ws.page(brief)).describeMutations();
    const beginPlanning = descriptors.find((d) => d.name === "beginPlanning")!;
    // Not a legal transition from `review` at all → unavailable, and no precondition reason.
    expect(beginPlanning.available).toBe(false);
    expect(beginPlanning.unmet).toBeUndefined();
  });

  it("flips ship to available (no unmet) once every ship precondition holds", async () => {
    await ws.mutate(checklist, "checkTask", { taskId });
    const passed = await ws.mutate(testPlan, "markCasePassed", { caseId });
    const ship = await shipDescriptor(passed.token);
    expect(ship.available).toBe(true);
    expect(ship.unmet).toBeUndefined();
  });
});
