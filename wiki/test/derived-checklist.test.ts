/**
 * The checklist's "Plan steps" view is DERIVED from the implementation-plan's steps
 * — not a hand-duplicated copy. The plan owns BOTH the step list
 * (the canonical breakdown) AND each step's done-state; the checklist stores no step state at
 * all. So adding/removing/editing a plan step — and marking one done — flows through to the
 * checklist automatically, and `markComplete` on the checklist can never freeze progress.
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

  it("checks/unchecks a derived step via the plan step's own status (the checklist stores no step state)", async () => {
    // Done-state is recorded on the PLAN step (an element-FSM transition), not on the checklist.
    await ws.mutate(plan, "markStepDone", { stepId: s1 });
    expect(await planStepsBlock()).toBe("- [x] Stream the /export endpoint\n- [ ] Add the CLI wrapper");
    // Reopening the step (markStepTodo) flips the derived box back. Done-ness moves through the
    // FSM, like the testing-plan's markCasePassed — never a duplicated flag on the checklist.
    await ws.mutate(plan, "markStepTodo", { stepId: s1 });
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
