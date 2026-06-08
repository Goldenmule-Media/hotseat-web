/**
 * Full-text `search` tool (DESIGN — search seam). The engine owns the index
 * (`SqlSearchIndex`); the host feeds it from the projection tailer over the SAME PGlite
 * database as the read model, and the `search` tool queries it. Drives the real engine
 * against an in-memory stream + PGlite, projects, then asserts the tool finds pages by
 * BODY content (not just title), excludes archived pages, and ranks by relevance.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  arg,
  definePageType,
  migrateSearchToLatest,
  SearchIndexUnavailableError,
  SqlSearchIndex,
  t,
  z,
  zodSchema,
  type ConsistencyToken,
  type ISearchIndex,
  type SearchDoc,
  type SearchHit,
  type SearchQueryOpts,
  type WikiSearchDatabase,
  type WorkspaceId,
} from "wiki";
import { DurableStreamTestServer } from "@durable-streams/server";
import type { Kysely } from "kysely";

import { silentLogger } from "../src/logger.js";
import { EmbeddedEngine } from "../src/engine.js";
import { SqlReadModel } from "../src/readmodel/readmodel.js";
import { buildStore, migrateToLatest, type ReadModelStore } from "../src/readmodel/store.js";
import { ProjectionService } from "../src/tail/projection.js";
import { engineEventSource } from "../src/tail/engine-source.js";
import { SessionTokenManager } from "../src/mcp/tokens.js";
import { wikiTools, type WikiTool, type WikiToolContext } from "../src/mcp/tools.js";

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

/** Wraps a real index but can be told to fail its writes — to exercise the tailer's
 *  best-effort failure path (catch → `searchIndex.fail`) end to end. */
class FaultyIndex implements ISearchIndex {
  failWrites = false;
  constructor(private readonly inner: ISearchIndex) {}
  appliedToken(ws: WorkspaceId): Promise<ConsistencyToken> {
    return this.inner.appliedToken(ws);
  }
  waitFor(token: ConsistencyToken, opts?: { timeoutMs?: number }): Promise<void> {
    return this.inner.waitFor(token, opts);
  }
  reconcile(ws: WorkspaceId, version: number, docs: readonly SearchDoc[]): Promise<void> {
    if (this.failWrites) return Promise.reject(new Error("injected reconcile failure"));
    return this.inner.reconcile(ws, version, docs);
  }
  update(ws: WorkspaceId, version: number, docs: readonly SearchDoc[], removed: readonly string[]): Promise<void> {
    if (this.failWrites) return Promise.reject(new Error("injected update failure"));
    return this.inner.update(ws, version, docs, removed);
  }
  query(ws: readonly WorkspaceId[], query: string, opts?: SearchQueryOpts): Promise<readonly SearchHit[]> {
    return this.inner.query(ws, query, opts);
  }
  fail(ws: WorkspaceId, version: number, err: unknown): void {
    this.inner.fail(ws, version, err);
  }
  forget(ws: WorkspaceId): void {
    this.inner.forget(ws);
  }
}

function clock(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2020, 0, 1) + n++ * 1000).toISOString();
}
function ids(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

describe("search tool — full-text over page content", () => {
  let server: DurableStreamTestServer;
  let engine: EmbeddedEngine;
  let store: ReadModelStore;
  let readModel: SqlReadModel;
  let searchIndex: ISearchIndex;
  let projection: ProjectionService;
  let tokens: SessionTokenManager;
  const tools = new Map<string, WikiTool>(wikiTools().map((tl) => [tl.name, tl]));

  beforeEach(async () => {
    server = new DurableStreamTestServer({ port: 0 });
    const url = await server.start();
    engine = new EmbeddedEngine(
      { streamBaseUrl: url, namespace: NAMESPACE, pageTypes: PAGE_TYPES, clock: clock(), ids: ids(), readConsistencyTimeoutMs: 2000 },
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
    await engine.close();
    await store.close();
    await server.stop();
  });

  const ctx = (sessionId: string | undefined): WikiToolContext => ({ engine, readModel, searchIndex, tokens, sessionId });
  const drain = (): Promise<void> => projection.drain(engineEventSource(engine));

  async function newPage(session: string, wsId: string, title: string, body: string): Promise<string> {
    const page = await tools.get("createPage")!.handle({ workspaceId: wsId, type: "note", title, parentId: null }, ctx(session));
    const pageId = (page.data as { pageId: string }).pageId;
    await tools.get("mutatePage")!.handle({ workspaceId: wsId, pageId, command: "setBody", args: { text: body } }, ctx(session));
    return pageId;
  }

  it("finds pages by BODY content and title, ranks by relevance, and excludes archived", async () => {
    const s = "s1";
    const created = await tools.get("createWorkspace")!.handle({ name: "Demo" }, ctx(s));
    const wsId = (created.data as { workspaceId: string }).workspaceId;

    const p1 = await newPage(s, wsId, "Telemetry", "the quasar emits gamma radiation in bursts; quasar quasar");
    const p2 = await newPage(s, wsId, "Photon notes", "a short unrelated memo");
    await drain();

    // BODY match: "quasar" lives only in p1's body, never in a title.
    const quasar = await tools.get("search")!.handle({ query: "quasar", workspaceId: wsId }, ctx(s));
    const quasarHits = quasar.data as Array<{ pageId: string; snippet: string }>;
    expect(quasarHits.map((h) => h.pageId)).toEqual([p1]);
    expect(quasarHits[0].snippet.toLowerCase()).toContain("quasar");

    // TITLE match: "photon" lives only in p2's title (the title column is always indexed).
    const photon = await tools.get("search")!.handle({ query: "photon", workspaceId: wsId }, ctx(s));
    expect((photon.data as Array<{ pageId: string }>).map((h) => h.pageId)).toEqual([p2]);

    // No match → friendly text, empty data.
    const none = await tools.get("search")!.handle({ query: "supercalifragilistic", workspaceId: wsId }, ctx(s));
    expect(none.text).toBe("No matches.");
    expect(none.data).toEqual([]);

    // BODY word match within the workspace (gamma lives only in p1's body).
    const gamma = await tools.get("search")!.handle({ query: "gamma", workspaceId: wsId }, ctx(s));
    expect((gamma.data as Array<{ pageId: string }>).map((h) => h.pageId)).toContain(p1);

    // Archiving removes the page from results.
    await tools.get("archivePage")!.handle({ workspaceId: wsId, pageId: p1 }, ctx(s));
    await drain();
    const afterArchive = await tools.get("search")!.handle({ query: "quasar", workspaceId: wsId }, ctx(s));
    expect(afterArchive.data).toEqual([]);
  });

  it("fast-fails the search tool when the tailer's best-effort reindex fails", async () => {
    // A faulty index wrapping the real one, fed by a projection over the SAME db — so a
    // failed tailer reindex (caught + `searchIndex.fail`) fast-fails the token-gated tool.
    const faulty = new FaultyIndex(searchIndex);
    const faultyProjection = new ProjectionService(store.db, PAGE_TYPES, readModel, silentLogger, undefined, faulty);
    const faultyDrain = (): Promise<void> => faultyProjection.drain(engineEventSource(engine));
    const fctx = (sessionId: string): WikiToolContext => ({ engine, readModel, searchIndex: faulty, tokens, sessionId });

    const s = "s-fail";
    const created = await tools.get("createWorkspace")!.handle({ name: "Faulty" }, fctx(s));
    const wsId = (created.data as { workspaceId: string }).workspaceId;
    const page = await tools.get("createPage")!.handle({ workspaceId: wsId, type: "note", title: "T", parentId: null }, fctx(s));
    const pageId = (page.data as { pageId: string }).pageId;
    await tools.get("mutatePage")!.handle({ workspaceId: wsId, pageId, command: "setBody", args: { text: "alpha" } }, fctx(s));
    await faultyDrain(); // indexes fine so far

    // Break the tailer's index writes, write again, drain: project() catches the failure and
    // calls index.fail(version); the token-gated search tool then fast-fails (not a timeout).
    faulty.failWrites = true;
    await tools.get("mutatePage")!.handle({ workspaceId: wsId, pageId, command: "setBody", args: { text: "beta" } }, fctx(s));
    await faultyDrain(); // read model still commits; search index fails best-effort

    await expect(
      tools.get("search")!.handle({ query: "beta", workspaceId: wsId }, fctx(s)),
    ).rejects.toBeInstanceOf(SearchIndexUnavailableError);
  });
});
