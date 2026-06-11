/**
 * wiki-mirror end-to-end: drive the REAL engine through its public surface (`wiki/testing`),
 * tail the workspace stream with a {@link WorkspaceMirror}, and assert the on-disk Markdown
 * tracks the wiki — byte-identical to the render, nested per the page tree, no churn on
 * unchanged pages, and correct on live commit / rename / reparent / archive / restart.
 *
 * A WRITER wiki commits; a separate MIRROR wiki (same server + namespace) opens the same
 * workspace and is what the mirror tails — exactly the real shape (the mirror reads a possibly
 * remote stream and authors nothing back).
 */
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { arg, definePageType, t, z, zodSchema } from "wiki";
import type { IWiki, IWorkspaceHandle } from "wiki";
import { Registry } from "wiki/registry";
import { startTestServer, wikiOn } from "wiki/testing";

import { silentLogger } from "../src/logger.js";
import { archivedFileName, MarkdownDiskProjector } from "../src/markdown-projection.js";
import { WorkspaceMirror } from "../src/mirror.js";

const Note = definePageType({
  type: "note",
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
    publish: { args: zodSchema(z.object({})), transition: { level: "page", event: "publish" } },
  },
  render: { sections: [{ section: "body", heading: "Body", field: "text", as: "block" }] },
});

const PAGE_TYPES = [Note] as const;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("wiki-mirror — tail a workspace stream to a local Markdown mirror", () => {
  let server: { url: string; stop: () => Promise<void> };
  let url: string;
  let writerWiki: IWiki;
  let writer: IWorkspaceHandle;
  const cleanup: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    server = await startTestServer();
    url = server.url;
    writerWiki = wikiOn(url, PAGE_TYPES, { namespace: "test" });
    writer = await writerWiki.createWorkspace({ name: "Docs" });
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

  /** Build a mirror over `target` writing to `root`; registered for teardown. */
  async function makeMirrorFor(target: IWorkspaceHandle, root: string): Promise<WorkspaceMirror> {
    const mirrorWiki = wikiOn(url, PAGE_TYPES, { namespace: "test" });
    const handle = await mirrorWiki.openWorkspace(target.id);
    const sink = new MarkdownDiskProjector(
      { enabled: true, root, workspaces: [target.id], layout: "tree" },
      silentLogger,
    );
    const m = new WorkspaceMirror(handle, new Registry(PAGE_TYPES), sink, target.id, silentLogger);
    cleanup.push(async () => {
      await m.stop();
      await mirrorWiki.close();
    });
    return m;
  }
  const makeMirror = (root: string): Promise<WorkspaceMirror> => makeMirrorFor(writer, root);

  async function freshRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "wiki-mirror-"));
    cleanup.push(async () => {
      await rm(root, { recursive: true, force: true });
    });
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

  /** Poll until `fn` holds, forcing a reconcile each round (also lets the handle's tail catch up). */
  async function syncUntil(m: WorkspaceMirror, fn: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await m.sync();
      if (await fn()) return;
      if (Date.now() > deadline) throw new Error("syncUntil: timed out");
      await sleep(25);
    }
  }
  /** Poll until `fn` holds WITHOUT forcing a sync — proves the live subscribe path on its own. */
  async function waitFor(fn: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await fn()) return;
      if (Date.now() > deadline) throw new Error("waitFor: timed out");
      await sleep(25);
    }
  }

  it("back-fills the tree from head — nested folders, parent-with-children as index.md, byte-identical", async () => {
    const { value: parent } = await writer.createPage("note", { title: "Guide", parentId: null });
    const { value: child } = await writer.createPage("note", { title: "Intro", parentId: parent });
    await writer.mutate(parent, "setBody", { text: "guide body" });
    await writer.mutate(child, "setBody", { text: "intro body" });
    const { value: leaf } = await writer.createPage("note", { title: "Top", parentId: null });

    const root = await freshRoot();
    const mirror = await makeMirror(root);
    await mirror.start(); // boot back-fill is synchronous

    expect(await exists(root, "docs/guide/index.md")).toBe(true);
    expect(await exists(root, "docs/guide/intro.md")).toBe(true);
    expect(await exists(root, "docs/top.md")).toBe(true);
    expect(await read(root, "docs/guide/index.md")).toBe(await writer.toMarkdown(parent));
    expect(await read(root, "docs/guide/intro.md")).toBe(await writer.toMarkdown(child));
    expect(await read(root, "docs/top.md")).toBe(await writer.toMarkdown(leaf));
  });

  it("mirrors a new commit live — driven only by the stream subscription", async () => {
    const root = await freshRoot();
    const mirror = await makeMirror(root);
    await mirror.start();

    const { value: page } = await writer.createPage("note", { title: "Live", parentId: null });
    await writer.mutate(page, "setBody", { text: "streamed in" });

    await waitFor(async () => (await exists(root, "docs/live.md")) && (await read(root, "docs/live.md")).includes("streamed in"));
    expect(await read(root, "docs/live.md")).toBe(await writer.toMarkdown(page));
  });

  it("moves a renamed sibling and leaves unchanged files untouched (no churn)", async () => {
    const { value: parent } = await writer.createPage("note", { title: "Guide", parentId: null });
    await writer.createPage("note", { title: "Alpha", parentId: parent });
    const { value: b } = await writer.createPage("note", { title: "Beta", parentId: parent });
    const root = await freshRoot();
    const mirror = await makeMirror(root);
    await mirror.start();
    expect(await exists(root, "docs/guide/alpha.md")).toBe(true);
    const alphaMtime = (await stat(join(root, "docs/guide/alpha.md"))).mtimeMs;

    await sleep(15);
    await writer.setPageTitle(b, "Bravo"); // structural → whole rebuild
    await syncUntil(mirror, () => exists(root, "docs/guide/bravo.md"));

    expect(await exists(root, "docs/guide/beta.md")).toBe(false);
    expect(await read(root, "docs/guide/bravo.md")).toBe(await writer.toMarkdown(b));
    expect((await stat(join(root, "docs/guide/alpha.md"))).mtimeMs).toBe(alphaMtime); // unchanged → not rewritten
  });

  it("reflects a reparent — moves the subtree and reshapes the old parent", async () => {
    const { value: guide } = await writer.createPage("note", { title: "Guide", parentId: null });
    const { value: manual } = await writer.createPage("note", { title: "Manual", parentId: null });
    const { value: intro } = await writer.createPage("note", { title: "Intro", parentId: guide });
    const root = await freshRoot();
    const mirror = await makeMirror(root);
    await mirror.start();
    expect(await exists(root, "docs/guide/intro.md")).toBe(true);

    await writer.reparent(intro, manual);
    await syncUntil(mirror, () => exists(root, "docs/manual/intro.md"));

    expect(await exists(root, "docs/guide/intro.md")).toBe(false);
    expect(await read(root, "docs/manual/intro.md")).toBe(await writer.toMarkdown(intro));
    expect(await exists(root, "docs/guide/index.md")).toBe(false); // childless → flips back to a leaf
    expect(await exists(root, "docs/guide.md")).toBe(true);
  });

  it("archiving moves a file under .archived/ (never deletes); unarchiving moves it back", async () => {
    const { value: temp } = await writer.createPage("note", { title: "Temp", parentId: null });
    await writer.mutate(temp, "setBody", { text: "keep me" });
    const root = await freshRoot();
    const mirror = await makeMirror(root);
    await mirror.start();
    expect(await exists(root, "docs/temp.md")).toBe(true);

    const archivedRel = `docs/.archived/${archivedFileName(temp)}`;
    await writer.archivePage(temp);
    await syncUntil(mirror, () => exists(root, archivedRel));
    expect(await exists(root, "docs/temp.md")).toBe(false);
    expect(await read(root, archivedRel)).toContain("keep me");

    await writer.unarchivePage(temp);
    await syncUntil(mirror, () => exists(root, "docs/temp.md"));
    expect(await exists(root, archivedRel)).toBe(false);
  });

  it("self-heals a wiped output directory on restart — reconstructs from head", async () => {
    const { value: page } = await writer.createPage("note", { title: "Guide", parentId: null });
    await writer.mutate(page, "setBody", { text: "durable" });
    const root = await freshRoot();
    const m1 = await makeMirror(root);
    await m1.start();
    const expected = await read(root, "docs/guide.md");
    await m1.stop();

    await rm(root, { recursive: true, force: true }); // wipe manifest + files

    const m2 = await makeMirror(root);
    await m2.start(); // init → empty manifest → back-fill rebuilds from head
    expect(await exists(root, "docs/guide.md")).toBe(true);
    expect(await read(root, "docs/guide.md")).toBe(expected);
  });

  it("mirrors multiple workspaces, each under its own subdir, from independent loops", async () => {
    const other = await writerWiki.createWorkspace({ name: "Other" });
    await writer.createPage("note", { title: "One", parentId: null });
    await other.createPage("note", { title: "Two", parentId: null });
    const root = await freshRoot();
    const m1 = await makeMirror(root);
    const m2 = await makeMirrorFor(other, root);
    await m1.start();
    await m2.start();

    expect(await exists(root, "docs/one.md")).toBe(true);
    expect(await exists(root, "other/two.md")).toBe(true);
  });

  it("never appends to the workspace stream (read-only)", async () => {
    await writer.createPage("note", { title: "Solo", parentId: null });
    const before = (await writer.history()).length;
    const root = await freshRoot();
    const mirror = await makeMirror(root);
    await mirror.start();
    await mirror.sync();
    expect((await writer.history()).length).toBe(before);
  });
});
