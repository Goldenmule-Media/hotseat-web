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

import type { IWiki, IWorkspaceHandle, PageId } from "../src/api";
import { InvariantViolationError } from "../src/core/errors";
import { featurePageTypes } from "../src/pages/feature";
import { createTestWiki, type ITestWiki } from "../src/testing";

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
    rbac = await ws.createPage("feature-brief", {
      title: "Access control (RBAC)",
      parentId: null,
    });

    // The history length right after creating one feature-brief: it must have
    // emitted exactly 4 PageCreated events (brief + 3 children) in ONE commit.
    const beforeBrief = ws.history().length;
    brief = await ws.createPage("feature-brief", { title: "Bulk export", parentId: null });
    const afterBrief = ws.history().length;
    expect(afterBrief - beforeBrief).toBe(4);

    // The 4 PageCreated events of THIS brief share a single commit version run and
    // a single occurredAt (one atomic append → one envelope meta timestamp).
    const created = ws
      .history()
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
    const children = ws.page(brief).children();
    expect(children.map((c) => c.type)).toEqual([
      "implementation-plan",
      "implementation-checklist",
      "testing-plan",
    ]);
    [plan, checklist, testPlan] = children.map((c) => c.id);

    // Tree assertion: @root → [RBAC, Bulk export]; Bulk export → its 3 children.
    const tree = ws.tree();
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
    })) as { questionId: string };
    q1 = ask1.questionId;
    await ws.mutate(brief, "answerQuestion", {
      questionId: q1,
      answer: "CSV and JSON; Parquet later.",
    });

    await ws.link(brief, rbac, "depends-on");

    const state = ws.page(brief).state();
    expect(state.fields).toEqual({ summary: "Let users export their workspace as CSV/JSON." });
    expect(state.items.component.map((c) => c.name)).toEqual(["web-app", "cli"]);
    expect(state.items.constraint.map((c) => c.text)).toEqual([
      "Export must stream; never buffer >50MB in memory.",
    ]);
    const resolved = state.items.question.filter((q) => q.status === "resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.answer).toBe("CSV and JSON; Parquet later.");
  });

  it("blocks beginImplementation (InvariantViolationError) until plan ≥1 step AND testing-plan ≥1 case", async () => {
    await ws.mutate(brief, "beginPlanning", {});
    expect(ws.page(brief).status()).toBe("planning");

    // No plan steps, no test cases yet → gate fails.
    await expect(ws.mutate(brief, "beginImplementation", {})).rejects.toBeInstanceOf(
      InvariantViolationError,
    );

    // Add ONE plan step — still missing a test case → gate still fails.
    await ws.mutate(plan, "addStep", {
      text: "Stream a ReadableStream from a new /export endpoint.",
    });
    await expect(ws.mutate(brief, "beginImplementation", {})).rejects.toBeInstanceOf(
      InvariantViolationError,
    );

    // Add the second step and a test case — now both halves of the gate pass.
    await ws.mutate(plan, "addStep", { text: "Add `wiki export` CLI wrapping the endpoint." });
    const addCase = (await ws.mutate(testPlan, "addCase", {
      text: "10k-row export < 2s, memory flat.",
    })) as { caseId: string };
    c1 = addCase.caseId;

    // The brief is still in planning (the failed attempts did not transition it).
    expect(ws.page(brief).status()).toBe("planning");
  });

  it("performs an atomic cross-page moveItem of a question from the brief to the plan", async () => {
    const ask2 = (await ws.mutate(brief, "askQuestion", {
      text: "Page size while streaming?",
    })) as { questionId: string };
    q2 = ask2.questionId;

    // Brief currently owns BOTH questions (q1 resolved, q2 open).
    expect(ws.page(brief).state().items.question.map((q) => q.id).sort()).toEqual(
      [q1, q2].sort(),
    );

    const beforeMove = ws.history().length;
    await ws.moveItem({ from: brief, to: plan, itemType: "question", itemId: q2 });
    const moveEvents = ws.history().slice(beforeMove);

    // Atomic: exactly one ItemRemoved (from brief) + one ItemAdded (to plan), in
    // ONE commit (single occurredAt), or neither.
    expect(moveEvents.map((e) => e.type)).toEqual(["ItemRemoved", "ItemAdded"]);
    expect(moveEvents[0]?.pageId).toBe(brief);
    expect(moveEvents[1]?.pageId).toBe(plan);
    expect(new Set(moveEvents.map((e) => e.meta.occurredAt)).size).toBe(1);

    // Brief no longer owns q2; the plan now does (status preserved as "open").
    const briefQuestions = ws.page(brief).state().items.question;
    expect(briefQuestions.map((q) => q.id)).toEqual([q1]);
    const planQuestions = ws.page(plan).state().items.question;
    expect(planQuestions.map((q) => q.id)).toEqual([q2]);
    expect(planQuestions[0]?.status).toBe("open");
  });

  it("drives building: beginImplementation succeeds, then tasks / commits / case pass", async () => {
    await ws.mutate(brief, "beginImplementation", {});
    expect(ws.page(brief).status()).toBe("building");

    const a1 = (await ws.mutate(checklist, "addTask", {
      text: "Streaming /export endpoint",
    })) as { taskId: string };
    t1 = a1.taskId;
    const a2 = (await ws.mutate(checklist, "addTask", {
      text: "`wiki export` CLI",
    })) as { taskId: string };
    t2 = a2.taskId;
    const a3 = (await ws.mutate(checklist, "addTask", {
      text: "Docs + changelog",
    })) as { taskId: string };
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
    await ws.mutate(testPlan, "markCasePassed", { caseId: c1 });

    // Two tasks done, one still todo; the single case passed.
    const tasks = ws.page(checklist).state().items.task;
    expect(tasks.filter((t) => t.status === "done").map((t) => t.id).sort()).toEqual(
      [t1, t2].sort(),
    );
    expect(tasks.find((t) => t.id === t3)?.status).toBe("todo");
    expect(ws.page(testPlan).state().items.case.find((c) => c.id === c1)?.status).toBe(
      "passed",
    );
  });

  it("blocks ship until checklist 100% done + all cases passed + no open questions, then succeeds", async () => {
    await ws.mutate(brief, "submitForReview", {});
    expect(ws.page(brief).status()).toBe("review");

    // t3 still todo → checklist not 100% done → ship is gated.
    await expect(ws.mutate(brief, "ship", {})).rejects.toBeInstanceOf(InvariantViolationError);

    // Finish the last task, but markComplete is NOT required by the gate — the gate
    // checks task statuses directly. Completing it should now satisfy the checklist.
    await ws.mutate(checklist, "checkTask", { taskId: t3 });

    // All gates satisfied now (3/3 done, 1/1 passed, 0 open questions on brief).
    await ws.mutate(brief, "ship", {});
    expect(ws.page(brief).status()).toBe("shipped");
  });

  it("renders a byte-stable Markdown of the brief and a final tree", async () => {
    const md = ws.toMarkdown(brief);

    // Determinism: re-rendering identical state yields identical bytes.
    expect(ws.toMarkdown(brief)).toBe(md);

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
    const briefNode = ws.tree().children.find((c) => c.id === brief);
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
