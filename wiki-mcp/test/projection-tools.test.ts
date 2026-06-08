/**
 * The derived-projection MCP read tools: `outline`, `symbols`, `references`.
 * Same rig as mcp-tools.test.ts — the REAL engine
 * over an in-memory Durable Streams server + in-memory PGlite read model, driven through
 * the tool handlers. Asserts:
 *
 *  1. Read-your-writes: a read tool parks on the session's write token until the
 *     projection catches up, then resolves with the projected rows (token-gating).
 *  2. `outline` returns the page's section tree; `symbols` lists analyzed declarations
 *     (filterable by name/kind); `references` finds in-source identifier occurrences.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  definePageType,
  zodSchema,
  z,
  type IBlock,
  type IField,
  type SectionOp,
} from "wiki";
import { DurableStreamTestServer } from "@durable-streams/server";

import { silentLogger } from "../src/logger.js";
import { EmbeddedEngine } from "../src/engine.js";
import { SqlReadModel } from "../src/readmodel/readmodel.js";
import { buildStore, migrateToLatest, type ReadModelStore } from "../src/readmodel/store.js";
import { ProjectionService } from "../src/tail/projection.js";
import { engineEventSource } from "../src/tail/engine-source.js";
import { SessionTokenManager } from "../src/mcp/tokens.js";
import { wikiTools, type WikiTool, type WikiToolContext } from "../src/mcp/tools.js";

const TS_SOURCE = `export function alpha(x: number): number { return beta(x); }\nfunction beta(y: number): number { return y; }\n`;
const BLOCK_TS = `class Widget { render() { return alpha(1); } }\n`;

const CodeDoc = definePageType({
  type: "code-doc",
  version: 1,
  initialStatus: "draft",
  statusTransitions: [],
  sections: {
    impl: { name: "Implementation", required: true, mutableIn: ["draft"], fields: { snippet: { kind: "code" } } },
    doc: { name: "Doc", required: true, mutableIn: ["draft"], fields: { body: { kind: "blocks" } } },
  },
  commands: {
    setSnippet: {
      args: zodSchema(z.object({ source: z.string(), lang: z.string() })),
      produces: (_p, args): SectionOp[] => {
        const a = args as { source: string; lang: string };
        const value: IField = { kind: "code", lang: a.lang, source: a.source, hash: "" };
        return [{ op: "setField", section: "impl", field: "snippet", value }];
      },
    },
    addCodeBlock: {
      args: zodSchema(z.object({ source: z.string(), lang: z.string() })),
      produces: (_p, args, ctx): SectionOp[] => {
        const a = args as { source: string; lang: string };
        const block: IBlock = { kind: "code", id: ctx.newId() as never, lang: a.lang, source: a.source, hash: "" };
        return [{ op: "addBlock", section: "doc", field: "body", block }];
      },
    },
  },
  render: { sections: [{ section: "impl", heading: "Impl", field: "snippet", as: "fenced" }] },
});

const PAGE_TYPES = [CodeDoc] as const;

function deterministicClock(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2020, 0, 1) + n++ * 1000).toISOString();
}
function deterministicIds(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

const NAMESPACE = "test";

describe("derived-projection MCP tools: outline · symbols · references", () => {
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
    readModel = new SqlReadModel(store.db, { defaultTimeoutMs: 2000, pollMs: 5 });
    projection = new ProjectionService(store.db, PAGE_TYPES, readModel, silentLogger);
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

  async function seed(session: string): Promise<{ wsId: string; pageId: string }> {
    const created = await tools.get("createWorkspace")!.handle({ name: "W" }, ctx(session));
    const wsId = (created.data as { workspaceId: string }).workspaceId;
    const page = await tools.get("createPage")!.handle(
      { workspaceId: wsId, type: "code-doc", title: "Page", parentId: null },
      ctx(session),
    );
    const pageId = (page.data as { pageId: string }).pageId;
    await tools.get("mutatePage")!.handle(
      { workspaceId: wsId, pageId, command: "setSnippet", args: { source: TS_SOURCE, lang: "ts" } },
      ctx(session),
    );
    await tools.get("mutatePage")!.handle(
      { workspaceId: wsId, pageId, command: "addCodeBlock", args: { source: BLOCK_TS, lang: "ts" } },
      ctx(session),
    );
    return { wsId, pageId };
  }

  it("symbols tool parks on the write token, then returns analyzed declarations (read-your-writes)", async () => {
    const session = "s1";
    const { wsId, pageId } = await seed(session);

    // Read BEFORE projecting: the symbols tool must wait on the session's write token.
    let settled = false;
    const read = tools
      .get("symbols")!
      .handle({ workspaceId: wsId, pageId }, ctx(session))
      .then((r) => {
        settled = true;
        return r;
      });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false); // parked on waitFor(writeToken)

    await drain();
    const result = await read;
    expect(settled).toBe(true);

    const rows = result.data as Array<{ name: string | null; kind: string | null }>;
    const names = new Set(rows.filter((r) => r.name !== null).map((r) => r.name));
    expect(names.has("alpha")).toBe(true);
    expect(names.has("beta")).toBe(true);
    expect(names.has("Widget")).toBe(true); // from the code block
  });

  it("symbols tool filters by name and kind", async () => {
    const session = "s2";
    const { wsId } = await seed(session);
    await drain();

    const byName = await tools.get("symbols")!.handle({ workspaceId: wsId, name: "alpha" }, ctx(session));
    const rowsByName = byName.data as Array<{ name: string }>;
    expect(rowsByName.length).toBeGreaterThan(0);
    expect(rowsByName.every((r) => r.name === "alpha")).toBe(true);

    const byKind = await tools.get("symbols")!.handle({ workspaceId: wsId, kind: "class" }, ctx(session));
    const rowsByKind = byKind.data as Array<{ kind: string; name: string }>;
    expect(rowsByKind.every((r) => r.kind === "class")).toBe(true);
    expect(rowsByKind.some((r) => r.name === "Widget")).toBe(true);
  });

  it("references tool finds in-source occurrences of a symbol name", async () => {
    const session = "s3";
    const { wsId } = await seed(session);
    await drain();

    const refs = await tools.get("references")!.handle({ workspaceId: wsId, name: "alpha" }, ctx(session));
    const rows = refs.data as Array<{ name: string; ref_start: number; ref_end: number; block_id: string | null }>;
    expect(rows.length).toBeGreaterThanOrEqual(2); // declared in field + used in the block
    expect(rows.every((r) => r.name === "alpha")).toBe(true);
    // a reference inside the code BLOCK (alpha(1)) is captured.
    expect(rows.some((r) => r.block_id !== null)).toBe(true);

    // an unknown name yields no references (and a friendly message).
    const none = await tools.get("references")!.handle({ workspaceId: wsId, name: "nope" }, ctx(session));
    expect((none.data as unknown[]).length).toBe(0);
  });

  it("outline tool returns the page's section tree", async () => {
    const session = "s4";
    const { wsId, pageId } = await seed(session);
    await drain();

    const res = await tools.get("outline")!.handle({ workspaceId: wsId, pageId }, ctx(session));
    const roots = res.data as Array<{ key: string; name: string; children: unknown[] }>;
    const keys = roots.map((r) => r.key).sort();
    expect(keys).toEqual(["doc", "impl"]);
    expect(res.text).toContain("Implementation");
  });
});
