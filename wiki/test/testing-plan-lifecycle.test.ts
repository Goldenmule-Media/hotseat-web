/**
 * Regression: testing-plan "author the set, then record results" lifecycle
 * (feature-review.md Item 5).
 *
 * The bug: `cases` was `mutableIn: ["draft"]`, and `markCasePassed`/`markCaseFailed`
 * TARGET the `cases` section, so they inherited that section's CONTENT write-gate.
 * Once `markReady` sealed the plan into `ready`, the results commands were blocked,
 * the cases stuck at `planned`, and the brief's `allCasesPassed` ship gate became
 * permanently unreachable — a silent deadlock that the worked-example never caught
 * (it marks a case while the plan is still `draft`).
 *
 * The cure (Item 5b, per-op gating) gates each OP by its nature: a content edit
 * (addCase) is gated by the section's `mutableIn`, but an element-FSM transition
 * (markCasePassed) is gated only by the element FSM. So after `markReady`:
 *   - recording results MUST work (the deadlock is gone), and
 *   - editing the case SET (addCase) MUST be frozen (authoring is done).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DeepReadonly, IItem, IField, IWiki, IWorkspaceHandle, PageState, PageId } from "../src/api";
import { MutationNotAllowedError } from "../src/core/errors";
import { featurePageTypes } from "wiki-models/feature";
import { createTestWiki, type ITestWiki } from "../src/testing";

function caseStatus(state: DeepReadonly<PageState>, caseId: string): string | undefined {
  const sec = state.sections.find((s) => s.key === "cases");
  const f = sec?.fields["items"] as DeepReadonly<IField> | undefined;
  if (f === undefined || f.kind !== "list") return undefined;
  return f.elements.find((e) => e.id === caseId)?.status;
}

describe("testing-plan: author the set in draft, record results after markReady", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;
  let testPlan: PageId;

  beforeAll(async () => {
    harness = await createTestWiki(featurePageTypes);
    wiki = harness.wiki;
    ws = await wiki.createWorkspace({ name: "Lifecycle" });
    const briefCommit = await ws.createPage("feature-brief", { title: "Deadlock repro", parentId: null });
    const children = await (await ws.page(brief(briefCommit), { consistentWith: briefCommit.token })).children();
    testPlan = children.find((c) => c.type === "testing-plan")!.id;
  });

  // Tiny helper so the brief id reads clearly above.
  function brief(c: { value: PageId }): PageId {
    return c.value;
  }

  afterAll(async () => {
    await harness.stop();
  });

  it("records pass/fail on cases AFTER the plan is sealed into `ready` (the deadlock is gone)", async () => {
    const c1 = (await ws.mutate(testPlan, "addCase", { text: "10k-row export < 2s" })).value as { caseId: string };
    const c2 = (await ws.mutate(testPlan, "addCase", { text: "memory stays flat" })).value as { caseId: string };

    // Seal the plan: draft → ready (irreversible). This is where results used to freeze.
    const ready = await ws.mutate(testPlan, "markReady", {});
    expect(await (await ws.page(testPlan, { consistentWith: ready.token })).status()).toBe("ready");

    // Recording results is an element-FSM transition — it MUST still work in `ready`.
    await ws.mutate(testPlan, "markCasePassed", { caseId: c1.caseId });
    const failed = await ws.mutate(testPlan, "markCaseFailed", { caseId: c2.caseId });

    const state = await (await ws.page(testPlan, { consistentWith: failed.token })).state();
    expect(caseStatus(state, c1.caseId)).toBe("passed");
    expect(caseStatus(state, c2.caseId)).toBe("failed");

    // ...and recovery from a failure: failed → passed (the case FSM allows it).
    const fixed = await ws.mutate(testPlan, "markCasePassed", { caseId: c2.caseId });
    expect(caseStatus(await (await ws.page(testPlan, { consistentWith: fixed.token })).state(), c2.caseId)).toBe("passed");
  });

  it("freezes the case SET in `ready`: addCase (a content edit) is rejected", async () => {
    // Editing the set is content authoring — frozen once the plan is sealed.
    await expect(ws.mutate(testPlan, "addCase", { text: "added too late" })).rejects.toBeInstanceOf(
      MutationNotAllowedError,
    );
  });
});
