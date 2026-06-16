/**
 * The local health endpoint: a real {@link WorkspaceMirror} tailing a real engine (via
 * `wiki/testing`), fronted by {@link startHealthServer} on port 0. Asserts liveness, the
 * per-workspace status payload, the degraded path, CORS, and routing — plus that
 * {@link startMirror} exposes and tears down the listener.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { arg, definePageType, t, z, zodSchema } from "wiki";
import type { IWiki, IWorkspaceHandle } from "wiki";
import { Registry } from "wiki/registry";
import { startTestServer, wikiOn } from "wiki/testing";

import { silentLogger } from "../src/logger.js";
import { startHealthServer } from "../src/health.js";
import { startMirror } from "../src/main.js";
import { MarkdownDiskProjector } from "../src/markdown-projection.js";
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

describe("wiki-mirror — local health endpoint", () => {
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

  async function freshRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "wiki-mirror-health-"));
    cleanup.push(async () => {
      await rm(root, { recursive: true, force: true });
    });
    return root;
  }

  /** Build a mirror over `writer` writing to `root`, with the given registry (default: real types). */
  async function makeMirror(root: string, registry = new Registry(PAGE_TYPES)): Promise<WorkspaceMirror> {
    const mirrorWiki = wikiOn(url, PAGE_TYPES, { namespace: "test" });
    const handle = await mirrorWiki.openWorkspace(writer.id);
    const sink = new MarkdownDiskProjector(
      { enabled: true, root, workspaces: [writer.id], layout: "tree" },
      silentLogger,
    );
    const m = new WorkspaceMirror(handle, registry, sink, writer.id, silentLogger);
    cleanup.push(async () => {
      await m.stop();
      await mirrorWiki.close();
    });
    return m;
  }

  /** Start a health server over `mirrors` on an ephemeral port; registered for teardown. */
  async function makeHealth(mirrors: readonly WorkspaceMirror[]): Promise<{ url: string }> {
    const health = await startHealthServer({
      host: "127.0.0.1",
      port: 0,
      namespace: "test",
      streamBaseUrl: url,
      mirrors,
      logger: silentLogger,
    });
    cleanup.push(() => health.stop());
    return health;
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

  it("GET /_mirror/health returns 200 {status:'ok'}", async () => {
    const mirror = await makeMirror(await freshRoot());
    await mirror.start();
    const health = await makeHealth([mirror]);

    const res = await fetch(`${health.url}/_mirror/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET /_mirror/status reports the workspace's root, applied version, and a numeric uptime", async () => {
    await writer.createPage("note", { title: "One", parentId: null });
    const root = await freshRoot();
    const mirror = await makeMirror(root);
    await mirror.start();
    const health = await makeHealth([mirror]);

    const head = (await writer.history()).length; // 0-based count == applied version
    const res = await fetch(`${health.url}/_mirror/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.uptimeMs).toBe("number");
    expect(body.namespace).toBe("test");
    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0]).toMatchObject({ workspaceId: writer.id, root, appliedVersion: head, connected: true });
  });

  it("a healthy reconcile sets lastReconcileAt and clears lastReconcileError", async () => {
    const mirror = await makeMirror(await freshRoot());
    await mirror.start();
    await writer.createPage("note", { title: "Two", parentId: null });
    await syncUntil(mirror, async () => true); // force one more reconcile after the write
    const health = await makeHealth([mirror]);

    const body = await (await fetch(`${health.url}/_mirror/status`)).json();
    expect(typeof body.workspaces[0].lastReconcileAt).toBe("number");
    expect(body.workspaces[0].lastReconcileError).toBeNull();
  });

  it("a reconcile failure flips overall status to 'degraded' with a non-null error", async () => {
    await writer.createPage("note", { title: "Boom", parentId: null });
    // Empty registry → folding a non-empty workspace throws → reconcile records the error.
    const bad = await makeMirror(await freshRoot(), new Registry([]));
    await bad.sync().catch(() => {});
    const health = await makeHealth([bad]);

    const body = await (await fetch(`${health.url}/_mirror/status`)).json();
    expect(body.status).toBe("degraded");
    expect(typeof body.workspaces[0].lastReconcileError).toBe("string");
    expect(body.workspaces[0].lastReconcileError).not.toBeNull();
  });

  it("sends permissive CORS on GET and answers an OPTIONS preflight with 204", async () => {
    const mirror = await makeMirror(await freshRoot());
    await mirror.start();
    const health = await makeHealth([mirror]);

    const get = await fetch(`${health.url}/_mirror/status`);
    expect(get.headers.get("access-control-allow-origin")).toBe("*");

    const preflight = await fetch(`${health.url}/_mirror/status`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("returns 404 for an unknown path and 405 for a non-GET method", async () => {
    const health = await makeHealth([]);
    expect((await fetch(`${health.url}/nope`)).status).toBe(404);
    expect((await fetch(`${health.url}/_mirror/status`, { method: "POST" })).status).toBe(405);
  });

  it("startMirror exposes running.health.url and close() stops the listener", async () => {
    await writer.createPage("note", { title: "X", parentId: null });
    const root = await freshRoot();
    const running = await startMirror(
      {
        streamBaseUrl: url,
        namespace: "test",
        models: [], // empty registry → the note workspace can't fold → it's skipped (see mirror.test.ts)
        emitters: [{ workspaceId: writer.id, root }],
        healthHost: "127.0.0.1",
        healthPort: 0,
      },
      silentLogger,
    );
    // The workspace is skipped (empty registry), but the health server still starts.
    // Assert it's reachable, then that close() stops it.
    expect(running.health.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(`${running.health.url}/_mirror/health`)).status).toBe(200);

    await running.close();
    await expect(fetch(`${running.health.url}/_mirror/health`)).rejects.toThrow();
  });
});
