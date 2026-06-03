/**
 * Dogfood: Phase 2/3 against a REAL feature page, not a fixture.
 *
 * The `implementation-plan`'s "Data models & interfaces" section is a `blocks` field
 * of `code` blocks (added via `addDataModel`). This proves:
 *   - Phase 2 indexes a declared interface inside a feature data-model code block, and
 *   - Phase 3 `renameSymbol` renames it via the BLOCK-id path (which the field-based
 *     rename test does not exercise) — source updated, index reflects it, render shows
 *     the data model as a fenced code block.
 *
 * Same rig as rename-symbol.test.ts (real engine + in-memory Durable Streams + PGlite).
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

const MODEL = 'export interface ExportRequest {\n  format: "csv" | "json";\n  rows: number;\n}\n';

function deterministicClock(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2020, 0, 1) + n++ * 1000).toISOString();
}
function deterministicIds(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

const NAMESPACE = "test";

describe("renameSymbol on a real feature data model (blocks-field code block)", () => {
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

  it("indexes a data-model interface and renames it via the code-block path", async () => {
    const session = "s1";
    const created = await tools.get("createWorkspace")!.handle({ name: "W" }, ctx(session));
    const wsId = (created.data as { workspaceId: string }).workspaceId;
    const briefRes = await tools.get("createPage")!.handle(
      { workspaceId: wsId, type: "feature-brief", title: "Bulk export", parentId: null },
      ctx(session),
    );
    const briefId = (briefRes.data as { pageId: string }).pageId;

    // The implementation-plan is the first required child.
    const handle = await engine.open(wsId as never);
    const briefView = await handle.page(briefId as never);
    const planId = String((await briefView.children())[0]!.id);

    // Show a major data model as a code block.
    await tools.get("mutatePage")!.handle(
      { workspaceId: wsId, pageId: planId, command: "addDataModel", args: { language: "ts", source: MODEL } },
      ctx(session),
    );
    await drain();

    // Phase 2: the interface is indexed (with a block id, since it lives in a blocks field).
    const syms = await tools.get("symbols")!.handle({ workspaceId: wsId, pageId: planId, name: "ExportRequest" }, ctx(session));
    const row = (syms.data as Array<{ name: string; kind: string; block_id: string | null }>).find((r) => r.name === "ExportRequest");
    expect(row).toBeTruthy();
    expect(row!.kind).toBe("interface");
    const blockId = row!.block_id;
    expect(blockId).toBeTruthy();

    // Phase 3: rename the interface in the code BLOCK (block-id addressing).
    const renamed = await tools.get("renameSymbol")!.handle(
      { workspaceId: wsId, pageId: planId, section: "dataModels", field: "models", block: blockId, symbol: "ExportRequest", newName: "ExportSpec" },
      ctx(session),
    );
    expect((renamed.data as { oldName: string }).oldName).toBe("ExportRequest");
    await drain();

    // The code block's canonical source now declares `ExportSpec`; the index reflects it.
    const pageRow = await tools.get("getPage")!.handle({ workspaceId: wsId, pageId: planId }, ctx(session));
    const sections = (pageRow.data as { sections: Array<{ key: string; fields: Record<string, { blocks?: Array<{ id: string; source?: string }> }> }> }).sections;
    const block = sections.find((s) => s.key === "dataModels")!.fields.models!.blocks!.find((b) => b.id === blockId);
    expect(block!.source).toContain("export interface ExportSpec");
    const syms2 = await tools.get("symbols")!.handle({ workspaceId: wsId, pageId: planId, name: "ExportSpec" }, ctx(session));
    expect((syms2.data as unknown[]).length).toBeGreaterThan(0);

    // Render shows the data model as a fenced code block under its heading.
    const r = await tools.get("renderPage")!.handle({ workspaceId: wsId, pageId: planId }, ctx(session));
    expect(r.text).toContain("## Data models & interfaces");
    expect(r.text).toContain("```ts");
    expect(r.text).toContain("export interface ExportSpec");
  });
});
