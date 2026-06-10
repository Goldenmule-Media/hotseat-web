/**
 * The emitter registry + the ProjectionService seams it rides on + the MCP tools that drive it
 * (feature: "Runtime-configurable Markdown emitters").
 *
 * Drives the REAL engine against an in-memory Durable Streams host + PGlite, and asserts:
 *  - ProjectionService.removeRenderSink detaches a sink by identity (no more fan-out);
 *  - ProjectionService.reconcileSink brings ONE sink to head, leaving others untouched;
 *  - toMarkdownConfig maps a live emitter to the per-root projector config;
 *  - EmitterRegistry back-fills on boot, and adds / replaces / removes mirrors live (no restart);
 *  - the configure/list/removeEmitter tools round-trip and reject an unknown workspace.
 */
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { arg, definePageType, t, z, zodSchema } from "wiki";
import type { IWorkspaceState, PageId, SearchDoc, WorkspaceId } from "wiki";
import { DurableStreamTestServer } from "@durable-streams/server";

import { silentLogger } from "../src/logger.js";
import { EmbeddedEngine } from "../src/engine.js";
import { SqlReadModel } from "../src/readmodel/readmodel.js";
import { buildStore, migrateToLatest, type ReadModelStore } from "../src/readmodel/store.js";
import { ProjectionService, type EventSource } from "../src/tail/projection.js";
import { engineEventSource } from "../src/tail/engine-source.js";
import type { RenderSink } from "../src/tail/render-sink.js";
import { EmitterConfigStore } from "../src/emitters/config-store.js";
import { EmitterRegistry, toMarkdownConfig } from "../src/emitters/registry.js";
import { wikiTools, type WikiTool, type WikiToolContext } from "../src/mcp/tools.js";
import { SessionTokenManager } from "../src/mcp/tokens.js";

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
  },
  render: { sections: [{ section: "body", heading: "Body", field: "text", as: "block" }] },
});
const PAGE_TYPES = [Note] as const;
const NAMESPACE = "test";

function clock(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2020, 0, 1) + n++ * 1000).toISOString();
}
function ids(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

/** Poll `cond` until truthy or `timeout` elapses (for the registry's async live tail). */
async function until(cond: () => boolean | Promise<boolean>, timeout = 3000, step = 15): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) throw new Error("until: condition not met before timeout");
    await new Promise((r) => setTimeout(r, step));
  }
}

/** A minimal RenderSink that just records what it was fed (for the projection seams). */
class RecordingSink implements RenderSink {
  readonly name = "rec";
  rebuilds = 0;
  deltas = 0;
  readonly applied = new Map<string, number>();
  async appliedVersion(ws: WorkspaceId): Promise<number> {
    return this.applied.get(ws) ?? 0;
  }
  async applyDelta(ws: WorkspaceId, version: number, _d: readonly SearchDoc[], _r: readonly PageId[], _s: IWorkspaceState): Promise<void> {
    this.deltas++;
    this.applied.set(ws, version);
  }
  async rebuild(ws: WorkspaceId, version: number): Promise<void> {
    this.rebuilds++;
    this.applied.set(ws, version);
  }
  fail(): void {}
}

describe("runtime-configurable Markdown emitters", () => {
  let server: DurableStreamTestServer;
  let url: string;
  let engine: EmbeddedEngine;
  let store: ReadModelStore;
  let readModel: SqlReadModel;
  let projection: ProjectionService;
  let source: EventSource;
  const tools = new Map<string, WikiTool>(wikiTools().map((tl) => [tl.name, tl]));
  const tmpRoots: string[] = [];

  beforeEach(async () => {
    server = new DurableStreamTestServer({ port: 0 });
    url = await server.start();
    engine = new EmbeddedEngine(
      { streamBaseUrl: url, namespace: NAMESPACE, pageTypes: PAGE_TYPES, clock: clock(), ids: ids(), readConsistencyTimeoutMs: 2000 },
      silentLogger,
    );
    store = buildStore({ kind: "pglite" });
    await migrateToLatest(store.db, silentLogger);
    readModel = new SqlReadModel(store.db, { defaultTimeoutMs: 2000, pollMs: 5 });
    projection = new ProjectionService(store.db, PAGE_TYPES, readModel, silentLogger);
    source = engineEventSource(engine);
  });

  afterEach(async () => {
    await engine.close();
    await store.close();
    await server.stop();
    await Promise.all(tmpRoots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
  });

  const newRoot = async (): Promise<string> => {
    const r = await mkdtemp(join(tmpdir(), "wiki-emit-"));
    tmpRoots.push(r);
    return r;
  };
  const drain = (): Promise<void> => projection.drain(source);
  const exists = async (abs: string): Promise<boolean> => {
    try {
      await access(abs);
      return true;
    } catch {
      return false;
    }
  };

  // ── ProjectionService seams ──────────────────────────────────────────────────

  it("removeRenderSink detaches a sink by identity — no further fan-out", async () => {
    const sink = new RecordingSink();
    projection.addRenderSink(sink);
    const ws = await engine.createWorkspace({ name: "Docs" });
    await ws.createPage("note", { title: "One", parentId: null });
    await drain();
    const afterFirst = sink.applied.get(ws.id);
    expect(afterFirst).toBeGreaterThan(0); // got the first commit

    projection.removeRenderSink(sink);
    await ws.createPage("note", { title: "Two", parentId: null });
    await drain();
    expect(sink.applied.get(ws.id)).toBe(afterFirst); // unchanged — sink no longer fed

    projection.removeRenderSink(sink); // removing an unregistered sink is a no-op
  });

  it("reconcileSink brings ONE sink to head, leaving the others untouched", async () => {
    const a = new RecordingSink();
    const b = new RecordingSink();
    projection.addRenderSink(a);
    projection.addRenderSink(b);
    const ws = await engine.createWorkspace({ name: "Docs" });
    await ws.createPage("note", { title: "One", parentId: null });
    // No drain — both sinks are at 0. Reconcile ONLY a.
    await projection.reconcileSink(a, source);
    expect(a.rebuilds).toBe(1);
    expect(a.applied.get(ws.id)).toBeGreaterThan(0);
    expect(b.rebuilds).toBe(0);
    expect(b.applied.get(ws.id)).toBeUndefined();
  });

  // ── toMarkdownConfig ───────────────────────────────────────────────────────────

  it("toMarkdownConfig maps a live emitter to the per-root projector config", () => {
    expect(toMarkdownConfig({ emitterId: "e1", workspaceId: "ws:A", root: "/out" })).toEqual({
      enabled: true,
      root: "/out",
      workspaces: ["ws:A"],
      layout: "tree",
    });
  });

  // ── EmitterRegistry ──────────────────────────────────────────────────────────

  it("boot-replay: a pre-seeded emitter back-fills its root from the workspace head", async () => {
    const ws = await engine.createWorkspace({ name: "Docs" });
    const { value: pageId } = await ws.createPage("note", { title: "Guide", parentId: null });
    await ws.mutate(pageId, "setBody", { text: "hello" });
    await drain();

    const root = await newRoot();
    const cfgStore = new EmitterConfigStore({ baseUrl: url, namespace: NAMESPACE }, clock());
    await cfgStore.appendConfigured({ emitterId: "e1", workspaceId: ws.id, root });

    const registry = new EmitterRegistry(cfgStore, projection, source, silentLogger);
    await registry.start(); // back-fills synchronously before returning

    expect(await exists(join(root, "docs/guide.md"))).toBe(true);
    expect(await readFile(join(root, "docs/guide.md"), "utf8")).toBe(await ws.toMarkdown(pageId));

    await registry.stop();
    await cfgStore.close();
  });

  it("live add: configuring an emitter after start back-fills + mirrors new commits (no restart)", async () => {
    const cfgStore = new EmitterConfigStore({ baseUrl: url, namespace: NAMESPACE }, clock());
    const registry = new EmitterRegistry(cfgStore, projection, source, silentLogger);
    await registry.start(); // no emitters yet

    const ws = await engine.createWorkspace({ name: "Beta" });
    const { value: p1 } = await ws.createPage("note", { title: "First", parentId: null });
    await drain();

    const root = await newRoot();
    await cfgStore.appendConfigured({ emitterId: "e2", workspaceId: ws.id, root });
    // The live tail picks it up and back-fills existing content with no new commit.
    await until(() => exists(join(root, "beta/first.md")));
    expect(await readFile(join(root, "beta/first.md"), "utf8")).toBe(await ws.toMarkdown(p1));

    // A subsequent commit is mirrored too.
    const { value: p2 } = await ws.createPage("note", { title: "Second", parentId: null });
    await drain();
    await until(() => exists(join(root, "beta/second.md")));
    expect(await readFile(join(root, "beta/second.md"), "utf8")).toBe(await ws.toMarkdown(p2));

    await registry.stop();
    await cfgStore.close();
  });

  it("live replace: re-configuring an id with a new root back-fills the new root", async () => {
    const ws = await engine.createWorkspace({ name: "Docs" });
    await ws.createPage("note", { title: "Guide", parentId: null });
    await drain();

    const rootA = await newRoot();
    const rootB = await newRoot();
    const cfgStore = new EmitterConfigStore({ baseUrl: url, namespace: NAMESPACE }, clock());
    const registry = new EmitterRegistry(cfgStore, projection, source, silentLogger);

    await cfgStore.appendConfigured({ emitterId: "e1", workspaceId: ws.id, root: rootA });
    await registry.start();
    expect(await exists(join(rootA, "docs/guide.md"))).toBe(true);

    // Re-configure the SAME id at a new root: the old sink is detached, a new one back-fills rootB.
    await cfgStore.appendConfigured({ emitterId: "e1", workspaceId: ws.id, root: rootB });
    await until(() => exists(join(rootB, "docs/guide.md")));

    // A new commit lands in rootB (the live root); rootA is no longer updated.
    const { value: p2 } = await ws.createPage("note", { title: "Extra", parentId: null });
    await drain();
    await until(() => exists(join(rootB, "docs/extra.md")));
    expect(await exists(join(rootA, "docs/extra.md"))).toBe(false);

    await registry.stop();
    await cfgStore.close();
  });

  it("live remove: detaches the sink, leaves mirrored files, stops mirroring new commits", async () => {
    const ws = await engine.createWorkspace({ name: "Docs" });
    await ws.createPage("note", { title: "Guide", parentId: null });
    await drain();

    const root = await newRoot();
    const cfgStore = new EmitterConfigStore({ baseUrl: url, namespace: NAMESPACE }, clock());
    const registry = new EmitterRegistry(cfgStore, projection, source, silentLogger);
    await cfgStore.appendConfigured({ emitterId: "e1", workspaceId: ws.id, root });
    await registry.start();
    expect(await exists(join(root, "docs/guide.md"))).toBe(true);

    await cfgStore.appendRemoved("e1");
    // After the removal is processed, a new commit must NOT be mirrored.
    // Wait until the sink is detached by observing that a fresh commit is not written.
    const { value: p2 } = await ws.createPage("note", { title: "Ghost", parentId: null });
    // Give the live tail time to process the removal, then drain a commit.
    await new Promise((r) => setTimeout(r, 100));
    await drain();
    await new Promise((r) => setTimeout(r, 100));
    expect(await exists(join(root, "docs/ghost.md"))).toBe(false); // not mirrored after removal
    expect(await exists(join(root, "docs/guide.md"))).toBe(true); // earlier file LEFT on disk

    await registry.stop();
    await cfgStore.close();
  });

  // ── MCP tools ───────────────────────────────────────────────────────────────

  function ctx(emitters: EmitterConfigStore): WikiToolContext {
    return { engine, readModel, emitters, tokens: new SessionTokenManager(), sessionId: "s1" };
  }

  it("configureEmitter rejects an unknown workspace and appends nothing", async () => {
    const cfgStore = new EmitterConfigStore({ baseUrl: url, namespace: NAMESPACE }, clock());
    await expect(
      tools.get("configureEmitter")!.handle(
        { emitterId: "e1", workspaceId: "ws:does-not-exist", root: "/tmp/out" },
        ctx(cfgStore),
      ),
    ).rejects.toThrow(/Unknown workspace/);
    const { events } = await cfgStore.readAll();
    expect(events).toHaveLength(0); // nothing appended
    await cfgStore.close();
  });

  it("configureEmitter rejects a relative root", async () => {
    const ws = await engine.createWorkspace({ name: "Docs" });
    const cfgStore = new EmitterConfigStore({ baseUrl: url, namespace: NAMESPACE }, clock());
    await expect(
      tools.get("configureEmitter")!.handle(
        { emitterId: "e1", workspaceId: ws.id, root: "relative/dir" },
        ctx(cfgStore),
      ),
    ).rejects.toThrow(/absolute path/);
    await cfgStore.close();
  });

  it("configureEmitter → listEmitters → removeEmitter round-trips the live set", async () => {
    const ws = await engine.createWorkspace({ name: "Docs" });
    const cfgStore = new EmitterConfigStore({ baseUrl: url, namespace: NAMESPACE }, clock());
    const c = ctx(cfgStore);
    const root = await newRoot();

    await tools.get("configureEmitter")!.handle({ emitterId: "e1", workspaceId: ws.id, root }, c);
    const listed = (await tools.get("listEmitters")!.handle({}, c)).data as unknown[];
    expect(listed).toEqual([{ emitterId: "e1", workspaceId: ws.id, root }]);

    await tools.get("removeEmitter")!.handle({ emitterId: "e1" }, c);
    const afterRemove = (await tools.get("listEmitters")!.handle({}, c)).data as unknown[];
    expect(afterRemove).toHaveLength(0);

    // Removing an unknown id is a tolerated no-op (does not throw).
    await expect(tools.get("removeEmitter")!.handle({ emitterId: "nope" }, c)).resolves.toBeDefined();
    await cfgStore.close();
  });
});
