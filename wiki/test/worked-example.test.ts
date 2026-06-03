/**
 * Worked-example integration test (DESIGN §13.3 / §13.5; BUILD_NOTES §9).
 *
 * Drives the FULL motivating session end-to-end against a real (in-memory)
 * DurableStreamTestServer via `createTestWiki(featurePageTypes)`:
 *   - create a `feature-brief` → its three mandated children appear ATOMICALLY,
 *   - fill the brief (summary / components / constraints / Q&A),
 *   - `beginImplementation` is BLOCKED (InvariantViolationError) until the plan
 *     has ≥1 step AND the testing-plan has ≥1 case,
 *   - an atomic cross-page `moveItem` relocates a question brief→plan,
 *   - building: tasks / commits / case pass,
 *   - `ship` is BLOCKED until the checklist is 100% done, every case passed, and
 *     there are zero open questions on the brief — then it succeeds,
 *   - finally assert the workspace tree and a byte-stable Markdown of the brief.
 *
 * Assertions are meaningful: the gate failures are asserted to throw the typed
 * `InvariantViolationError` (not merely "some error"), and the final Markdown is
 * pinned to its exact bytes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DeepReadonly, IItem, IField, IWiki, IWorkspaceHandle, PageState, PageId } from "../src/api";
import { PreconditionUnmetError } from "../src/core/errors";
import { featurePageTypes } from "wiki-models/feature";
import { createTestWiki, type ITestWiki } from "../src/testing";

/** Extract the elements of a `(section, field=items)` list from a page state. */
function elements(state: DeepReadonly<PageState>, sectionKey: string, field = "items"): readonly DeepReadonly<IItem>[] {
  const sec = state.sections.find((s) => s.key === sectionKey);
  const f = sec?.fields[field] as DeepReadonly<IField> | undefined;
  return f !== undefined && f.kind === "list" ? f.elements : [];
}
function fieldValue(state: DeepReadonly<PageState>, sectionKey: string, field: string): unknown {
  const f = state.sections.find((s) => s.key === sectionKey)?.fields[field] as DeepReadonly<IField> | undefined;
  if (f === undefined) return undefined;
  if (f.kind === "prose" || f.kind === "scalar") return f.value;
  return undefined;
}
function elFieldValue(el: DeepReadonly<IItem>, key: string): unknown {
  const f = el.fields[key] as DeepReadonly<IField> | undefined;
  if (f !== undefined && (f.kind === "prose" || f.kind === "scalar")) return f.value;
  return undefined;
}

describe("worked example: plan → build → ship a feature", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;

  // Page ids captured as the session unfolds.
  let rbac: PageId;
  let brief: PageId;
  let plan: PageId;
  let checklist: PageId;
  let testPlan: PageId;

  // Item ids captured from command results.
  let q1: string;
  let q2: string;
  let c1: string;
  let t1: string;
  let t2: string;
  let t3: string;

  beforeAll(async () => {
    harness = await createTestWiki(featurePageTypes);
    wiki = harness.wiki;
    ws = await wiki.createWorkspace({ name: "Acme platform" });
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("creates a feature-brief whose 3 mandated children appear atomically", async () => {
    // A reference target for the brief's "depends-on" link (also a feature-brief,
    // so it pulls in its own 3 children — but those live under IT, not the brief).
    const rbacCommit = await ws.createPage("feature-brief", {
      title: "Access control (RBAC)",
      parentId: null,
    });
    rbac = rbacCommit.value;

    // The history length right after creating one feature-brief: it must have
    // emitted exactly 4 PageCreated events (brief + 3 children) in ONE commit.
    // Gate on the RBAC token so the "before" count is read-your-writes consistent.
    const beforeBrief = (await ws.history({ consistentWith: rbacCommit.token })).length;
    const briefCommit = await ws.createPage("feature-brief", {
      title: "Bulk export",
      parentId: null,
    });
    brief = briefCommit.value;
    const briefToken = briefCommit.token;
    const afterBrief = (await ws.history({ consistentWith: briefToken })).length;
    expect(afterBrief - beforeBrief).toBe(4);

    // The 4 PageCreated events of THIS brief share a single commit version run and
    // a single occurredAt (one atomic append → one envelope meta timestamp).
    const created = (await ws.history({ consistentWith: briefToken }))
      .slice(beforeBrief)
      .filter((e) => e.type === "PageCreated");
    expect(created).toHaveLength(4);
    expect(new Set(created.map((e) => e.meta.occurredAt)).size).toBe(1);
    expect(created.map((e) => (e.payload as { type: string }).type)).toEqual([
      "feature-brief",
      "implementation-plan",
      "implementation-checklist",
      "testing-plan",
    ]);

    // The brief now has exactly its 3 pinned children, in requiredChildren order.
    const briefView = await ws.page(brief, { consistentWith: briefToken });
    const children = await briefView.children();
    expect(children.map((c) => c.type)).toEqual([
      "implementation-plan",
      "implementation-checklist",
      "testing-plan",
    ]);
    [plan, checklist, testPlan] = children.map((c) => c.id);

    // Tree assertion: @root → [RBAC, Bulk export]; Bulk export → its 3 children.
    const tree = await ws.tree({ consistentWith: briefToken });
    expect(tree.id).toBe("@root");
    expect(tree.children.map((c) => c.title)).toEqual([
      "Access control (RBAC)",
      "Bulk export",
    ]);
    const briefNode = tree.children.find((c) => c.id === brief);
    expect(briefNode?.children.map((c) => ({ type: c.type, status: c.status }))).toEqual([
      { type: "implementation-plan", status: "draft" },
      { type: "implementation-checklist", status: "building" },
      { type: "testing-plan", status: "draft" },
    ]);
  });

  it("fills the brief (summary / components / constraints / Q&A) and links a reference", async () => {
    await ws.mutate(brief, "setSummary", {
      text: "Let users export their workspace as CSV/JSON.",
    });
    await ws.mutate(brief, "addComponent", { name: "web-app" });
    await ws.mutate(brief, "addComponent", { name: "cli" });
    await ws.mutate(brief, "addConstraint", {
      text: "Export must stream; never buffer >50MB in memory.",
    });

    const ask1 = (await ws.mutate(brief, "askQuestion", {
      text: "Which formats in v1?",
    })).value as { questionId: string };
    q1 = ask1.questionId;
    await ws.mutate(brief, "answerQuestion", {
      questionId: q1,
      answer: "CSV and JSON; Parquet later.",
    });

    const { token: linkToken } = await ws.link(brief, rbac, "depends-on");

    const state = await (await ws.page(brief, { consistentWith: linkToken })).state();
    expect(fieldValue(state, "summary", "body")).toBe("Let users export their workspace as CSV/JSON.");
    expect(elements(state, "components").map((c) => elFieldValue(c, "name"))).toEqual(["web-app", "cli"]);
    expect(elements(state, "constraints").map((c) => elFieldValue(c, "text"))).toEqual([
      "Export must stream; never buffer >50MB in memory.",
    ]);
    const resolved = elements(state, "questions").filter((q) => q.status === "resolved");
    expect(resolved).toHaveLength(1);
    expect(elFieldValue(resolved[0]!, "answer")).toBe("CSV and JSON; Parquet later.");
  });

  it("blocks beginImplementation (InvariantViolationError) until plan ≥1 step AND testing-plan ≥1 case", async () => {
    const { token: planningToken } = await ws.mutate(brief, "beginPlanning", {});
    expect(await (await ws.page(brief, { consistentWith: planningToken })).status()).toBe(
      "planning",
    );

    // No plan steps, no test cases yet → gate fails.
    await expect(ws.mutate(brief, "beginImplementation", {})).rejects.toBeInstanceOf(
      PreconditionUnmetError,
    );

    // Add ONE plan step — still missing a test case → gate still fails.
    await ws.mutate(plan, "addStep", {
      text: "Stream a ReadableStream from a new /export endpoint.",
    });
    await expect(ws.mutate(brief, "beginImplementation", {})).rejects.toBeInstanceOf(
      PreconditionUnmetError,
    );

    // Add the second step and a test case — now both halves of the gate pass.
    await ws.mutate(plan, "addStep", { text: "Add `wiki export` CLI wrapping the endpoint." });
    const addCase = await ws.mutate(testPlan, "addCase", {
      text: "10k-row export < 2s, memory flat.",
    });
    c1 = (addCase.value as { caseId: string }).caseId;

    // The brief is still in planning (the failed attempts did not transition it).
    expect(await (await ws.page(brief, { consistentWith: addCase.token })).status()).toBe(
      "planning",
    );
  });

  it("performs an atomic cross-page moveItem of a question from the brief to the plan", async () => {
    const ask2 = await ws.mutate(brief, "askQuestion", {
      text: "Page size while streaming?",
    });
    q2 = (ask2.value as { questionId: string }).questionId;

    // Brief currently owns BOTH questions (q1 resolved, q2 open).
    const briefBeforeMove = await ws.page(brief, { consistentWith: ask2.token });
    expect(elements(await briefBeforeMove.state(), "questions").map((q) => q.id).sort()).toEqual(
      [q1, q2].sort(),
    );

    const beforeMove = (await ws.history({ consistentWith: ask2.token })).length;
    const moveCommit = await ws.moveItem({ from: brief, to: plan, section: "questions", field: "items", itemId: q2 });
    const moveEvents = (await ws.history({ consistentWith: moveCommit.token })).slice(beforeMove);

    // Atomic: two SectionOpsApplied (remove from brief, add to plan), in ONE commit.
    expect(moveEvents.map((e) => e.type)).toEqual(["SectionOpsApplied", "SectionOpsApplied"]);
    expect(moveEvents[0]?.pageId).toBe(brief);
    expect(moveEvents[1]?.pageId).toBe(plan);
    expect(new Set(moveEvents.map((e) => e.meta.occurredAt)).size).toBe(1);

    // Brief no longer owns q2; the plan now does (status preserved as "open").
    const briefQuestions = elements(await (await ws.page(brief, { consistentWith: moveCommit.token })).state(), "questions");
    expect(briefQuestions.map((q) => q.id)).toEqual([q1]);
    const planQuestions = elements(await (await ws.page(plan, { consistentWith: moveCommit.token })).state(), "questions");
    expect(planQuestions.map((q) => q.id)).toEqual([q2]);
    expect(planQuestions[0]?.status).toBe("open");
  });

  it("drives building: beginImplementation succeeds, then tasks / commits / case pass", async () => {
    const beginImpl = await ws.mutate(brief, "beginImplementation", {});
    expect(await (await ws.page(brief, { consistentWith: beginImpl.token })).status()).toBe(
      "building",
    );

    const a1 = (await ws.mutate(checklist, "addTask", {
      text: "Streaming /export endpoint",
    })).value as { taskId: string };
    t1 = a1.taskId;
    const a2 = (await ws.mutate(checklist, "addTask", {
      text: "`wiki export` CLI",
    })).value as { taskId: string };
    t2 = a2.taskId;
    const a3 = (await ws.mutate(checklist, "addTask", {
      text: "Docs + changelog",
    })).value as { taskId: string };
    t3 = a3.taskId;

    await ws.mutate(brief, "recordCommit", {
      sha: "a1b2c3d",
      message: "feat(api): streaming export endpoint",
    });
    await ws.mutate(checklist, "checkTask", { taskId: t1 });
    await ws.mutate(brief, "recordCommit", {
      sha: "e4f5g6h",
      message: "feat(cli): wiki export",
    });
    await ws.mutate(checklist, "checkTask", { taskId: t2 });
    const passedCommit = await ws.mutate(testPlan, "markCasePassed", { caseId: c1 });

    // Two tasks done, one still todo; the single case passed.
    const tasks = elements(await (await ws.page(checklist, { consistentWith: passedCommit.token })).state(), "tasks");
    expect(tasks.filter((t) => t.status === "done").map((t) => t.id).sort()).toEqual(
      [t1, t2].sort(),
    );
    expect(tasks.find((t) => t.id === t3)?.status).toBe("todo");
    expect(
      elements(await (await ws.page(testPlan, { consistentWith: passedCommit.token })).state(), "cases").find(
        (c) => c.id === c1,
      )?.status,
    ).toBe("passed");
  });

  it("blocks ship until checklist 100% done + all cases passed + no open questions, then succeeds", async () => {
    const reviewCommit = await ws.mutate(brief, "submitForReview", {});
    expect(await (await ws.page(brief, { consistentWith: reviewCommit.token })).status()).toBe(
      "review",
    );

    // t3 still todo → checklist not 100% done → ship is gated.
    await expect(ws.mutate(brief, "ship", {})).rejects.toBeInstanceOf(PreconditionUnmetError);

    // Finish the last task, but markComplete is NOT required by the gate — the gate
    // checks task statuses directly. Completing it should now satisfy the checklist.
    await ws.mutate(checklist, "checkTask", { taskId: t3 });

    // All gates satisfied now (3/3 done, 1/1 passed, 0 open questions on brief).
    const shipCommit = await ws.mutate(brief, "ship", {});
    expect(await (await ws.page(brief, { consistentWith: shipCommit.token })).status()).toBe(
      "shipped",
    );
  });

  it("renders a byte-stable Markdown of the brief and a final tree", async () => {
    const md = await ws.toMarkdown(brief);

    // Determinism: re-rendering identical state yields identical bytes.
    expect(await ws.toMarkdown(brief)).toBe(md);

    // The brief shipped, so its status badge reads "shipped"; q2 lives on the plan
    // now, so Open questions is empty; q1 is the lone resolved question. Per
    // DESIGN §13.5 each section heading is immediately followed by its body (no
    // blank line between them), and `joinBlocks` puts exactly one blank line
    // BETWEEN blocks (and a single trailing newline). The H1 and the status badge
    // are their own blocks; each `## section` block bundles its heading + body.
    const blocks = [
      "# Feature: Bulk export",
      "**Status:** shipped",
      "## Summary\nLet users export their workspace as CSV/JSON.",
      "## Components affected\n- web-app\n- cli",
      "## Design constraints\n1. Export must stream; never buffer >50MB in memory.",
      "## Open questions\n_None._",
      "## Resolved questions\n- **Which formats in v1?** → CSV and JSON; Parquet later.",
      "## References\n- depends-on → Access control (RBAC)",
      "## Child pages\n- implementation-plan\n- implementation-checklist\n- testing-plan",
      "## Commits\n- `a1b2c3d` feat(api): streaming export endpoint\n- `e4f5g6h` feat(cli): wiki export",
    ];
    const expected = blocks.join("\n\n") + "\n";

    expect(md).toBe(expected);

    // Final tree: the brief and its 3 children, with terminal/derived statuses.
    const briefNode = (await ws.tree()).children.find((c) => c.id === brief);
    expect(briefNode?.status).toBe("shipped");
    expect(
      briefNode?.children.map((c) => ({ type: c.type, status: c.status })),
    ).toEqual([
      { type: "implementation-plan", status: "draft" },
      { type: "implementation-checklist", status: "building" },
      { type: "testing-plan", status: "draft" },
    ]);
  });
});
