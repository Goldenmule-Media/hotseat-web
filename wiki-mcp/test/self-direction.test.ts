/**
 * Self-direction surface (the "don't ask what's next" fix): the host rolls the engine's
 * model-declared classifiers up generically.
 *
 * Wires the REAL feature bundle (same rig as feature-data-model.test.ts) and asserts:
 *  1. Write tools echo a compact `next` summary; nextActions offers the first agent edge.
 *  2. nextActions partitions a review-state bundle — `ship` is a human gate (with its
 *     unmet reason), and a fresh bundle has NO human gates yet.
 *  3. The generic `attention` scan + nextActions surface an escalated, still-open question
 *     with ZERO element-type knowledge in the host (it goes through `awaitsHuman`).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DurableStreamTestServer } from "@durable-streams/server";
import featurePageTypes from "wiki-models/feature";

import { silentLogger } from "../src/logger.js";
import { EmbeddedEngine } from "../src/engine.js";
import { SqlReadModel } from "../src/readmodel/readmodel.js";
import { buildStore, migrateToLatest, type ReadModelStore } from "../src/readmodel/store.js";
import { ProjectionService } from "../src/tail/projection.js";
import { engineEventSource } from "../src/tail/engine-source.js";
import { SessionTokenManager } from "../src/mcp/tokens.js";
import { wikiTools, type WikiTool, type WikiToolContext } from "../src/mcp/tools.js";

function deterministicClock(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2020, 0, 1) + n++ * 1000).toISOString();
}
function deterministicIds(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

const NAMESPACE = "test";

interface ActionRef { pageId: string; pageType: string; command: string; reason?: string }
interface AttentionRef { pageId: string; itemId: string; sectionKey: string; field: string; status?: string }
interface NextSummary {
  do: ActionRef[];
  blocked: ActionRef[];
  humanGates: ActionRef[];
  attention: AttentionRef[];
}

describe("self-direction: nextActions roll-up + generic attention scan", () => {
  let server: DurableStreamTestServer;
  let url: string;
  let engine: EmbeddedEngine;
  let store: ReadModelStore;
  let readModel: SqlReadModel;
  let projection: ProjectionService;
  let tokens: SessionTokenManager;
  const tools = new Map<string, WikiTool>(wikiTools().map((tl) => [tl.name, tl]));

  beforeEach(async () => {
    server = new DurableStreamTestServer({ port: 0 });
    url = await server.start();
    engine = new EmbeddedEngine(
      { streamBaseUrl: url, namespace: NAMESPACE, pageTypes: featurePageTypes, clock: deterministicClock(), ids: deterministicIds(), readConsistencyTimeoutMs: 2000 },
      silentLogger,
    );
    store = buildStore({ kind: "pglite" });
    await migrateToLatest(store.db, silentLogger);
    readModel = new SqlReadModel(store.db, { defaultTimeoutMs: 2000, pollMs: 5 });
    projection = new ProjectionService(store.db, featurePageTypes, readModel, silentLogger);
    tokens = new SessionTokenManager();
  });
  afterEach(async () => {
    await engine.close();
    await store.close();
    await server.stop();
  });

  function ctx(sessionId: string | undefined): WikiToolContext {
    return { engine, readModel, tokens, sessionId };
  }
  const drain = (): Promise<void> => projection.drain(engineEventSource(engine));

  // ── helpers ────────────────────────────────────────────────────────────────
  const run = (name: string, args: Record<string, unknown>, session: string) => tools.get(name)!.handle(args, ctx(session));
  async function createBrief(session: string): Promise<{ wsId: string; briefId: string; created: { next?: NextSummary }; kids: Map<string, string> }> {
    const ws = (await run("createWorkspace", { name: "W" }, session)).data as { workspaceId: string };
    const briefRes = await run("createPage", { workspaceId: ws.workspaceId, type: "feature-brief", title: "F", parentId: null }, session);
    const briefId = (briefRes.data as { pageId: string }).pageId;
    const handle = await engine.open(ws.workspaceId as never);
    const children = await (await handle.page(briefId as never)).children();
    const kids = new Map(children.map((c) => [c.type, String(c.id)]));
    return { wsId: ws.workspaceId, briefId, created: briefRes.data as { next?: NextSummary }, kids };
  }
  const nextActions = async (wsId: string, pageId: string | null, session: string): Promise<NextSummary> =>
    (await run("nextActions", { workspaceId: wsId, pageId }, session)).data as NextSummary;

  it("createPage echoes a `next` hint, and nextActions offers the first agent edge (no human gates yet)", async () => {
    const session = "s1";
    const { wsId, briefId, created } = await createBrief(session);

    // The write tool echoes a single-page roll-up: beginPlanning is the brief's only forward edge.
    expect(created.next).toBeDefined();
    expect(created.next!.do).toHaveLength(1);
    expect(created.next!.do[0]).toMatchObject({ command: "beginPlanning", pageId: briefId });
    expect(created.next!.humanGates).toHaveLength(0); // ship/submitForReview aren't legal from draft

    await drain();
    const summary = await nextActions(wsId, briefId, session);
    // Regression (review finding): child finalize edges (markReady/markComplete/seal) must NOT
    // surface as `do` — they are cascade-driven by ship, not agent-driven. Surfacing them would
    // tell a self-directing agent to seal EMPTY children. The only ready action on a fresh
    // bundle is the brief's beginPlanning.
    expect(summary.do).toHaveLength(1);
    expect(summary.do[0]).toMatchObject({ command: "beginPlanning", pageId: briefId });
    expect(summary.do.concat(summary.blocked).some((a) => ["markReady", "markComplete", "seal"].includes(a.command))).toBe(false);
    expect(summary.blocked).toHaveLength(0);
    expect(summary.humanGates).toHaveLength(0);
  });

  it("partitions a review-state bundle: ship is a human gate with its unmet reason", async () => {
    const session = "s2";
    const { wsId, briefId, kids } = await createBrief(session);
    const plan = kids.get("implementation-plan")!;
    const checklist = kids.get("implementation-checklist")!;
    const testPlan = kids.get("testing-plan")!;

    const mut = (pageId: string, command: string, args: Record<string, unknown> = {}) =>
      run("mutatePage", { workspaceId: wsId, pageId, command, args }, session);

    await mut(briefId, "beginPlanning");
    await mut(plan, "addStep", { text: "do it" });
    await mut(plan, "addDataModel", { language: "ts", source: "interface X {}" });
    await mut(testPlan, "addCase", { text: "covers it" });
    await mut(briefId, "beginImplementation");
    await mut(checklist, "addTask", { text: "build" });
    const submitted = await mut(briefId, "submitForReview");

    // The mutatePage echo already reflects the new state: ship is now a human gate.
    const echo = (submitted.data as { next?: NextSummary }).next!;
    expect(echo.humanGates.some((a) => a.command === "ship" && a.reason !== undefined)).toBe(true);

    await drain();
    const summary = await nextActions(wsId, briefId, session);
    const ship = summary.humanGates.find((a) => a.command === "ship");
    expect(ship).toBeDefined();
    expect(ship!.pageId).toBe(briefId);
    expect(typeof ship!.reason).toBe("string"); // blocked: checklist/cases not done yet
    // The agent never auto-fires ship — it's not in `do`.
    expect(summary.do.some((a) => a.command === "ship")).toBe(false);
  });

  it("surfaces an escalated, still-open question generically — no element-type literal in the host", async () => {
    const session = "s3";
    const { wsId, briefId } = await createBrief(session);
    const ask = await run("mutatePage", { workspaceId: wsId, pageId: briefId, command: "askQuestion", args: { text: "ship date?", needsHuman: true } }, session);
    const qId = (ask.data as { result: { questionId: string } }).result.questionId;
    await drain();

    // Generic cross-workspace attention scan (the rewritten openQuestions) finds it.
    const att = (await run("attention", { workspaceId: wsId }, session)).data as Array<{ pageId: string; itemId: string; sectionKey: string }>;
    const hit = att.find((a) => a.itemId === qId);
    expect(hit).toBeDefined();
    expect(hit!.pageId).toBe(briefId);
    expect(hit!.sectionKey).toBe("questions");

    // nextActions rolls the same item into its `attention` bucket.
    const summary = await nextActions(wsId, briefId, session);
    expect(summary.attention.some((a) => a.itemId === qId)).toBe(true);

    // Answering it (open → resolved) drops it from attention.
    await run("mutatePage", { workspaceId: wsId, pageId: briefId, command: "answerQuestion", args: { questionId: qId, answer: "Q3" } }, session);
    await drain();
    const after = (await run("attention", { workspaceId: wsId }, session)).data as unknown[];
    expect(after).toHaveLength(0);
  });

  it("whole-workspace (null) scope reaches roots; archiving a page hides its subtree from the roll-up", async () => {
    const session = "s4";
    const { wsId, briefId } = await createBrief(session);
    await drain();

    // null pageId is the tool's default scope — it must reach top-level pages from the
    // `@root` sentinel (never emitting the sentinel itself).
    const whole = await nextActions(wsId, null, session);
    expect(whole.do).toHaveLength(1);
    expect(whole.do[0]).toMatchObject({ command: "beginPlanning", pageId: briefId });

    // Archiving the brief hides it AND its whole subtree → the roll-up offers nothing
    // (an archived page can't be mutated, so it must never appear).
    await run("archivePage", { workspaceId: wsId, pageId: briefId }, session);
    await drain();
    const hidden = await nextActions(wsId, null, session);
    expect(hidden.do.concat(hidden.blocked, hidden.humanGates)).toHaveLength(0);
    expect(hidden.attention).toHaveLength(0);
  });

  it("mutatePageBatch echoes a `next` summary and a human-readable text suffix", async () => {
    const session = "s5";
    const { wsId, briefId, kids } = await createBrief(session);
    const plan = kids.get("implementation-plan")!;
    const testPlan = kids.get("testing-plan")!;

    // One atomic batch that fills the planning gates, then a single-command batch fires
    // beginImplementation so the echo reflects a state change.
    await run("mutatePageBatch", {
      workspaceId: wsId,
      pageId: plan,
      commands: [
        { command: "addStep", args: { text: "do it" } },
        { command: "addDataModel", args: { language: "ts", source: "interface X {}" } },
      ],
    }, session);
    await run("mutatePage", { workspaceId: wsId, pageId: testPlan, command: "addCase", args: { text: "covers it" } }, session);
    await run("mutatePage", { workspaceId: wsId, pageId: briefId, command: "beginPlanning", args: {} }, session);

    const batch = await run("mutatePageBatch", {
      workspaceId: wsId,
      pageId: briefId,
      commands: [{ command: "beginImplementation", args: {} }],
    }, session);

    // The batch result carries the structured `next` AND a compact text suffix.
    expect((batch.data as { next?: NextSummary }).next).toBeDefined();
    expect(batch.text).toMatch(/Next: \d+ ready, \d+ blocked, \d+ human gate\(s\), \d+ awaiting human/);
  });
});
