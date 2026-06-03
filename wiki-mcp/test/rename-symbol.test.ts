/**
 * The `renameSymbol` MCP WRITE tool end-to-end (structured-content §5/§11/§12, Phase 3).
 * Same rig as projection-tools.test.ts — the REAL engine over an in-memory Durable
 * Streams server + in-memory PGlite read model, driven through the tool handlers. Asserts:
 *
 *  1. End-to-end: a page with a TS `code` field → renameSymbol → the field's canonical
 *     source is updated, the symbol_index reflects the new name, render is byte-stable,
 *     and history records the SEMANTIC label `renameSymbol`.
 *  2. Cross-field same-name references in OTHER code fields are REPORTED as `candidates`,
 *     NOT renamed (honest guarantee scope).
 *  3. Read-your-writes token-gating: the write records a token; a token-gated read of the
 *     symbol index reflects the rename.
 *  4. A type-aware rename does not touch a shadowed same-name binding in the edited source.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { definePageType, zodSchema, z, type IField, type SectionOp } from "wiki";
import { DurableStreamTestServer } from "@durable-streams/server";

import { silentLogger } from "../src/logger.js";
import { EmbeddedEngine } from "../src/engine.js";
import { SqlReadModel } from "../src/readmodel/readmodel.js";
import { buildStore, migrateToLatest, type ReadModelStore } from "../src/readmodel/store.js";
import { ProjectionService } from "../src/tail/projection.js";
import { engineEventSource } from "../src/tail/engine-source.js";
import { SessionTokenManager } from "../src/mcp/tokens.js";
import { wikiTools, type WikiTool, type WikiToolContext } from "../src/mcp/tools.js";

// `alpha` is declared + called recursively in the primary field; an inner `alpha`
// param SHADOWS it in `withShadow`, so a sound rename must leave that one alone.
const PRIMARY = `export function alpha(x: number): number {\n  return alpha(x) + 1;\n}\nfunction withShadow(alpha: number): number { return alpha * 2; }\n`;
// A SECOND code field that also references `alpha` — a cross-field candidate.
const SECOND = `import { alpha } from "./primary";\nexport const y = alpha(3);\n`;

const CodeDoc = definePageType({
  type: "code-doc",
  version: 1,
  initialStatus: "draft",
  statusTransitions: [],
  sections: {
    impl: { name: "Implementation", required: true, mutableIn: ["draft"], fields: { snippet: { kind: "code" } } },
    other: { name: "Other", required: true, mutableIn: ["draft"], fields: { snippet: { kind: "code" } } },
  },
  commands: {
    setImpl: {
      args: zodSchema(z.object({ source: z.string() })),
      produces: (_p, args): SectionOp[] => {
        const a = args as { source: string };
        return [{ op: "setField", section: "impl", field: "snippet", value: { kind: "code", lang: "ts", source: a.source, hash: "" } }];
      },
    },
    setOther: {
      args: zodSchema(z.object({ source: z.string() })),
      produces: (_p, args): SectionOp[] => {
        const a = args as { source: string };
        return [{ op: "setField", section: "other", field: "snippet", value: { kind: "code", lang: "ts", source: a.source, hash: "" } }];
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

describe("renameSymbol MCP write tool (Phase 3)", () => {
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
      { streamBaseUrl: url, namespace: NAMESPACE, pageTypes: PAGE_TYPES, clock: deterministicClock(), ids: deterministicIds(), readConsistencyTimeoutMs: 2000 },
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
    const page = await tools.get("createPage")!.handle({ workspaceId: wsId, type: "code-doc", title: "Page", parentId: null }, ctx(session));
    const pageId = (page.data as { pageId: string }).pageId;
    await tools.get("mutatePage")!.handle({ workspaceId: wsId, pageId, command: "setImpl", args: { source: PRIMARY } }, ctx(session));
    await tools.get("mutatePage")!.handle({ workspaceId: wsId, pageId, command: "setOther", args: { source: SECOND } }, ctx(session));
    await drain();
    return { wsId, pageId };
  }

  it("renames the symbol end-to-end: source updated, symbol_index reflects it, history is semantic", async () => {
    const session = "s1";
    const { wsId, pageId } = await seed(session);

    const res = await tools.get("renameSymbol")!.handle(
      { workspaceId: wsId, pageId, section: "impl", field: "snippet", symbol: "alpha", newName: "gamma" },
      ctx(session),
    );
    const data = res.data as { token: string; oldName: string; candidates: unknown[]; edits: unknown[] };
    expect(data.token).toBeTruthy();
    expect(data.oldName).toBe("alpha");
    // def + recursive call = 2 edits in the primary field (the shadowed param is NOT one).
    expect(data.edits.length).toBe(2);

    await drain();

    // The impl field's canonical source now uses `gamma`; the shadowed `alpha` survives.
    const pageRow = await tools.get("getPage")!.handle({ workspaceId: wsId, pageId }, ctx(session));
    const sections = (pageRow.data as { sections: Array<{ key: string; fields: Record<string, { source?: string }> }> }).sections;
    const implSrc = sections.find((s) => s.key === "impl")!.fields.snippet.source!;
    expect(implSrc).toContain("function gamma(x: number)");
    expect(implSrc).toContain("return gamma(x) + 1;");
    // The shadowing inner binding was NOT renamed.
    expect(implSrc).toContain("function withShadow(alpha: number): number { return alpha * 2; }");

    // The symbol index reflects the rename (gamma present, alpha-as-a-declaration in impl gone).
    const syms = await tools.get("symbols")!.handle({ workspaceId: wsId, pageId, name: "gamma" }, ctx(session));
    expect((syms.data as unknown[]).length).toBeGreaterThan(0);

    // History records the SEMANTIC label.
    const handle = await engine.open(wsId as never);
    const hist = await handle.history();
    expect(hist[hist.length - 1]!.meta.command).toBe("renameSymbol");

    // Render is byte-stable: two renders of identical state are identical, and show gamma.
    const r1 = await tools.get("renderPage")!.handle({ workspaceId: wsId, pageId }, ctx(session));
    const r2 = await tools.get("renderPage")!.handle({ workspaceId: wsId, pageId }, ctx(session));
    expect(r1.text).toBe(r2.text);
    expect(r1.text).toContain("function gamma(x: number)");
  });

  it("reports cross-field same-name references as candidates, not renamed", async () => {
    const session = "s2";
    const { wsId, pageId } = await seed(session);

    const res = await tools.get("renameSymbol")!.handle(
      { workspaceId: wsId, pageId, section: "impl", field: "snippet", symbol: "alpha", newName: "gamma" },
      ctx(session),
    );
    const data = res.data as { candidates: Array<{ field: string; pageId: string }> };
    // The OTHER field still references `alpha` — reported, not renamed.
    expect(data.candidates.length).toBeGreaterThan(0);
    expect(data.candidates.some((c) => c.field === "snippet" && c.pageId === pageId)).toBe(true);
    expect(res.text).toContain("REPORTED, not renamed");

    await drain();
    // The OTHER field's source is UNCHANGED (alpha still there).
    const pageRow = await tools.get("getPage")!.handle({ workspaceId: wsId, pageId }, ctx(session));
    const sections = (pageRow.data as { sections: Array<{ key: string; fields: Record<string, { source?: string }> }> }).sections;
    const otherSrc = sections.find((s) => s.key === "other")!.fields.snippet.source!;
    expect(otherSrc).toContain("alpha");
    expect(otherSrc).not.toContain("gamma");
  });

  it("token-gates the write (read-your-writes): a parked symbol read resolves after projecting", async () => {
    const session = "s3";
    const { wsId, pageId } = await seed(session);

    // Rename, but do NOT drain yet — the write recorded a token.
    await tools.get("renameSymbol")!.handle(
      { workspaceId: wsId, pageId, section: "impl", field: "snippet", symbol: "alpha", newName: "gamma" },
      ctx(session),
    );

    let settled = false;
    const read = tools
      .get("symbols")!
      .handle({ workspaceId: wsId, pageId, name: "gamma" }, ctx(session))
      .then((r) => {
        settled = true;
        return r;
      });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false); // parked on the rename's write token

    await drain();
    const result = await read;
    expect(settled).toBe(true);
    expect((result.data as unknown[]).length).toBeGreaterThan(0);
  });
});
