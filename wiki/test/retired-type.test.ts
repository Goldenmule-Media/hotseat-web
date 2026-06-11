/**
 * Retiring a page type must NOT brick a workspace whose history still holds that type's
 * events. A registry that no longer declares a type folds its instances as ABSENT (their
 * creation + later content/structural events skip), so the rest of the workspace projects
 * normally. The boot race is preserved: an unknown type in an EMPTY registry still throws,
 * so "models not loaded yet" halts + retries rather than silently dropping every page.
 */
import { beforeAll, describe, expect, it } from "vitest";

import type { IEventEnvelope, IWiki, IWorkspaceHandle, PageId } from "../src/api";
import { Registry } from "../src/core/registry";
import { foldWorkspace } from "../src/core/workspace";
import { FeatureBrief, ImplementationPlan, TestingPlan, FeatureSpec } from "wiki-models/feature";
import { createTestWiki, type ITestWiki } from "../src/testing";

describe("retired page type: folded as absent, never bricks the fold", () => {
  let tw: ITestWiki;
  let ws: IWorkspaceHandle;
  let history: readonly IEventEnvelope[];
  let testPlanId: PageId;

  beforeAll(async () => {
    tw = await createTestWiki([FeatureBrief, ImplementationPlan, TestingPlan, FeatureSpec]);
    const wiki: IWiki = tw.wiki;
    ws = await wiki.createWorkspace({ name: "Retire" });
    const c = await ws.createPage("feature-brief", { title: "Bulk export", parentId: null });
    const kids = await (await ws.page(c.value, { consistentWith: c.token })).children();
    const plan = kids.find((k) => k.type === "implementation-plan")!.id;
    testPlanId = kids.find((k) => k.type === "testing-plan")!.id;

    // Author some content on the about-to-be-retired type so its content events are in history too.
    await ws.mutate(c.value, "beginPlanning", {});
    await ws.mutate(plan, "addStep", { text: "stream it" });
    const last = await ws.mutate(testPlanId, "addCase", { text: "10k rows < 2s" });
    history = await ws.history({ consistentWith: last.token });
  });

  it("a registry MISSING a type skips that type's pages but folds the rest", () => {
    // testing-plan retired (the other three still declared).
    const partial = new Registry([FeatureBrief, ImplementationPlan, FeatureSpec]);
    const state = foldWorkspace(history, partial);

    const types = [...state.pages.values()].map((p) => p.type);
    expect(types).toContain("feature-brief");
    expect(types).toContain("implementation-plan");
    expect(types).toContain("feature-spec");
    // The retired type's instance is absent — not a poison pill.
    expect(types).not.toContain("testing-plan");
    expect(state.pages.has(testPlanId)).toBe(false);

    // And the parent's child list no longer dangles a pointer to the skipped page.
    const briefId = [...state.pages.values()].find((p) => p.type === "feature-brief")!.id;
    expect(state.children.get(briefId)).not.toContain(testPlanId);

    // The skip is EXPOSED on the state: "absent because unfoldable" is distinguishable
    // from "deleted", so derived-artifact consumers (the Markdown mirror) never destroy.
    expect(state.retired.has(testPlanId)).toBe(true);
  });

  it("an EMPTY registry still THROWS (boot race: models not loaded yet → halt + retry)", () => {
    expect(() => foldWorkspace(history, new Registry([]))).toThrow();
  });

  it("the full registry folds every page (the retired-skip is scoped to missing types only)", () => {
    const full = new Registry([FeatureBrief, ImplementationPlan, TestingPlan, FeatureSpec]);
    const state = foldWorkspace(history, full);
    expect(state.pages.has(testPlanId)).toBe(true);
    expect(state.retired.size).toBe(0);
  });
});
