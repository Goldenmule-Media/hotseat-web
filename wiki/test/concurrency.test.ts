/**
 * Concurrency / rebase-and-retry integration test (DESIGN §15; BUILD_NOTES §9).
 *
 * Two INDEPENDENT wiki instances are bound to the SAME server url + namespace
 * (via `wikiOn`), each opening the SAME workspace → two separate in-memory
 * projections that can hold a stale head relative to one another. This exercises
 * the REAL Durable-Streams optimistic-concurrency path: a stale append returns
 * HTTP 409 → `StaleAppendError` → the bus reads the tail, folds it, re-runs the
 * command's guard + `produces`, and retries.
 *
 *  - Different-page commands issued from the same stale head BOTH land (the loser
 *    rebases over the winner's unrelated event and its command is still valid).
 *  - The SAME mutation raced twice (answer one question) — the loser's rebase
 *    re-checks the item FSM, sees the question already `resolved`, and correctly
 *    fails with `MutationNotAllowedError` (concurrency never bypasses the FSM).
 *
 * Determinism note: each handle also runs a live tail that may fold the peer's
 * events asynchronously. The assertions hold regardless of tail timing — whether
 * the loser learns of the winner's event via 409-rebase or via the tail, the
 * outcome (both land / second answer rejected) is the same.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DeepReadonly, IEventEnvelope, IField, IItem, IWiki, IWorkspaceHandle, PageId, PageState, SectionOp, WorkspaceId } from "../src/api";
import { MutationNotAllowedError } from "../src/core/errors";
import { featurePageTypes } from "wiki-models/feature";
import { startTestServer, wikiOn, type ITestServer } from "../src/testing";

function elements(state: DeepReadonly<PageState>, sectionKey: string, field = "items"): readonly DeepReadonly<IItem>[] {
  const f = state.sections.find((s) => s.key === sectionKey)?.fields[field] as DeepReadonly<IField> | undefined;
  return f !== undefined && f.kind === "list" ? f.elements : [];
}
/** Count content commits that emitted a given op kind / transition event. */
function countOps(events: readonly IEventEnvelope[], pred: (op: SectionOp) => boolean): number {
  let n = 0;
  for (const e of events) {
    if (e.type !== "SectionOpsApplied") continue;
    const ops = (e.payload as { ops: SectionOp[] }).ops;
    if (ops.some(pred)) n += 1;
  }
  return n;
}

describe("concurrency: two handles on one workspace", () => {
  let serverHandle: ITestServer;
  let wikiA: IWiki;
  let wikiB: IWiki;
  /** A third, never-mutated wiki used to fold the AUTHORITATIVE log from scratch. */
  let wikiC: IWiki;
  let wsId: WorkspaceId;

  beforeEach(async () => {
    serverHandle = await startTestServer();
    // Three wikis, same server + (default) namespace "test" → same physical streams.
    // Independent deterministic id/clock counters per wiki (collisions across
    // wikis are harmless: ids only need to be unique within a page's item list).
    wikiA = wikiOn(serverHandle.url, featurePageTypes);
    wikiB = wikiOn(serverHandle.url, featurePageTypes);
    wikiC = wikiOn(serverHandle.url, featurePageTypes);
  });

  afterEach(async () => {
    await wikiA.close();
    await wikiB.close();
    await wikiC.close();
    await serverHandle.stop();
  });

  it("lands different-page commands from a stale head via rebase-and-retry", async () => {
    // wikiA seeds a workspace with a feature-brief (→ plan, checklist, testing-plan).
    const a = await wikiA.createWorkspace({ name: "shared" });
    wsId = a.id;
    const { value: brief, token: briefToken } = await a.createPage("feature-brief", {
      title: "Export",
      parentId: null,
    });
    const aBriefView = await a.page(brief, { consistentWith: briefToken });
    const [plan, , testPlan] = (await aBriefView.children()).map((c) => c.id);

    // wikiB opens the SAME workspace and folds the same head.
    const b = await wikiB.openWorkspace(wsId);

    const headA = (await a.history()).length;
    const headB = (await b.history()).length;
    expect(headA).toBe(headB);

    // Both writers act from the same folded head, concurrently, on DIFFERENT pages:
    //   A adds a plan step; B adds a testing-plan case.
    // One append wins; the other gets a 409 and rebases over the winner's
    // unrelated event — its command is still valid → it lands on retry.
    const [stepRes, caseRes] = await Promise.all([
      a.mutate(plan, "addStep", { text: "stream the export" }),
      b.mutate(testPlan, "addCase", { text: "10k rows < 2s" }),
    ]);

    expect((stepRes.value as { stepId: string }).stepId).toBeTruthy();
    expect((caseRes.value as { caseId: string }).caseId).toBeTruthy();

    // BOTH events landed in the single shared stream: the authoritative log read
    // from a fresh handle (folded from zero, so already current) shows the step
    // AND the case.
    const fresh = await wikiC.openWorkspace(wsId);
    const history = await fresh.history();
    expect(countOps(history, (op) => op.op === "addElement" && op.section === "steps")).toBe(1);
    expect(countOps(history, (op) => op.op === "addElement" && op.section === "cases")).toBe(1);

    // Versions are contiguous (no gap, no duplicate) — the two appends serialized
    // cleanly behind OCC.
    const versions = (await fresh.history()).map((e) => e.version);
    expect(versions).toEqual(versions.map((_, i) => i));

    // The freshly-folded state carries both children's list elements.
    expect(elements(await (await fresh.page(plan)).state(), "steps")).toHaveLength(1);
    expect(elements(await (await fresh.page(testPlan)).state(), "cases")).toHaveLength(1);
  });

  it("rejects the second answer to the SAME question with MutationNotAllowedError after rebase", async () => {
    const a = await wikiA.createWorkspace({ name: "shared" });
    wsId = a.id;
    const { value: brief } = await a.createPage("feature-brief", {
      title: "Export",
      parentId: null,
    });

    // One open question on the brief.
    const { value: askResult, token: askToken } = await a.mutate(brief, "askQuestion", {
      text: "Which formats?",
    });
    const { questionId } = askResult as { questionId: string };

    // wikiB opens the workspace while the question is still OPEN on both projections.
    const b = await wikiB.openWorkspace(wsId);
    // Gate B's read on A's ask token so B has definitely tailed the question into
    // its projection before we assert its open status.
    const bView = await b.page(brief, { consistentWith: askToken });
    expect(
      elements(await bView.state(), "questions").find((q) => q.id === questionId)?.status,
    ).toBe("open");

    // Race the SAME item-level mutation from both handles. The first wins and
    // resolves the question; the loser's rebase (or live tail) re-checks the
    // `question` FSM, sees `resolved`, and rejects `answerQuestion`.
    const results = await Promise.allSettled([
      a.mutate(brief, "answerQuestion", { questionId, answer: "CSV/JSON" }),
      b.mutate(brief, "answerQuestion", { questionId, answer: "Parquet" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );

    // Exactly one succeeds; exactly one is rejected.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The rejection is the typed FSM error — not a raw ConcurrencyError, not a
    // generic Error. The loser's command was re-validated against fresh state.
    const error = rejected[0]?.reason;
    expect(error).toBeInstanceOf(MutationNotAllowedError);
    expect((error as MutationNotAllowedError).command).toBe("answerQuestion");

    // The question is resolved exactly once in the authoritative log: one
    // QuestionAnswered event total.
    const fresh = await wikiC.openWorkspace(wsId);
    const answered = countOps(await fresh.history(), (op) => op.op === "transition" && op.level === "element" && op.event === "answer");
    expect(answered).toBe(1);
    expect(
      elements(await (await fresh.page(brief)).state(), "questions").find((q) => q.id === questionId)
        ?.status,
    ).toBe("resolved");
  });

  it("two writers serialize cleanly without gaps even when both rebase repeatedly", async () => {
    const a = await wikiA.createWorkspace({ name: "shared" });
    wsId = a.id;
    const { value: brief, token: briefToken } = await a.createPage("feature-brief", {
      title: "Export",
      parentId: null,
    });
    const aBriefView = await a.page(brief, { consistentWith: briefToken });
    const checklist = (await aBriefView.children()).find(
      (c) => c.type === "implementation-checklist",
    )!.id as PageId;

    await a.mutate(brief, "beginPlanning", {});

    const b = await wikiB.openWorkspace(wsId);

    // Interleave several different-page writes from both handles concurrently.
    await Promise.all([
      a.mutate(brief, "addConstraint", { text: "constraint one" }),
      b.mutate(checklist, "addTask", { text: "task one" }),
      a.mutate(brief, "askQuestion", { text: "q one" }),
      b.mutate(checklist, "addTask", { text: "task two" }),
    ]);

    const fresh = await wikiC.openWorkspace(wsId);
    const versions = (await fresh.history()).map((e) => e.version);
    // Contiguous 0..N-1: OCC + rebase produced a clean, gap-free, dup-free log.
    expect(versions).toEqual(versions.map((_, i) => i));

    // All four content mutations are represented exactly once (each is one
    // SectionOpsApplied carrying an addElement into the relevant section).
    const history = await fresh.history();
    expect(countOps(history, (op) => op.op === "addElement" && op.section === "constraints")).toBe(1);
    expect(countOps(history, (op) => op.op === "addElement" && op.section === "questions")).toBe(1);
    expect(countOps(history, (op) => op.op === "addElement" && op.section === "tasks")).toBe(2);
  });
});
