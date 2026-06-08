/**
 * The symbol/reference projection. Drives
 * the real engine to author a page with a `code` FIELD and a `code` BLOCK inside a
 * `blocks` field, projects the folded history through the LanguageRegistry, and asserts:
 *
 *  1. A `code` field/block in an ANALYZED lang (ts) yields per-declaration `symbol_index`
 *     rows (name/kind/container/offsets) AND `reference_index` rows.
 *  2. A `code` field in an UNKNOWN lang yields only the location STUB row (name/kind null).
 *  3. The outline + xref projections still populate (Phase 1 behaviour intact).
 *
 * In-memory PGlite + in-process Durable Streams, the same rig as projection.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createWiki,
  definePageType,
  zodSchema,
  z,
  type IWiki,
  type IBlock,
  type IField,
  type SectionOp,
  type WorkspaceId,
} from "wiki";
import { Registry } from "wiki/registry";
import { DurableStreamTestServer } from "@durable-streams/server";

import { silentLogger } from "../src/logger.js";
import { applyCommit } from "../src/readmodel/project.js";
import { SqlReadModel } from "../src/readmodel/readmodel.js";
import { createLanguageRegistry } from "../src/models/analyzers/index.js";
import { buildStore, migrateToLatest, type ReadModelStore } from "../src/readmodel/store.js";

const TS_SOURCE = `export function alpha(x: number): number {
  return beta(x) + 1;
}
function beta(y: number): number { return y * 2; }
`;

const PY_SOURCE = `def gamma(z):\n    return z\n`;

const BLOCK_TS = `class Widget {\n  render() { return alpha(1); }\n}\n`;

/** A page type with a `code` field, an unknown-lang `code` field, and a `blocks` doc. */
const CodeDoc = definePageType({
  type: "code-doc",
  version: 1,
  initialStatus: "draft",
  statusTransitions: [],
  sections: {
    impl: {
      name: "Implementation",
      required: true,
      mutableIn: ["draft"],
      fields: { snippet: { kind: "code" }, foreign: { kind: "code" } },
    },
    doc: {
      name: "Doc",
      required: true,
      mutableIn: ["draft"],
      fields: { body: { kind: "blocks" } },
    },
  },
  commands: {
    // set the `code` field to a TS snippet (explicit lang via an IField literal).
    setSnippet: {
      args: zodSchema(z.object({ source: z.string(), lang: z.string() })),
      produces: (_page, args): SectionOp[] => {
        const a = args as { source: string; lang: string };
        const value: IField = { kind: "code", lang: a.lang, source: a.source, hash: "" };
        return [{ op: "setField", section: "impl", field: "snippet", value }];
      },
    },
    // set the `foreign` code field to an unknown-lang snippet.
    setForeign: {
      args: zodSchema(z.object({ source: z.string(), lang: z.string() })),
      produces: (_page, args): SectionOp[] => {
        const a = args as { source: string; lang: string };
        const value: IField = { kind: "code", lang: a.lang, source: a.source, hash: "" };
        return [{ op: "setField", section: "impl", field: "foreign", value }];
      },
    },
    // append a `code` BLOCK to the `blocks` field.
    addCodeBlock: {
      args: zodSchema(z.object({ source: z.string(), lang: z.string() })),
      produces: (_page, args, ctx): SectionOp[] => {
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

describe("symbol/reference projection over code fields + code blocks", () => {
  let server: DurableStreamTestServer;
  let url: string;
  let wiki: IWiki;
  let store: ReadModelStore;
  let readModel: SqlReadModel;
  const registry = new Registry(PAGE_TYPES);
  const fingerprint = registry.fingerprint();
  const languages = createLanguageRegistry();

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

  it("indexes symbols + references for ts code; stub-only for unknown lang; outline intact", async () => {
    const ws = await wiki.createWorkspace({ name: "Demo" });
    const wsId = ws.id as WorkspaceId;
    const { value: page } = await ws.createPage("code-doc", { title: "Page", parentId: null });

    await ws.mutate(page, "setSnippet", { source: TS_SOURCE, lang: "ts" });
    await ws.mutate(page, "setForeign", { source: PY_SOURCE, lang: "python" });
    const { token } = await ws.mutate(page, "addCodeBlock", { source: BLOCK_TS, lang: "ts" });

    const history = await ws.history({ consistentWith: token });
    await applyCommit(store.db, registry, { workspaceId: wsId, events: history }, fingerprint, languages);

    // ── symbols: the ts field's declarations are indexed ──
    const allSyms = await readModel.symbols(wsId);
    const named = allSyms.filter((s) => s.name !== null);
    const names = new Set(named.map((s) => s.name));
    expect(names.has("alpha")).toBe(true);
    expect(names.has("beta")).toBe(true);
    // the ts code BLOCK is indexed too (Widget + render), keyed by block_id.
    expect(named.some((s) => s.name === "Widget" && s.kind === "class")).toBe(true);
    const render = named.find((s) => s.name === "render");
    expect(render?.kind).toBe("method");
    expect(render?.container).toBe("Widget");
    expect(render?.block_id).not.toBeNull(); // it's a block, not a field

    // `alpha` is an exported function with an offset range that slices to its source.
    const alpha = named.find((s) => s.name === "alpha" && s.block_id === null)!;
    expect(alpha.kind).toBe("function");
    expect(alpha.field).toBe("snippet");
    expect(TS_SOURCE.slice(alpha.def_start!, alpha.def_end!)).toMatch(/^export function alpha/);

    // ── the unknown-lang `foreign` field is a STUB: location only, no parse ──
    const foreignRows = allSyms.filter((s) => s.field === "foreign");
    expect(foreignRows.length).toBe(1);
    expect(foreignRows[0].name).toBeNull();
    expect(foreignRows[0].kind).toBeNull();
    expect(foreignRows[0].lang).toBe("python");
    // python's `gamma` is NOT indexed (no analyzer).
    expect(named.some((s) => s.name === "gamma")).toBe(false);

    // ── references: `beta` is called inside `alpha`, and declared — at least 2 hits ──
    const betaRefs = await readModel.references(wsId, "beta");
    expect(betaRefs.length).toBeGreaterThanOrEqual(2);
    for (const r of betaRefs) expect(TS_SOURCE.includes("beta") || BLOCK_TS.includes("beta")).toBe(true);
    // `alpha` is referenced from the code block (alpha(1)) too — a cross-shape ref.
    const alphaRefs = await readModel.references(wsId, "alpha");
    expect(alphaRefs.some((r) => r.block_id !== null)).toBe(true);

    // ── outline still populates (Phase 1 behaviour intact) ──
    const outline = await readModel.outline(wsId, page);
    const keys = outline.map((o) => o.key).sort();
    expect(keys).toEqual(["doc", "impl"]);
  });

  it("is deterministic — re-projecting the same history yields identical symbol rows", async () => {
    const ws = await wiki.createWorkspace({ name: "Det" });
    const wsId = ws.id as WorkspaceId;
    const { value: page } = await ws.createPage("code-doc", { title: "P", parentId: null });
    const { token } = await ws.mutate(page, "setSnippet", { source: TS_SOURCE, lang: "ts" });
    const history = await ws.history({ consistentWith: token });

    await applyCommit(store.db, registry, { workspaceId: wsId, events: history }, fingerprint, languages);
    const first = await readModel.symbols(wsId);
    // re-apply (idempotent re-fold + re-serialize) and re-read.
    await store.db.deleteFrom("projection_offsets").where("workspace_id", "=", wsId).execute();
    await applyCommit(store.db, registry, { workspaceId: wsId, events: history }, fingerprint, languages);
    const second = await readModel.symbols(wsId);
    expect(second).toEqual(first);
  });
});
