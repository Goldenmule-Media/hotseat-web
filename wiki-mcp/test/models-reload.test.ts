/**
 * Runtime model hot-reload (ADR-M6). Wires a ModelRegistry to the engine + projection
 * exactly as `createWikiMcp` does — engine + projection built from `models.pageTypes()`,
 * and `onChange` → engine.rebind + projection.rebind + reproject — over a real engine
 * (in-memory DurableStreamTestServer) and PGlite read model.
 *
 * It proves the two ADR-M6 behaviors a reload must deliver:
 *  (a) REPROJECT — existing data is re-folded with the new registry (the offset is
 *      reset and rewritten, so the page is genuinely re-projected, not just lingering);
 *  (b) REBIND — the engine swaps to the new page-type set, so a type ADDED by the reload
 *      becomes creatable.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { definePageType, t, z, zodSchema, type WorkspaceId } from "wiki";
import { DurableStreamTestServer } from "@durable-streams/server";

import { silentLogger } from "../src/logger.js";
import { EmbeddedEngine } from "../src/engine.js";
import { appliedVersion } from "../src/readmodel/project.js";
import { SqlReadModel } from "../src/readmodel/readmodel.js";
import { buildStore, migrateToLatest, type ReadModelStore } from "../src/readmodel/store.js";
import { ProjectionService, type EventSource } from "../src/tail/projection.js";
import { engineEventSource } from "../src/tail/engine-source.js";
import { ModelRegistry } from "../src/models/registry.js";

// ── two tiny page types: `note` (seeded) and `memo` (added by the reload) ──────────

const Note = definePageType<{ body?: string }>({
  type: "note",
  initialStatus: "draft",
  initialFields: {},
  version: 1,
  items: {},
  statusTransitions: [t("draft", "setBody", "draft")],
  commands: {
    setBody: {
      args: zodSchema(z.object({ text: z.string() })),
      transition: { level: "page", event: "setBody" },
      produces: (_p, a) => ({ events: [{ type: "BodySet", payload: { text: a.text } }], result: undefined }),
    },
  },
  apply: (page, event) => {
    if (event.type === "BodySet") page.fields.body = (event.payload as { text: string }).text;
    return page;
  },
  render: (page) => `# ${page.title}\n\n${page.fields.body ?? ""}`,
});

const Memo = definePageType<Record<string, never>>({
  type: "memo",
  initialStatus: "open",
  initialFields: {},
  version: 1,
  items: {},
  statusTransitions: [],
  commands: {},
  apply: (page) => page,
  render: (page) => `# ${page.title}`,
});

function counterClock(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2020, 0, 1) + n++ * 1000).toISOString();
}
function counterIds(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

describe("model hot-reload (ADR-M6)", () => {
  let server: DurableStreamTestServer;
  let engine: EmbeddedEngine;
  let store: ReadModelStore;
  let readModel: SqlReadModel;
  let projection: ProjectionService;
  let models: ModelRegistry;
  let source: EventSource;

  beforeEach(async () => {
    server = new DurableStreamTestServer({ port: 0 });
    const url = await server.start();
    store = buildStore({ kind: "pglite" });
    await migrateToLatest(store.db, silentLogger);
    readModel = new SqlReadModel(store.db, { defaultTimeoutMs: 2000, pollMs: 5 });

    models = new ModelRegistry();
    await models.register("default", [Note]);
    engine = new EmbeddedEngine(
      { streamBaseUrl: url, namespace: "test", pageTypes: models.pageTypes(), clock: counterClock(), ids: counterIds() },
      silentLogger,
    );
    projection = new ProjectionService(store.db, models.pageTypes(), readModel, silentLogger);
    source = engineEventSource(engine);

    // The same reaction createWikiMcp wires (minus the live-tail re-attach, which these
    // tests drive via explicit drains).
    models.onChange = async () => {
      await engine.rebind(models.pageTypes());
      projection.rebind(models.current());
      await projection.reproject(source);
    };
  });

  afterEach(async () => {
    projection.stopLive();
    await engine.close();
    await store.close();
    await server.stop();
  });

  it("reload reprojects existing data and rebinds the engine to the new type set", async () => {
    // Seed-time type `note`: create a page and project it.
    const ws = await engine.createWorkspace({ name: "Reload" });
    const { value: pageId } = await ws.createPage("note", { title: "Alpha", parentId: null });
    await projection.drain(source);
    const versionBefore = await appliedVersion(store.db, ws.id as WorkspaceId);
    expect((await readModel.getPage(ws.id, pageId))?.title).toBe("Alpha");

    // Reload: replace the bundle with [Note, Memo]. Triggers rebind + reproject.
    await models.register("default", [Note, Memo]);
    expect(models.generation()).toBe(2);

    // (a) reproject re-folded the existing page — the offset was reset then REWRITTEN to
    //     the same version, so the page is genuinely re-projected (not a stale leftover).
    expect(await appliedVersion(store.db, ws.id as WorkspaceId)).toBe(versionBefore);
    expect((await readModel.getPage(ws.id, pageId))?.title).toBe("Alpha");

    // (b) the engine rebound to the new set — a `memo` page is now creatable.
    const ws2 = await engine.createWorkspace({ name: "Added" });
    const { value: memoId } = await ws2.createPage("memo", { title: "M", parentId: null });
    await projection.drain(source);
    expect((await readModel.getPage(ws2.id, memoId))?.type).toBe("memo");
  });
});
