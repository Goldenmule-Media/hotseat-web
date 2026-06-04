/**
 * The checklist's "Plan steps" view is DERIVED from the implementation-plan's steps
 * (feature-review.md Item 2) — not a hand-duplicated copy. The plan owns the step list
 * (the canonical breakdown); the checklist stores only per-step done progress. So
 * adding/removing/editing a plan step flows through to the checklist automatically, and
 * progress is tracked locally without duplicating the step text.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IWiki, IWorkspaceHandle, PageId } from "../src/api";
import { featurePageTypes } from "wiki-models/feature";
import { createTestWiki, type ITestWiki } from "../src/testing";

describe("implementation-checklist: Plan steps are a derived view of the plan", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;
  let plan: PageId;
  let checklist: PageId;
  let s1: string;
  let s2: string;

  /** The "Plan steps" block of the rendered checklist (heading stripped, trimmed). */
  async function planStepsBlock(): Promise<string> {
    const md = await ws.toMarkdown(checklist);
    const start = md.indexOf("## Plan steps\n");
    if (start < 0) return "";
    const after = md.slice(start + "## Plan steps\n".length);
    const end = after.indexOf("\n## ");
    return (end < 0 ? after : after.slice(0, end)).trimEnd();
  }

  beforeAll(async () => {
    harness = await createTestWiki(featurePageTypes);
    wiki = harness.wiki;
    ws = await wiki.createWorkspace({ name: "Derived" });
    const c = await ws.createPage("feature-brief", { title: "Bulk export", parentId: null });
    const children = await (await ws.page(c.value, { consistentWith: c.token })).children();
    plan = children.find((ch) => ch.type === "implementation-plan")!.id;
    checklist = children.find((ch) => ch.type === "implementation-checklist")!.id;
    s1 = ((await ws.mutate(plan, "addStep", { text: "Stream the /export endpoint" })).value as { stepId: string }).stepId;
    s2 = ((await ws.mutate(plan, "addStep", { text: "Add the CLI wrapper" })).value as { stepId: string }).stepId;
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("projects every plan step onto the checklist, unchecked, in plan order", async () => {
    const block = await planStepsBlock();
    expect(await planStepsBlock()).toBe(block); // deterministic
    expect(block).toBe("- [ ] Stream the /export endpoint\n- [ ] Add the CLI wrapper");
  });

  it("checks/unchecks a derived step via local progress (no step text stored on the checklist)", async () => {
    await ws.mutate(checklist, "markStepDone", { stepId: s1 });
    expect(await planStepsBlock()).toBe("- [x] Stream the /export endpoint\n- [ ] Add the CLI wrapper");
    // Idempotent — marking done again is a no-op, not a duplicate.
    await ws.mutate(checklist, "markStepDone", { stepId: s1 });
    expect(await planStepsBlock()).toBe("- [x] Stream the /export endpoint\n- [ ] Add the CLI wrapper");
    await ws.mutate(checklist, "markStepTodo", { stepId: s1 });
    expect(await planStepsBlock()).toBe("- [ ] Stream the /export endpoint\n- [ ] Add the CLI wrapper");
  });

  it("reflects plan edits automatically — DERIVED, not a one-time snapshot", async () => {
    // A new plan step appears on the checklist with no write to the checklist at all.
    await ws.mutate(plan, "addStep", { text: "Docs + changelog" });
    expect(await planStepsBlock()).toBe(
      "- [ ] Stream the /export endpoint\n- [ ] Add the CLI wrapper\n- [ ] Docs + changelog",
    );
    // Removing a plan step drops it from the checklist view too.
    await ws.mutate(plan, "removeStep", { stepId: s2 });
    expect(await planStepsBlock()).toBe(
      "- [ ] Stream the /export endpoint\n- [ ] Docs + changelog",
    );
  });
});
