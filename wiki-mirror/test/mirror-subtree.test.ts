/**
 * Subtree mirrors: an emitter scoped to one page writes that page to `<root>/index.md` and its
 * descendants beneath it, and nothing else from the workspace. Driven end to end through the
 * real engine, like mirror.test.ts.
 */
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { arg, definePageType, t, z, zodSchema } from "wiki";
import type { IPageType, IWiki, IWorkspaceHandle, PageId } from "wiki";
import { Registry } from "wiki/registry";
import { startTestServer, wikiOn } from "wiki/testing";

import { silentLogger } from "../src/logger.js";
import { archivedFileName, MarkdownDiskProjector } from "../src/markdown-projection.js";
import { WorkspaceMirror } from "../src/mirror.js";

function noteType(type: string): IPageType {
  return definePageType({
    type,
    version: 1,
    initialStatus: "draft",
    statusTransitions: [t("draft", "publish", "published")],
    sections: {
      body: { name: "Body", required: true, mutableIn: ["draft", "published"], fields: { text: { kind: "prose" } } },
    },
    commands: {
      setBody: {
        args: zodSchema(z.object({ text: z.string() })),
        target: { section: "body", field: "text" },
        set: { text: arg("text") },
      },
    },
    render: { sections: [{ section: "body", heading: "Body", field: "text", as: "block" }] },
  });
}

const Note = noteType("note");
const Folder = noteType("folder");
const ALL_TYPES = [Note, Folder] as const;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("wiki-mirror — subtree mirrors", () => {
  let server: { url: string; stop: () => Promise<void> };
  let writerWiki: IWiki;
  let writer: IWorkspaceHandle;
  const cleanup: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    server = await startTestServer();
    writerWiki = wikiOn(server.url, ALL_TYPES, { namespace: "test" });
    writer = await writerWiki.createWorkspace({ name: "Studio" });
  });

  afterEach(async () => {
    for (const c of cleanup.splice(0)) {
      try {
        await c();
      } catch {
        /* best-effort teardown */
      }
    }
    await writerWiki.close();
    await server.stop();
  });

  async function makeMirror(
    root: string,
    subtreeRootId?: string,
    types: readonly IPageType[] = ALL_TYPES,
  ): Promise<WorkspaceMirror> {
    const mirrorWiki = wikiOn(server.url, types, { namespace: "test" });
    const handle = await mirrorWiki.openWorkspace(writer.id);
    const sink = new MarkdownDiskProjector(
      { enabled: true, root, workspaces: [writer.id], layout: "tree", ...(subtreeRootId !== undefined ? { subtreeRootId } : {}) },
      silentLogger,
    );
    const m = new WorkspaceMirror(handle, new Registry(types), sink, writer.id, silentLogger);
    cleanup.push(async () => {
      await m.stop();
      await mirrorWiki.close();
    });
    return m;
  }

  async function freshRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "wiki-mirror-subtree-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    return root;
  }

  const read = (root: string, rel: string): Promise<string> => readFile(join(root, rel), "utf8");
  const exists = async (root: string, rel: string): Promise<boolean> => {
    try {
      await access(join(root, rel));
      return true;
    } catch {
      return false;
    }
  };

  /** Every file under `root` except the manifest, as sorted root-relative paths. */
  async function files(root: string): Promise<string[]> {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name !== ".wiki-md-manifest.json")
      .map((e) => join(e.parentPath, e.name).slice(root.length + 1))
      .sort();
  }

  async function syncUntil(m: WorkspaceMirror, fn: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await m.sync();
      if (await fn()) return;
      if (Date.now() > deadline) throw new Error("syncUntil: timed out");
      await sleep(25);
    }
  }

  /** Core Tech + two games, each game with a child page. */
  async function seed(): Promise<{ core: PageId; ball: PageId; war: PageId; rules: PageId; units: PageId }> {
    const { value: core } = await writer.createPage("folder", { title: "Core Tech", parentId: null });
    const { value: ball } = await writer.createPage("folder", { title: "Ballgame", parentId: null });
    const { value: war } = await writer.createPage("folder", { title: "War", parentId: null });
    const { value: rules } = await writer.createPage("note", { title: "Rules", parentId: ball });
    const { value: units } = await writer.createPage("note", { title: "Units", parentId: war });
    await writer.mutate(rules, "setBody", { text: "ballgame rules" });
    await writer.mutate(units, "setBody", { text: "war units" });
    return { core, ball, war, rules, units };
  }

  it("back-fills only the subtree: the root page is index.md, descendants nest under it", async () => {
    const { ball, rules } = await seed();
    const { value: deep } = await writer.createPage("note", { title: "Deep", parentId: rules });
    const root = await freshRoot();
    const m = await makeMirror(root, ball);
    await m.start();

    expect(await files(root)).toEqual(["index.md", "rules/deep.md", "rules/index.md"]);
    expect(await read(root, "index.md")).toBe(await writer.toMarkdown(ball));
    expect(await read(root, "rules/index.md")).toBe(await writer.toMarkdown(rules));
    expect(await read(root, "rules/deep.md")).toBe(await writer.toMarkdown(deep));
    expect((await m.status()).subtreeTitle).toBe("Ballgame");
  });

  it("writes a childless subtree root to index.md", async () => {
    const { core } = await seed();
    const root = await freshRoot();
    const m = await makeMirror(root, core);
    await m.start();
    expect(await files(root)).toEqual(["index.md"]);
  });

  it("whole-workspace mirrors put top-level pages directly under the root", async () => {
    await seed();
    const root = await freshRoot();
    const m = await makeMirror(root);
    await m.start();
    expect(await files(root)).toEqual(["ballgame/index.md", "ballgame/rules.md", "core-tech.md", "war/index.md", "war/units.md"]);
  });

  it("renaming or reparenting the subtree root moves no file", async () => {
    const { core, ball } = await seed();
    const root = await freshRoot();
    const m = await makeMirror(root, ball);
    await m.start();
    const before = await files(root);

    await writer.setPageTitle(ball, "Sovereign Ballgame");
    await writer.reparent(ball, core);
    await syncUntil(m, async () => (await read(root, "index.md")).includes("Sovereign Ballgame"));
    expect(await files(root)).toEqual(before);
  });

  it("a page reparented between subtrees leaves one root and appears in the other", async () => {
    const { ball, war, rules } = await seed();
    const rootBall = await freshRoot();
    const rootWar = await freshRoot();
    const mBall = await makeMirror(rootBall, ball);
    const mWar = await makeMirror(rootWar, war);
    await mBall.start();
    await mWar.start();
    expect(await exists(rootBall, "rules.md")).toBe(true);

    await writer.reparent(rules, war);
    await syncUntil(mWar, () => exists(rootWar, "rules.md"));
    await syncUntil(mBall, async () => !(await exists(rootBall, "rules.md")));
    expect(await read(rootWar, "rules.md")).toBe(await writer.toMarkdown(rules));
    expect(await files(rootBall)).toEqual(["index.md"]);
  });

  it("archiving inside the subtree parks the file; archiving the subtree root parks everything", async () => {
    const { ball, rules } = await seed();
    const root = await freshRoot();
    const m = await makeMirror(root, ball);
    await m.start();

    await writer.archivePage(rules);
    await syncUntil(m, () => exists(root, `.archived/${archivedFileName(rules)}`));
    expect(await exists(root, "rules.md")).toBe(false);
    await writer.unarchivePage(rules);
    await syncUntil(m, () => exists(root, "rules.md"));

    await writer.archivePage(ball);
    await syncUntil(m, () => exists(root, `.archived/${archivedFileName(ball)}`));
    expect(await files(root)).toEqual([`.archived/${archivedFileName(ball)}`, `.archived/${archivedFileName(rules)}`].sort());

    await writer.unarchivePage(ball);
    await syncUntil(m, () => exists(root, "index.md"));
    expect(await files(root)).toEqual(["index.md", "rules.md"]);
  });

  it("an unknown subtree root fails to start and leaves the root untouched", async () => {
    await seed();
    const root = await freshRoot();
    await writeFile(join(root, "keep.md"), "hand-written\n");
    const m = await makeMirror(root, "folder:does-not-exist");
    await expect(m.start()).rejects.toThrow(/not found/);
    expect(await files(root)).toEqual(["keep.md"]);
    expect((await m.status()).lastReconcileError).toMatch(/not found/);
  });

  it("a subtree root whose type isn't loaded keeps its files frozen and reports why", async () => {
    const { ball, rules } = await seed();
    const root = await freshRoot();
    const m1 = await makeMirror(root, ball);
    await m1.start();
    await m1.stop();
    const before = await files(root);
    await writer.mutate(rules, "setBody", { text: "edited while the type is missing" });

    const m2 = await makeMirror(root, ball, [Note]);
    await expect(m2.start()).rejects.toThrow(/hasn't loaded/);
    expect(await files(root)).toEqual(before);
  });

  it("a commit outside the subtree writes nothing, the manifest included", async () => {
    const { ball, units } = await seed();
    const root = await freshRoot();
    const m = await makeMirror(root, ball);
    await m.start();
    const manifest = join(root, ".wiki-md-manifest.json");
    const bytes = await readFile(manifest, "utf8");
    const mtime = (await stat(manifest)).mtimeMs;
    const head = (await writer.history()).length;

    await sleep(15);
    await writer.mutate(units, "setBody", { text: "edited elsewhere" });
    await syncUntil(m, async () => (await m.status()).appliedVersion > head);
    expect(await readFile(manifest, "utf8")).toBe(bytes);
    expect((await stat(manifest)).mtimeMs).toBe(mtime);
  });

  it("changing an entry's scope on the same root sweeps the old files on restart", async () => {
    const { ball, war } = await seed();
    const root = await freshRoot();
    const whole = await makeMirror(root);
    await whole.start();
    await whole.stop();
    expect(await exists(root, "core-tech.md")).toBe(true);

    const toBall = await makeMirror(root, ball);
    await toBall.start();
    await toBall.stop();
    expect(await files(root)).toEqual(["index.md", "rules.md"]);

    const toWar = await makeMirror(root, war);
    await toWar.start();
    expect(await files(root)).toEqual(["index.md", "units.md"]);
    expect(await read(root, "index.md")).toBe(await writer.toMarkdown(war));
  });

  it("a manifest from the old workspace-folder layout is rebuilt into the root", async () => {
    await seed();
    const root = await freshRoot();
    const legacy = "studio/core-tech.md";
    const body = "old layout\n";
    await mkdir(join(root, "studio"), { recursive: true });
    await writeFile(join(root, legacy), body);
    const hash = createHash("sha256").update(body).digest("hex");
    await writeFile(
      join(root, ".wiki-md-manifest.json"),
      JSON.stringify({ [writer.id]: { version: 999, files: { [legacy]: hash }, pages: {} } }),
    );

    const m = await makeMirror(root);
    await m.start();
    expect(await exists(root, legacy)).toBe(false);
    expect(await exists(root, "studio")).toBe(false);
    expect(await exists(root, "core-tech.md")).toBe(true);
  });
});
