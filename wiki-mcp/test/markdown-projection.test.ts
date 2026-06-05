/**
 * Markdown-disk projection (feature: "Markdown projection to disk — live filesystem mirror").
 * Drives the real engine against an in-memory stream + PGlite, registers the
 * {@link MarkdownDiskProjector} as a second render sink on the projection tailer, and asserts
 * the on-disk Markdown tree tracks the wiki: byte-identical to the render, nested per the page
 * tree, no churn on unchanged pages, and correct on rename / reparent / archive / restart.
 */
import { access, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { arg, decodeToken, definePageType, migrateSearchToLatest, SqlSearchIndex, t, z, zodSchema } from "wiki";
import type { ISearchIndex, WikiSearchDatabase } from "wiki";
import { DurableStreamTestServer } from "@durable-streams/server";
import type { Kysely } from "kysely";

import { silentLogger } from "../src/logger.js";
import { EmbeddedEngine } from "../src/engine.js";
import { SqlReadModel } from "../src/readmodel/readmodel.js";
import { buildStore, migrateToLatest, type ReadModelStore } from "../src/readmodel/store.js";
import { ProjectionService } from "../src/tail/projection.js";
import { engineEventSource } from "../src/tail/engine-source.js";
import { MarkdownDiskProjector, type IMarkdownProjectionConfig } from "../src/tail/markdown-projection.js";

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

function clock(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2020, 0, 1) + n++ * 1000).toISOString();
}
function ids(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("markdown-disk projection — live filesystem mirror", () => {
  let server: DurableStreamTestServer;
  let engine: EmbeddedEngine;
  let store: ReadModelStore;
  let readModel: SqlReadModel;
  let searchIndex: ISearchIndex;
  let projection: ProjectionService;
  let root: string;

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
    root = await mkdtemp(join(tmpdir(), "wiki-md-"));
  });

  afterEach(async () => {
    await engine.close();
    await store.close();
    await server.stop();
    await rm(root, { recursive: true, force: true });
  });

  const cfg = (
    archive: IMarkdownProjectionConfig["archive"] = "drop",
    workspaces: IMarkdownProjectionConfig["workspaces"] = "all",
  ): IMarkdownProjectionConfig => ({ enabled: true, root, workspaces, layout: "tree", archive });

  /** Build + register the disk projector (default: drop policy, all workspaces); returns it. */
  async function enableMirror(
    archive: IMarkdownProjectionConfig["archive"] = "drop",
    workspaces: IMarkdownProjectionConfig["workspaces"] = "all",
  ): Promise<MarkdownDiskProjector> {
    const projector = new MarkdownDiskProjector(cfg(archive, workspaces), silentLogger);
    await projector.init();
    projection.addRenderSink(projector);
    return projector;
  }

  const drain = (): Promise<void> => projection.drain(engineEventSource(engine));
  const read = (rel: string): Promise<string> => readFile(join(root, rel), "utf8");
  const exists = async (rel: string): Promise<boolean> => {
    try {
      await access(join(root, rel));
      return true;
    } catch {
      return false;
    }
  };

  it("mirrors a page's Markdown to disk, byte-identical to the render", async () => {
    await enableMirror();
    const ws = await engine.createWorkspace({ name: "Docs" });
    const { value: pageId } = await ws.createPage("note", { title: "Guide", parentId: null });
    await ws.mutate(pageId, "setBody", { text: "hello world" });
    await drain();

    expect(await exists("docs/guide.md")).toBe(true);
    expect(await read("docs/guide.md")).toBe(await ws.toMarkdown(pageId));
    expect(await read("docs/guide.md")).toContain("hello world");

    // The SQL read model advanced off the SAME commit/tailer — markdown is a second sink, not a
    // second event loop, and enabling it does not perturb SQL projection.
    expect(decodeToken(await readModel.appliedToken(ws.id)).version).toBeGreaterThan(0);

    // Atomic writes leave no temp files behind (temp + rename).
    expect((await readdir(join(root, "docs"))).some((f) => f.includes(".tmp-"))).toBe(false);
  });

  it("writes only allowlisted workspaces (and nothing for the rest)", async () => {
    const mine = await engine.createWorkspace({ name: "Mine" });
    await enableMirror("drop", [mine.id]); // allowlist exactly one workspace
    const { value: minePage } = await mine.createPage("note", { title: "Kept", parentId: null });
    const other = await engine.createWorkspace({ name: "Other" });
    await other.createPage("note", { title: "Skipped", parentId: null });
    await drain();

    expect(await exists("mine/kept.md")).toBe(true);
    expect(await read("mine/kept.md")).toBe(await mine.toMarkdown(minePage));
    expect(await exists("other/skipped.md")).toBe(false); // not allowlisted → never written
    expect(await exists("other")).toBe(false);
  });

  it("lays the tree out as nested folders, parent-with-children as index.md", async () => {
    await enableMirror();
    const ws = await engine.createWorkspace({ name: "Docs" });
    const { value: parent } = await ws.createPage("note", { title: "Guide", parentId: null });
    const { value: child } = await ws.createPage("note", { title: "Intro", parentId: parent });
    await drain();

    expect(await exists("docs/guide/index.md")).toBe(true); // parent gained a child → folder + index
    expect(await exists("docs/guide/intro.md")).toBe(true); // child under the parent's folder
    expect(await exists("docs/guide.md")).toBe(false); // the leaf form is gone
    expect(await read("docs/guide/index.md")).toBe(await ws.toMarkdown(parent));
    expect(await read("docs/guide/intro.md")).toBe(await ws.toMarkdown(child));
  });

  it("skips unchanged files (no churn) and moves a renamed sibling", async () => {
    await enableMirror();
    const ws = await engine.createWorkspace({ name: "Docs" });
    const { value: parent } = await ws.createPage("note", { title: "Guide", parentId: null });
    const { value: a } = await ws.createPage("note", { title: "Alpha", parentId: parent });
    const { value: b } = await ws.createPage("note", { title: "Beta", parentId: parent });
    await drain();
    expect(await exists("docs/guide/alpha.md")).toBe(true);
    expect(await exists("docs/guide/beta.md")).toBe(true);
    const alphaBefore = (await stat(join(root, "docs/guide/alpha.md"))).mtimeMs;

    await sleep(15);
    await ws.setPageTitle(b, "Bravo"); // structural → whole rebuild; Alpha's bytes are unchanged
    await drain();

    expect((await stat(join(root, "docs/guide/alpha.md"))).mtimeMs).toBe(alphaBefore); // no churn
    expect(await exists("docs/guide/beta.md")).toBe(false); // old path removed
    expect(await exists("docs/guide/bravo.md")).toBe(true); // moved to the new slug
    expect(await read("docs/guide/bravo.md")).toBe(await ws.toMarkdown(b));
  });

  it("reflects a reparent — moves the subtree and reshapes the old parent", async () => {
    await enableMirror();
    const ws = await engine.createWorkspace({ name: "Docs" });
    const { value: guide } = await ws.createPage("note", { title: "Guide", parentId: null });
    const { value: manual } = await ws.createPage("note", { title: "Manual", parentId: null });
    const { value: intro } = await ws.createPage("note", { title: "Intro", parentId: guide });
    await drain();
    expect(await exists("docs/guide/intro.md")).toBe(true);

    await ws.reparent(intro, manual);
    await drain();

    expect(await exists("docs/guide/intro.md")).toBe(false); // old path gone
    expect(await exists("docs/manual/intro.md")).toBe(true); // new path written
    expect(await read("docs/manual/intro.md")).toBe(await ws.toMarkdown(intro));
    // Guide is now childless → it flips from folder/index.md back to a leaf file.
    expect(await exists("docs/guide/index.md")).toBe(false);
    expect(await exists("docs/guide.md")).toBe(true);
  });

  it("drops an archived page's file (archive: drop)", async () => {
    await enableMirror("drop");
    const ws = await engine.createWorkspace({ name: "Docs" });
    const { value: pageId } = await ws.createPage("note", { title: "Temp", parentId: null });
    await drain();
    expect(await exists("docs/temp.md")).toBe(true);

    await ws.archivePage(pageId);
    await drain();
    expect(await exists("docs/temp.md")).toBe(false);
  });

  it("moves an archived page under _archive/ (archive: mirror)", async () => {
    await enableMirror("mirror");
    const ws = await engine.createWorkspace({ name: "Docs" });
    const { value: pageId } = await ws.createPage("note", { title: "Temp", parentId: null });
    await drain();
    expect(await exists("docs/temp.md")).toBe(true);

    await ws.archivePage(pageId);
    await drain();
    expect(await exists("docs/temp.md")).toBe(false); // left its live path
    expect(await exists("docs/_archive/temp.md")).toBe(true); // mirrored aside
  });

  it("self-heals on restart — reconciles a wiped output directory against head", async () => {
    await enableMirror();
    const ws = await engine.createWorkspace({ name: "Docs" });
    const { value: pageId } = await ws.createPage("note", { title: "Guide", parentId: null });
    await ws.mutate(pageId, "setBody", { text: "durable" });
    await drain();
    const expected = await read("docs/guide.md");

    // Simulate a wiped output directory (manifest + files gone) and a process restart.
    await rm(root, { recursive: true, force: true });

    const restarted = new MarkdownDiskProjector(cfg(), silentLogger);
    await restarted.init(); // no manifest → starts empty
    const projection2 = new ProjectionService(store.db, PAGE_TYPES, readModel, silentLogger);
    projection2.addRenderSink(restarted);
    await projection2.reconcileSinks(engineEventSource(engine)); // boot self-heal

    expect(await exists("docs/guide.md")).toBe(true);
    expect(await read("docs/guide.md")).toBe(expected);
  });
});
