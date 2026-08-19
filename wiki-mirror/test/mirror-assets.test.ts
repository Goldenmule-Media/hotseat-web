/**
 * Attachments on disk: the mirror downloads what a page's Markdown references, writes it
 * beside the tree, and rewrites the ref to a path relative to the page that carries it —
 * which is what makes images actually render on GitHub.
 *
 * The blob endpoint is a real in-process http server, so the AttachmentClient's wire shape
 * is exercised rather than mocked.
 */
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { definePageType, t, z, zodSchema } from "wiki";
import { parseBlocks } from "wiki/authoring";
import type { IWiki, IWorkspaceHandle } from "wiki";
import { AttachmentClient } from "wiki/attachments";
import { Registry } from "wiki/registry";
import { startTestServer, wikiOn } from "wiki/testing";

import { silentLogger } from "../src/logger.js";
import { MarkdownDiskProjector } from "../src/markdown-projection.js";
import { WorkspaceMirror } from "../src/mirror.js";

const Note = definePageType({
  type: "note",
  version: 1,
  initialStatus: "draft",
  statusTransitions: [t("draft", "publish", "published")],
  sections: {
    body: { name: "Body", required: true, mutableIn: ["draft"], fields: { doc: { kind: "blocks" } } },
  },
  commands: {
    setBody: {
      args: zodSchema(z.object({ markdown: z.string() })),
      target: { section: "body", field: "doc" },
      produces: (_p, args, ctx) => [
        {
          op: "setField",
          section: "body",
          field: "doc",
          value: { kind: "blocks", blocks: parseBlocks((args as { markdown: string }).markdown, ctx.newId) },
        },
      ],
    },
  },
  render: { sections: [{ section: "body", heading: "Body", field: "doc", as: "blocks" }] },
});

const PAGE_TYPES = [Note] as const;
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const SHA = createHash("sha256").update(PNG).digest("hex");
const PDF = Buffer.from("%PDF-1.7\n%%EOF\n", "utf8");
const PDF_SHA = createHash("sha256").update(PDF).digest("hex");

describe("wiki-mirror — attachments as on-disk assets", () => {
  let server: { url: string; stop: () => Promise<void> };
  let blobServer: Server;
  let blobBase: string;
  let writerWiki: IWiki;
  let writer: IWorkspaceHandle;
  let downloads = 0;
  const cleanup: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    server = await startTestServer();
    writerWiki = wikiOn(server.url, PAGE_TYPES, { namespace: "test" });
    writer = await writerWiki.createWorkspace({ name: "Docs" });

    downloads = 0;
    blobServer = createServer((req, res) => {
      downloads++;
      const id = req.url!.split("/").pop()!;
      const body = id === SHA ? PNG : id === PDF_SHA ? PDF : undefined;
      if (body === undefined) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "no such blob" }));
        return;
      }
      res.writeHead(200, {
        "content-type": id === SHA ? "image/png" : "application/pdf",
        "content-disposition": `inline; filename="${id === SHA ? "shot.png" : "report.pdf"}"`,
      });
      res.end(body);
    });
    await new Promise<void>((r) => blobServer.listen(0, "127.0.0.1", r));
    blobBase = `http://127.0.0.1:${(blobServer.address() as AddressInfo).port}`;
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
    await new Promise<void>((r) => blobServer.close(() => r()));
  });

  async function makeMirror(root: string): Promise<WorkspaceMirror> {
    const mirrorWiki = wikiOn(server.url, PAGE_TYPES, { namespace: "test" });
    const handle = await mirrorWiki.openWorkspace(writer.id);
    const sink = new MarkdownDiskProjector(
      { enabled: true, root, workspaces: [writer.id], layout: "tree" },
      silentLogger,
      new AttachmentClient({ baseUrl: blobBase, namespace: "test" }),
    );
    const m = new WorkspaceMirror(handle, new Registry(PAGE_TYPES), sink, writer.id, silentLogger);
    cleanup.push(async () => {
      await m.stop();
      await mirrorWiki.close();
    });
    return m;
  }

  async function freshRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "wiki-assets-"));
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    return root;
  }

  /** Poll until `fn` holds, forcing a reconcile each round — the mirror's handle may not
   *  have seen the writer's commit yet when sync() is first called. */
  async function syncUntil(m: WorkspaceMirror, fn: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await m.sync();
      if (await fn()) return;
      if (Date.now() > deadline) throw new Error("timed out waiting for the mirror to settle");
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  const exists = async (root: string, rel: string): Promise<boolean> => {
    try {
      await access(join(root, rel));
      return true;
    } catch {
      return false;
    }
  };

  it("downloads an attachment, writes it beside the tree, and rewrites the ref relatively", async () => {
    const root = await freshRoot();
    const page = (await writer.createPage("note", { title: "With Image", parentId: null })).value;
    await writer.mutate(page, "setBody", { markdown: `![A screenshot](attachment:${SHA})` });

    const m = await makeMirror(root);
    await m.start();

    // The bytes land content-addressed, with an extension derived from the served mime.
    expect(await exists(root, `docs/.assets/${SHA}.png`)).toBe(true);
    expect((await readFile(join(root, `docs/.assets/${SHA}.png`))).equals(PNG)).toBe(true);

    // A top-level page sits at docs/<slug>.md, so the ref resolves as `.assets/<sha>.png`.
    const md = await readFile(join(root, "docs/with-image.md"), "utf8");
    expect(md).toContain(`![A screenshot](.assets/${SHA}.png)`);
    expect(md).not.toContain("attachment:");
  });

  it("resolves the ref from a nested page's own directory", async () => {
    const root = await freshRoot();
    const parent = (await writer.createPage("note", { title: "Parent", parentId: null })).value;
    const child = (await writer.createPage("note", { title: "Child", parentId: parent })).value;
    await writer.mutate(child, "setBody", { markdown: `![Deep](attachment:${SHA})` });

    const m = await makeMirror(root);
    await m.start();

    // A page with children becomes a folder + index.md, so the child sits one level down
    // and must climb back out to reach the shared assets directory.
    const md = await readFile(join(root, "docs/parent/child.md"), "utf8");
    expect(md).toContain(`![Deep](../.assets/${SHA}.png)`);
  });

  it("handles a non-image attachment the same way", async () => {
    const root = await freshRoot();
    const page = (await writer.createPage("note", { title: "With Pdf", parentId: null })).value;
    await writer.mutate(page, "setBody", { markdown: `[Q3 report](attachment:${PDF_SHA})` });

    const m = await makeMirror(root);
    await m.start();

    expect(await exists(root, `docs/.assets/${PDF_SHA}.pdf`)).toBe(true);
    const md = await readFile(join(root, "docs/with-pdf.md"), "utf8");
    // The rewrite is a substitution of the ref string, so a link and an image both work.
    expect(md).toContain(`[Q3 report](.assets/${PDF_SHA}.pdf)`);
  });

  it("does not re-download an attachment it already has", async () => {
    const root = await freshRoot();
    const page = (await writer.createPage("note", { title: "Stable", parentId: null })).value;
    await writer.mutate(page, "setBody", { markdown: `![Shot](attachment:${SHA})` });

    const m = await makeMirror(root);
    await m.start();
    const first = downloads;
    expect(first).toBe(1);

    // Another commit re-renders every page; content-addressed bytes never change, so the
    // asset must be recognised rather than fetched again.
    await writer.mutate(page, "setBody", { markdown: `![Shot](attachment:${SHA})\n\nAnd a caption.` });
    await syncUntil(m, async () => (await readFile(join(root, "docs/stable.md"), "utf8")).includes("And a caption."));
    expect(downloads).toBe(first);
    expect(await exists(root, `docs/.assets/${SHA}.png`)).toBe(true);
  });

  it("collects an asset once nothing references it", async () => {
    const root = await freshRoot();
    const page = (await writer.createPage("note", { title: "Transient", parentId: null })).value;
    await writer.mutate(page, "setBody", { markdown: `![Shot](attachment:${SHA})` });

    const m = await makeMirror(root);
    await m.start();
    expect(await exists(root, `docs/.assets/${SHA}.png`)).toBe(true);

    await writer.mutate(page, "setBody", { markdown: "No image any more." });
    await syncUntil(m, async () => !(await exists(root, `docs/.assets/${SHA}.png`)));
    expect(await exists(root, `docs/.assets/${SHA}.png`)).toBe(false);
    // The emptied directory prunes itself rather than lingering.
    expect(await exists(root, "docs/.assets")).toBe(false);
  });

  it("leaves the ref verbatim when the attachment cannot be fetched", async () => {
    const root = await freshRoot();
    const missing = "f".repeat(64);
    const page = (await writer.createPage("note", { title: "Broken", parentId: null })).value;
    await writer.mutate(page, "setBody", { markdown: `![Gone](attachment:${missing})` });

    const m = await makeMirror(root);
    await m.start();

    // One unreachable attachment must not stall the mirror or lose the page.
    const md = await readFile(join(root, "docs/broken.md"), "utf8");
    expect(md).toContain(`![Gone](attachment:${missing})`);
  });

  it("keeps assets across a restart without re-downloading them", async () => {
    const root = await freshRoot();
    const page = (await writer.createPage("note", { title: "Durable", parentId: null })).value;
    await writer.mutate(page, "setBody", { markdown: `![Shot](attachment:${SHA})` });

    const first = await makeMirror(root);
    await first.start();
    await first.stop();
    const after = downloads;

    // A fresh projector re-verifies the manifest against disk. Binary assets must survive
    // that check — hashing them as text would mark every one stale on every boot.
    const second = await makeMirror(root);
    await second.start();
    expect(downloads).toBe(after);
    expect(await exists(root, `docs/.assets/${SHA}.png`)).toBe(true);
  });
});
