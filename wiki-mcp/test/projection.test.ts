/**
 * Projection correctness + CQRS token semantics (DESIGN §11, §3.3, §5).
 *
 * Drives the real engine to produce a workspace history, captures it via
 * `handle.history()`, then folds + serializes it into an in-memory PGlite read
 * model. Asserts:
 *
 *  1. The serialized SQL (pages + fields/items JSONB, tree edges, links, events)
 *     EQUALS the engine's `foldWorkspace` of the SAME history — the read model can
 *     never semantically diverge from the write model (ADR-M3).
 *  2. `waitFor(token)` parks until the projection applies that version, then
 *     resolves; `appliedToken` advances exactly to the applied head; and a token
 *     past the applied head times out — the CQRS bargain (§3.3).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  arg,
  ConsistencyTimeoutError,
  createWiki,
  definePageType,
  encodeToken,
  foldWorkspace,
  t,
  z,
  zodSchema,
  type IWiki,
  type IWorkspaceHandle,
  type PageId,
  type WorkspaceId,
} from "wiki";
import { Registry } from "wiki/registry";
import { DurableStreamTestServer } from "@durable-streams/server";

import { silentLogger } from "../src/logger.js";
import { applyCommit } from "../src/readmodel/project.js";
import { SqlReadModel } from "../src/readmodel/readmodel.js";
import { buildStore, migrateToLatest, type ReadModelStore } from "../src/readmodel/store.js";

// ── a tiny page type: a `note` with a body field and `task` items ──────────────

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

/** Read the `body.text` prose value out of a projected page row's `sections`. */
function bodyOf(row: { sections?: unknown } | undefined): string | undefined {
  const sections = (row?.sections ?? []) as Array<{ key?: string; fields?: Record<string, { kind?: string; value?: string }> }>;
  const f = sections.find((s) => s.key === "body")?.fields?.text;
  return f?.kind === "prose" ? f.value : undefined;
}

const PAGE_TYPES = [Note] as const;

// deterministic clock/ids so the engine's stamps are byte-stable across runs.
function deterministicClock(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2020, 0, 1) + n++ * 1000).toISOString();
}
function deterministicIds(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

describe("SQL read model: fold → serialize → SQL", () => {
  let server: DurableStreamTestServer;
  let url: string;
  let wiki: IWiki;
  let store: ReadModelStore;
  let readModel: SqlReadModel;
  const registry = new Registry(PAGE_TYPES);
  const fingerprint = registry.fingerprint();

  beforeEach(async () => {
    server = new DurableStreamTestServer({ port: 0 });
    url = await server.start();
    wiki = createWiki({
      stream: { baseUrl: url, namespace: "test" },
      pageTypes: PAGE_TYPES,
      clock: deterministicClock(),
      ids: deterministicIds(),
    });
    store = buildStore({ kind: "pglite" });
    await migrateToLatest(store.db, silentLogger);
    readModel = new SqlReadModel(store.db, { defaultTimeoutMs: 2000, pollMs: 5 });
  });

  afterEach(async () => {
    await store.close();
    await wiki.close();
    await server.stop();
  });

  it("serializes a folded history into SQL rows that match the engine fold", async () => {
    // ── build a small history on the write side ──
    const ws = await wiki.createWorkspace({ name: "Demo" });
    const wsId = ws.id;
    const { value: a } = await ws.createPage("note", { title: "Alpha", parentId: null });
    const { value: b } = await ws.createPage("note", { title: "Beta", parentId: null });
    await ws.mutate(a, "setBody", { text: "hello" });
    await ws.mutate(b, "setBody", { text: "world" });
    await ws.mutate(b, "publish", {});
    // a graph link beyond the tree
    const { token: lastToken } = await ws.link(a, b, "relates-to");

    // ── capture the FULL contiguous history and project it ──
    const history = await ws.history({ consistentWith: lastToken });
    const { version: applied } = await applyCommit(store.db, registry, { workspaceId: wsId, events: history }, fingerprint);

    // the engine's own fold of the same history is the source of truth
    const folded = foldWorkspace(history, registry);
    // applied position == stream length == the write token's version (§3.1).
    expect(applied).toBe(folded.version);

    // ── pages match (including fields JSONB) ──
    const pageRows = await readModel.listPages(wsId);
    expect(pageRows.map((r) => r.id).sort()).toEqual([...folded.pages.keys()].sort());
    for (const row of pageRows) {
      const node = folded.pages.get(row.id as PageId);
      expect(node).toBeDefined();
      expect(row.type).toBe(node!.type);
      expect(row.title).toBe(node!.title);
      expect(row.status).toBe(node!.status);
      expect(row.parent_id).toBe(node!.parentId);
      // sections JSONB round-trips to the folded sections
      expect(row.sections).toEqual(node!.sections);
    }

    // the published note really is published (proves status folded through)
    const beta = await readModel.getPage(wsId, b);
    expect(beta?.status).toBe("published");
    expect(bodyOf(beta)).toBe("world");

    // ── tree edges match the folded children map (ordered) ──
    const edges = await readModel.treeEdges(wsId);
    const edgeKey = (e: { parent_id: string; child_id: string; ord: number }) =>
      `${e.parent_id}:${e.child_id}:${e.ord}`;
    const expectedEdges: string[] = [];
    for (const [parent, children] of folded.children) {
      children.forEach((child, ord) => expectedEdges.push(`${parent}:${child}:${ord}`));
    }
    expect(edges.map(edgeKey).sort()).toEqual(expectedEdges.sort());

    // ── links match ──
    const links = await readModel.links(wsId);
    expect(links.map((l) => `${l.from_id}->${l.to_id}:${l.role}`)).toEqual(
      folded.links.map((l) => `${l.from}->${l.to}:${l.role}`),
    );

    // ── the event log is queryable and complete ──
    const events = await readModel.events(wsId);
    expect(events.map((e) => e.version)).toEqual(history.map((e) => e.version));
    expect(events.map((e) => e.type)).toEqual(history.map((e) => e.type));

    // ── workspace summary row ──
    const summaries = await readModel.listWorkspaces();
    expect(summaries).toContainEqual(
      expect.objectContaining({ id: wsId, name: "Demo", status: "active" }),
    );
  });

  it("waitFor(token) resolves once the projection applies it; appliedToken advances", async () => {
    const ws = await wiki.createWorkspace({ name: "Tokens" });
    const wsId = ws.id;
    await seedAndProjectFirst(ws, store, registry, fingerprint);

    // a later write whose token the read model has NOT yet applied
    const { value: p } = await ws.createPage("note", { title: "Later", parentId: null });
    const { token: writeToken } = await ws.mutate(p, "setBody", { text: "x" });

    // before applying: appliedToken lags the write head; waitFor(writeToken) parks.
    let resolved = false;
    const gate = readModel.waitFor(writeToken).then(() => {
      resolved = true;
    });
    await tick();
    expect(resolved).toBe(false);

    // now project the full history up to (and including) the write's version.
    const history = await ws.history({ consistentWith: writeToken });
    const { version: applied } = await applyCommit(store.db, registry, { workspaceId: wsId, events: history }, fingerprint);

    await gate; // must resolve, not time out
    expect(resolved).toBe(true);

    // appliedToken now names exactly the applied head.
    expect(await readModel.appliedToken(wsId)).toBe(encodeToken(wsId, applied));
  });

  it("waitFor rejects with ConsistencyTimeoutError for an unapplied token past the head", async () => {
    const ws = await wiki.createWorkspace({ name: "Timeout" });
    const wsId = ws.id;
    await seedAndProjectFirst(ws, store, registry, fingerprint);

    // a token far past anything the read model will ever apply.
    const future = encodeToken(wsId, 999);
    await expect(readModel.waitFor(future, { timeoutMs: 50 })).rejects.toBeInstanceOf(
      ConsistencyTimeoutError,
    );
  });
});

// ── helpers ────────────────────────────────────────────────────────────────────

/** Create one page and project the resulting history so the workspace exists in SQL. */
async function seedAndProjectFirst(
  ws: IWorkspaceHandle,
  store: ReadModelStore,
  registry: Registry,
  fingerprint: string,
): Promise<void> {
  const { token } = await ws.createPage("note", { title: "Seed", parentId: null });
  const history = await ws.history({ consistentWith: token });
  await applyCommit(store.db, registry, { workspaceId: ws.id as WorkspaceId, events: history }, fingerprint);
}

/** Yield a macrotask so a parked `waitFor` promise has a chance to settle (it shouldn't). */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}
