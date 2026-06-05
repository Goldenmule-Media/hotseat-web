/**
 * Integration tests for the wiki-mcp CQRS seam (DESIGN §11).
 *
 * Drives the REAL `wiki` engine against an in-memory `DurableStreamTestServer`
 * and an in-memory PGlite read model — the same rig the runtime wires in
 * `main.ts` — and exercises the three load-bearing behaviors §11 calls out:
 *
 *  (a) **Token semantics.** A write returns a token; a read gated on that token
 *      blocks until the projection applies it and then reflects it; a read with
 *      NO token (a fresh session) may serve a stale projection.
 *  (b) **Read-your-writes via the MCP token manager.** A write tool advances the
 *      session's high-water mark; a same-session read tool waits on it. We inject
 *      projection lag (withhold the drain) to PROVE `waitFor` is doing the work —
 *      the read parks until we drain, then resolves with the written state.
 *  (c) **Projection resume.** Apply N commits, "stop" (drop the projection +
 *      read-model objects), "restart" (fresh objects over the SAME durable SQL),
 *      and resume from `applied_version` with no double-apply (offsets/rows/events
 *      unchanged after a redundant re-drain).
 *
 * Determinism: an injected counter `clock`/`ids` keeps engine stamps byte-stable
 * (no host wall-clock / RNG enters the engine — DESIGN §11).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  arg,
  ConsistencyTimeoutError,
  decodeToken,
  definePageType,
  encodeToken,
  migrateSearchToLatest,
  SqlSearchIndex,
  t,
  z,
  zodSchema,
  type IEventEnvelope,
  type ISearchIndex,
  type WikiSearchDatabase,
  type WorkspaceId,
} from "wiki";
import type { Kysely } from "kysely";
import { Registry } from "wiki/registry";

/** Read the `body.text` prose value out of a projected page row's `sections`. */
function bodyOf(row: { sections?: unknown } | undefined): string | undefined {
  const sections = (row?.sections ?? []) as Array<{ key?: string; fields?: Record<string, { kind?: string; value?: string }> }>;
  const f = sections.find((s) => s.key === "body")?.fields?.text;
  return f?.kind === "prose" ? f.value : undefined;
}
import { DurableStreamTestServer } from "@durable-streams/server";

import { silentLogger } from "../src/logger.js";
import { EmbeddedEngine } from "../src/engine.js";
import { applyCommit, appliedVersion } from "../src/readmodel/project.js";
import { SqlReadModel } from "../src/readmodel/readmodel.js";
import { buildStore, migrateToLatest, type ReadModelStore } from "../src/readmodel/store.js";
import { ProjectionService, type EventSource } from "../src/tail/projection.js";
import { engineEventSource } from "../src/tail/engine-source.js";
import { SessionTokenManager } from "../src/mcp/tokens.js";
import { wikiTools, type WikiTool, type WikiToolContext } from "../src/mcp/tools.js";

// ── a tiny `note` page type with a body field ──────────────────────────────────

const Note = definePageType({
  type: "note",
  version: 1,
  initialStatus: "draft",
  statusTransitions: [t("draft", "publish", "published")],
  sections: {
    body: { name: "Body", required: true, mutableIn: ["draft", "published"], fields: { text: { kind: "prose" } } },
  },
  commands: {
    setBody: { args: zodSchema(z.object({ text: z.string() })), target: { section: "body", field: "text" }, set: { text: arg("text") } },
    publish: { args: zodSchema(z.object({})), transition: { level: "page", event: "publish" } },
  },
  render: { sections: [{ section: "body", heading: "Body", field: "text", as: "block" }] },
});

const PAGE_TYPES = [Note] as const;
const NAMESPACE = "test";

function deterministicClock(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2020, 0, 1) + n++ * 1000).toISOString();
}
function deterministicIds(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

/** Yield real macrotasks so a parked promise has a chance to settle (it shouldn't). */
function tick(times = 1): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) p = p.then(() => new Promise((r) => setTimeout(r, 25)));
  return p;
}

describe("wiki-mcp integration: token semantics + read-your-writes + resume", () => {
  let server: DurableStreamTestServer;
  let url: string;
  let engine: EmbeddedEngine;
  let store: ReadModelStore;
  let readModel: SqlReadModel;
  let searchIndex: ISearchIndex;
  let projection: ProjectionService;
  let tokens: SessionTokenManager;
  const registry = new Registry(PAGE_TYPES);
  const fingerprint = registry.fingerprint();
  const tools = new Map<string, WikiTool>(wikiTools().map((tl) => [tl.name, tl]));

  beforeEach(async () => {
    server = new DurableStreamTestServer({ port: 0 });
    url = await server.start();
    engine = new EmbeddedEngine(
      {
        streamBaseUrl: url,
        namespace: NAMESPACE,
        pageTypes: PAGE_TYPES,
        clock: deterministicClock(),
        ids: deterministicIds(),
        readConsistencyTimeoutMs: 2000,
      },
      silentLogger,
    );
    store = buildStore({ kind: "pglite" });
    await migrateToLatest(store.db, silentLogger);
    const searchDb = store.db as unknown as Kysely<WikiSearchDatabase>;
    await migrateSearchToLatest(searchDb);
    searchIndex = new SqlSearchIndex(searchDb, 2000);
    readModel = new SqlReadModel(store.db, { defaultTimeoutMs: 2000, pollMs: 5 });
    projection = new ProjectionService(store.db, PAGE_TYPES, readModel, silentLogger, undefined, searchIndex);
    tokens = new SessionTokenManager();
  });

  afterEach(async () => {
    projection.stopLive();
    await engine.close();
    await store.close();
    await server.stop();
  });

  function ctx(sessionId: string | undefined, rm = readModel): WikiToolContext {
    return { engine, readModel: rm, searchIndex, tokens, sessionId };
  }
  const drain = (): Promise<void> => projection.drain(engineEventSource(engine));

  // ──────────────────────────────────────────────────────────────────────────
  // (a) Token semantics: write→token, read-with-token reflects it, read-without may be stale
  // ──────────────────────────────────────────────────────────────────────────

  it("a write returns a token; a read with that token reflects it; a read without may be stale", async () => {
    const ws = await engine.createWorkspace({ name: "Tokens" });
    const wsId = ws.id;

    // First write: createPage returns a token naming the committed head.
    const { value: pageId, token: createToken } = await ws.createPage("note", { title: "Alpha", parentId: null });
    expect(decodeToken(createToken).workspaceId).toBe(wsId);
    // The token's version equals the engine's committed head (stream length).
    const headAfterCreate = (await ws.history({ consistentWith: createToken })).length;
    expect(decodeToken(createToken).version).toBe(headAfterCreate);

    // Project up to (and including) the create, so the read model knows the page.
    await drain();

    // A second write advances the token monotonically (strictly greater version).
    const { token: bodyToken } = await ws.mutate(pageId, "setBody", { text: "v1" });
    expect(decodeToken(bodyToken).version).toBeGreaterThan(decodeToken(createToken).version);

    // ── read WITHOUT a token: serves the CURRENT projection, which is stale
    //    (it predates the setBody, which we have NOT drained yet). ──
    const staleRow = await readModel.getPage(wsId, pageId);
    expect(staleRow?.title).toBe("Alpha");
    expect(bodyOf(staleRow)).toBe(""); // body not yet projected → stale, but no error

    // ── read WITH the write's token: waitFor parks until we apply that version,
    //    then the read reflects the write. ──
    let settled = false;
    const gated = readModel.waitFor(bodyToken).then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false); // parked: applied_version still lags bodyToken

    await drain(); // apply the setBody commit
    await gated; // must resolve, not time out
    expect(settled).toBe(true);

    // Now the token-consistent read reflects the write.
    const freshRow = await readModel.getPage(wsId, pageId);
    expect(bodyOf(freshRow)).toBe("v1");

    // appliedToken now names exactly the applied head == the write token.
    expect(await readModel.appliedToken(wsId)).toBe(bodyToken);
  });

  it("waitFor rejects with ConsistencyTimeoutError for a token past the applied head", async () => {
    const ws = await engine.createWorkspace({ name: "Future" });
    await ws.createPage("note", { title: "Seed", parentId: null });
    await drain();

    const future = encodeToken(ws.id, 999);
    await expect(readModel.waitFor(future, { timeoutMs: 50 })).rejects.toBeInstanceOf(ConsistencyTimeoutError);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // (b) Read-your-writes through the MCP token manager — inject projection lag
  // ──────────────────────────────────────────────────────────────────────────

  it("read-your-writes via the token manager: the read parks on the write's token until the projection catches up", async () => {
    const session = "s1";

    // Write tools commit to the stream AND advance the session high-water mark.
    const created = await tools.get("createWorkspace")!.handle({ name: "RYW" }, ctx(session));
    const wsId = (created.data as { workspaceId: string }).workspaceId;

    const page = await tools
      .get("createPage")!
      .handle({ workspaceId: wsId, type: "note", title: "Alpha", parentId: null }, ctx(session));
    const pageId = (page.data as { pageId: string }).pageId;
    const writeToken = (page.data as { token: string }).token;

    // The session high-water mark for this workspace IS the write's token.
    expect(tokens.consistentWith(session, wsId as WorkspaceId)).toBe(writeToken);

    // Inject projection lag: do NOT drain yet. The read tool must park on the
    // session's high-water token (proving waitFor — not luck — gives read-your-writes).
    let settled = false;
    const read = tools
      .get("getPage")!
      .handle({ workspaceId: wsId, pageId }, ctx(session))
      .then((r) => {
        settled = true;
        return r;
      });
    await tick(2);
    expect(settled).toBe(false); // parked on waitFor(writeToken)

    // Release the lag: project the workspace history into SQL.
    await drain();
    const result = await read;
    expect(settled).toBe(true);
    const row = result.data as { title: string; type: string } | null;
    expect(row?.title).toBe("Alpha");
    expect(row?.type).toBe("note");
  });

  it("a fresh session (no high-water marks) reads eventually-consistent without waiting", async () => {
    // A writer session creates + projects a workspace.
    await tools.get("createWorkspace")!.handle({ name: "Seed" }, ctx("writer"));
    await drain();

    // A DIFFERENT session has no marks → its read does NOT wait and immediately
    // sees the already-projected state (no token to gate on).
    let settled = false;
    const read = tools
      .get("listWorkspaces")!
      .handle({}, ctx("other"))
      .then((r) => {
        settled = true;
        return r;
      });
    await tick();
    expect(settled).toBe(true); // resolved without any drain in between
    const list = await read;
    expect((list.data as unknown[]).length).toBeGreaterThan(0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // (c) Projection resume: stop → restart → resume from applied_version, no double-apply
  // ──────────────────────────────────────────────────────────────────────────

  it("resumes from applied_version across a restart with no double-apply", async () => {
    // ── phase 1: write N commits and project them through projection #1 ──
    const ws = await engine.createWorkspace({ name: "Resume" });
    const wsId = ws.id;
    const { value: a } = await ws.createPage("note", { title: "Alpha", parentId: null });
    await ws.createPage("note", { title: "Beta", parentId: null });
    await ws.mutate(a, "setBody", { text: "first" });
    const { token: token1 } = await ws.mutate(a, "publish", {});

    await drain(); // projection #1 applies the full history

    const appliedV1 = await appliedVersion(store.db, wsId);
    expect(appliedV1).toBe(decodeToken(token1).version); // applied head == write token
    const offsets1 = await offsetRow(store, wsId);
    const events1 = await readModel.events(wsId);
    const pages1 = await readModel.listPages(wsId);
    expect(pages1.length).toBe(2);
    expect(events1.length).toBe(appliedV1);

    // ── "stop": drop the projection + read-model objects (the SQL store survives,
    //    exactly as a durable read model survives a process restart). ──
    // (No store.close(): the in-memory PGlite IS the durable SQL across the restart.)

    // ── phase 2: more writes arrive while the projector is "down" ──
    const { value: b2 } = await ws.createPage("note", { title: "Gamma", parentId: null });
    const { token: token2 } = await ws.mutate(b2, "setBody", { text: "second" });

    // ── "restart": fresh ProjectionService + SqlReadModel over the SAME durable SQL ──
    const readModel2 = new SqlReadModel(store.db, { defaultTimeoutMs: 2000, pollMs: 5 });
    const projection2 = new ProjectionService(store.db, PAGE_TYPES, readModel2, silentLogger);

    // Resume drain: reads applied_version, pulls history, projects only the new tail.
    await projection2.drain(engineEventSource(engine));

    const appliedV2 = await appliedVersion(store.db, wsId);
    expect(appliedV2).toBe(decodeToken(token2).version); // advanced to the new head
    expect(appliedV2).toBeGreaterThan(appliedV1);

    // read-your-writes through the restarted read model: token2 is applied.
    await readModel2.waitFor(token2, { timeoutMs: 500 });
    const gamma = await readModel2.getPage(wsId, b2);
    expect(bodyOf(gamma)).toBe("second");
    expect(gamma?.title).toBe("Gamma");

    const pages2 = await readModel2.listPages(wsId);
    const events2 = await readModel2.events(wsId);
    expect(pages2.length).toBe(3); // Alpha, Beta, Gamma — exactly once each
    expect(events2.length).toBe(appliedV2); // one event row per version, no dupes
    // event versions are a contiguous 0..N-1 run with no repeats (no double-append).
    expect(events2.map((e) => e.version)).toEqual([...Array(appliedV2).keys()]);

    // ── phase 3: a REDUNDANT re-drain (no new writes) must be a pure no-op:
    //    same applied_version, same row/event counts — proving idempotent apply. ──
    await projection2.drain(engineEventSource(engine));
    expect(await appliedVersion(store.db, wsId)).toBe(appliedV2);
    expect((await readModel2.listPages(wsId)).length).toBe(3);
    expect((await readModel2.events(wsId)).length).toBe(appliedV2);

    // sanity: phase-1 snapshots were genuinely earlier (the resume did real work).
    expect(offsets1.applied_version).toBe(appliedV1);
    expect(events1.length).toBeLessThan(events2.length);
  });

  it("re-delivering an already-applied commit is a no-op (idempotent apply)", async () => {
    const ws = await engine.createWorkspace({ name: "Idem" });
    const wsId = ws.id;
    const { value: p } = await ws.createPage("note", { title: "Once", parentId: null });
    const { token } = await ws.mutate(p, "setBody", { text: "x" });

    const history = await ws.history({ consistentWith: token });
    const { version: applied1 } = await applyCommit(store.db, registry, { workspaceId: wsId, events: history }, fingerprint);

    // Re-apply the SAME full history: must return the same applied version and not
    // grow the event log / duplicate pages.
    const { version: applied2 } = await applyCommit(store.db, registry, { workspaceId: wsId, events: history }, fingerprint);
    expect(applied2).toBe(applied1);
    expect((await readModel.events(wsId)).length).toBe(applied1);
    expect((await readModel.listPages(wsId)).length).toBe(1);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Cross-workspace fan-out: the read waits on EVERY written workspace's token,
  // proving the lag-injection works across more than one stream.
  // ──────────────────────────────────────────────────────────────────────────

  it("a cross-workspace read fans out over all of the session's writes (lag-injected)", async () => {
    const session = "multi";
    const w1 = await tools.get("createWorkspace")!.handle({ name: "One" }, ctx(session));
    const w2 = await tools.get("createWorkspace")!.handle({ name: "Two" }, ctx(session));
    const ws1 = (w1.data as { workspaceId: string }).workspaceId;
    const ws2 = (w2.data as { workspaceId: string }).workspaceId;

    await tools
      .get("createPage")!
      .handle({ workspaceId: ws1, type: "note", title: "needle-one", parentId: null }, ctx(session));
    await tools
      .get("createPage")!
      .handle({ workspaceId: ws2, type: "note", title: "needle-two", parentId: null }, ctx(session));

    // The session has high-water marks on BOTH workspaces.
    expect(tokens.allWritten(session).length).toBe(2);

    // Inject lag: a cross-workspace search must park on the fan-out until we drain.
    let settled = false;
    const search = tools
      .get("search")!
      .handle({ query: "needle" }, ctx(session))
      .then((r) => {
        settled = true;
        return r;
      });
    await tick(2);
    expect(settled).toBe(false); // parked on the fan-out waitFor over BOTH tokens

    await drain();
    const result = await search;
    expect(settled).toBe(true);
    const titles = (result.data as Array<{ title: string }>).map((h) => h.title).sort();
    expect(titles).toEqual(["needle-one", "needle-two"]);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // A scripted EventSource lets us drive resume without the engine in the loop —
  // proving the projection's offset-skip is what dedupes, independent of the source.
  // ──────────────────────────────────────────────────────────────────────────

  it("a scripted EventSource resumes from applied_version (offset-skip is the dedupe)", async () => {
    // Build a real history on the engine, then capture it as a scripted source.
    const ws = await engine.createWorkspace({ name: "Scripted" });
    const wsId = ws.id;
    const { value: p } = await ws.createPage("note", { title: "S", parentId: null });
    await ws.mutate(p, "setBody", { text: "one" });
    const { token: full } = await ws.mutate(p, "setBody", { text: "two" });
    const fullHistory = await ws.history({ consistentWith: full });

    // A source that returns a PREFIX first, then the full history on the next read —
    // modeling the live tail catching up across a restart.
    let phase: "prefix" | "full" = "prefix";
    const prefixLen = 2; // WorkspaceCreated + PageCreated only
    const scripted: EventSource = {
      async listWorkspaces() {
        return [wsId];
      },
      async readHistory(): Promise<readonly IEventEnvelope[]> {
        return phase === "prefix" ? fullHistory.slice(0, prefixLen) : fullHistory;
      },
    };

    await projection.drain(scripted);
    expect(await appliedVersion(store.db, wsId)).toBe(prefixLen);
    const afterPrefix = await readModel.getPage(wsId, p);
    expect(bodyOf(afterPrefix)).toBe(""); // body events not yet delivered

    phase = "full";
    await projection.drain(scripted);
    expect(await appliedVersion(store.db, wsId)).toBe(fullHistory.length);
    const afterFull = await readModel.getPage(wsId, p);
    expect(bodyOf(afterFull)).toBe("two"); // resumed + applied the tail

    // Event log has exactly one row per version — the offset-skip prevented
    // re-appending the prefix events on the second drain.
    const events = await readModel.events(wsId);
    expect(events.map((e) => e.version)).toEqual([...Array(fullHistory.length).keys()]);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // (d) Live tail (DESIGN §5.1): event-driven projection — NO manual drain.
  //     Local writes arrive via `notify` (a local commit doesn't fan out to its
  //     own subscribers); external writes arrive via the handle's `subscribe`.
  // ──────────────────────────────────────────────────────────────────────────

  it("the live tail projects LOCAL writes via notify — no manual drain", async () => {
    // Discovery poll set high so `notify` (the local-write push), not the poll, is
    // what drives the projection here.
    await projection.start(engineEventSource(engine), { discoverPollMs: 10_000 });

    const ws = await engine.createWorkspace({ name: "Live" });
    const { value: pageId, token } = await ws.createPage("note", { title: "Pushed", parentId: null });
    projection.notify(ws.id); // the runtime calls this after each write tool

    // No manual drain(): notify attaches the workspace + projects to head.
    await readModel.waitFor(token, { timeoutMs: 2000 });
    expect((await readModel.getPage(ws.id, pageId))?.title).toBe("Pushed");

    // A subsequent local write also propagates after its notify.
    const { token: t2 } = await ws.mutate(pageId, "setBody", { text: "live" });
    projection.notify(ws.id);
    await readModel.waitFor(t2, { timeoutMs: 2000 });
    expect(bodyOf(await readModel.getPage(ws.id, pageId))).toBe("live");
  });

  it("the live tail projects EXTERNAL writes via subscribe — no notify, no manual drain", async () => {
    await projection.start(engineEventSource(engine), { discoverPollMs: 20 });

    // A SECOND engine (another client) writes to the SAME streams. Its appends are
    // EXTERNAL to engine #1's handle tail, so engine #1's `subscribe` fans them out.
    let n = 0;
    const engine2 = new EmbeddedEngine(
      {
        streamBaseUrl: url,
        namespace: NAMESPACE,
        pageTypes: PAGE_TYPES,
        clock: deterministicClock(),
        ids: () => `ext-${++n}`, // distinct prefix so ids never collide with engine #1
        readConsistencyTimeoutMs: 2000,
      },
      silentLogger,
    );
    try {
      const ws2 = await engine2.createWorkspace({ name: "External" });
      const { value: pageId, token } = await ws2.createPage("note", { title: "FromOther", parentId: null });

      // engine #1's tailer catches up with NO notify on its side: the discovery poll
      // finds the new workspace, then its events flow via subscribe.
      await readModel.waitFor(token, { timeoutMs: 4000 });
      expect((await readModel.getPage(ws2.id, pageId))?.title).toBe("FromOther");

      // A further external write propagates via subscribe (now attached), no notify.
      const { token: t2 } = await ws2.mutate(pageId, "setBody", { text: "external-body" });
      await readModel.waitFor(t2, { timeoutMs: 4000 });
      expect(bodyOf(await readModel.getPage(ws2.id, pageId))).toBe("external-body");
    } finally {
      await engine2.close();
    }
  });
});

/** Read the raw `projection_offsets` row for a workspace (for resume assertions). */
async function offsetRow(
  store: ReadModelStore,
  workspaceId: WorkspaceId,
): Promise<{ applied_version: number; cursor: string | null; fingerprint: string }> {
  const row = await store.db
    .selectFrom("projection_offsets")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirstOrThrow();
  return row;
}
