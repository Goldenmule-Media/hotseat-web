/**
 * A cross-workspace page move as two mirrors see it: the moved pages' files leave the source
 * mirror (a move, not an archive, so they don't park in `.archived/`) and appear in the
 * target's mirror.
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { arg, definePageType, t, z, zodSchema } from "wiki";
import type { IPageType, IWiki, IWorkspaceHandle, WorkspaceId } from "wiki";
import { movePages } from "wiki/admin";
import { Registry } from "wiki/registry";
import { startTestServer, wikiOn } from "wiki/testing";

import { silentLogger } from "../src/logger.js";
import { MarkdownDiskProjector } from "../src/markdown-projection.js";
import { WorkspaceMirror } from "../src/mirror.js";

const Note: IPageType = definePageType({
  type: "note",
  version: 1,
  initialStatus: "draft",
  statusTransitions: [t("draft", "publish", "published")],
  sections: {
    body: { name: "Body", required: true, mutableIn: ["draft"], fields: { text: { kind: "prose" } } },
  },
  commands: {
    setBody: { args: zodSchema(z.object({ text: z.string() })), target: { section: "body", field: "text" }, set: { text: arg("text") } },
  },
  render: { sections: [{ section: "body", heading: "Body", field: "text", as: "block" }] },
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("wiki-mirror — a page moved to another workspace", () => {
  let server: { url: string; stop: () => Promise<void> };
  let writerWiki: IWiki;
  let src: IWorkspaceHandle;
  let dst: IWorkspaceHandle;
  const cleanup: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    server = await startTestServer();
    writerWiki = wikiOn(server.url, [Note], { namespace: "test" });
    src = await writerWiki.createWorkspace({ name: "Godot Addons" });
    dst = await writerWiki.createWorkspace({ name: "Sovereign Axe" });
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

  async function mirrorOf(ws: WorkspaceId): Promise<{ root: string; mirror: WorkspaceMirror }> {
    const root = await mkdtemp(join(tmpdir(), "wiki-mirror-move-"));
    const mirrorWiki = wikiOn(server.url, [Note], { namespace: "test" });
    const handle = await mirrorWiki.openWorkspace(ws);
    const sink = new MarkdownDiskProjector({ enabled: true, root, workspaces: [ws], layout: "tree" }, silentLogger);
    const mirror = new WorkspaceMirror(handle, new Registry([Note]), sink, ws, silentLogger);
    cleanup.push(async () => {
      await mirror.stop();
      await mirrorWiki.close();
      await rm(root, { recursive: true, force: true });
    });
    await mirror.start();
    return { root, mirror };
  }

  async function files(root: string): Promise<string[]> {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name !== ".wiki-md-manifest.json")
      .map((e) => join(e.parentPath, e.name).slice(root.length + 1))
      .sort();
  }

  async function syncUntil(mirrors: WorkspaceMirror[], fn: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (const m of mirrors) await m.sync();
      if (await fn()) return;
      if (Date.now() > deadline) throw new Error("syncUntil: timed out");
      await sleep(25);
    }
  }

  it("removes the moved files from the source mirror and writes them in the target's", async () => {
    const { value: kit } = await src.createPage("note", { title: "Kit", parentId: null });
    const { value: usage } = await src.createPage("note", { title: "Usage", parentId: kit });
    await src.createPage("note", { title: "Stay", parentId: null });
    await src.mutate(usage, "setBody", { text: "how to use the kit" });

    const from = await mirrorOf(src.id);
    const to = await mirrorOf(dst.id);
    expect(await files(from.root)).toEqual(["kit/index.md", "kit/usage.md", "stay.md"]);
    expect(await files(to.root)).toEqual([]);

    await movePages({ open: (id) => writerWiki.openWorkspace(id), from: src.id, to: dst.id, pageIds: [kit], parentId: null });

    await syncUntil([from.mirror, to.mirror], async () => (await files(to.root)).length === 2 && (await files(from.root)).length === 1);
    expect(await files(from.root)).toEqual(["stay.md"]);
    expect(await files(to.root)).toEqual(["kit/index.md", "kit/usage.md"]);
    expect(await readFile(join(to.root, "kit/usage.md"), "utf8")).toBe(await dst.toMarkdown(usage));
  });
});
