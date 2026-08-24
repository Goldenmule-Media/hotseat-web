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
import type { IWiki, IWorkspaceHandle, IWorkspaceSummary } from "wiki";
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
  async function makeHealth(
    mirrors: readonly WorkspaceMirror[],
    extra: { catalog?: () => Promise<readonly IWorkspaceSummary[]>; nameOf?: (id: string) => string | undefined } = {},
  ): Promise<{ url: string }> {
    const health = await startHealthServer({
      host: "127.0.0.1",
      port: 0,
      namespace: "test",
      streamBaseUrl: url,
      sources: mirrors,
      ...extra,
      logger: silentLogger,
    });
    cleanup.push(() => health.stop());
    return health;
  }

  /** A second read-only wiki on the same server — the catalog source for the health endpoint. */
  function catalogWiki(): IWiki {
    const w = wikiOn(url, PAGE_TYPES, { namespace: "test" });
    cleanup.push(() => w.close());
    return w;
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
    // The process/credentials block a status client needs to explain itself.
    expect(body.pid).toBe(process.pid);
    expect(body.configPath).toBeNull();
    expect(body.auth).toMatchObject({ mode: "none", expired: false });
    expect(body.server).toMatchObject({ reachable: true });
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

  it("merges the catalog name into each workspace entry", async () => {
    const mirror = await makeMirror(await freshRoot());
    await mirror.start();
    const health = await makeHealth([mirror], { nameOf: (id) => (id === writer.id ? "Docs" : undefined) });

    const body = await (await fetch(`${health.url}/_mirror/status`)).json();
    expect(body.workspaces[0].name).toBe("Docs");
  });

  it("GET /_mirror/workspaces returns the catalog, marking which entries this machine mirrors", async () => {
    const other = await writerWiki.createWorkspace({ name: "Other" });
    const root = await freshRoot();
    const mirror = await makeMirror(root);
    await mirror.start();
    const wiki = catalogWiki();
    const health = await makeHealth([mirror], { catalog: () => wiki.listWorkspaces() });

    const res = await fetch(`${health.url}/_mirror/workspaces`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = await res.json();
    expect(body.workspaces).toEqual(
      expect.arrayContaining([
        { id: writer.id, name: "Docs", status: "active", mirroredRoot: root },
        { id: other.id, name: "Other", status: "active", mirroredRoot: null },
      ]),
    );
  });

  it("GET /_mirror/workspaces answers 503 when there is no catalog source", async () => {
    const health = await makeHealth([]);
    const res = await fetch(`${health.url}/_mirror/workspaces`);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("catalog_unavailable");
  });

  it("reports an unreachable stream host as degraded WITHOUT failing the request", async () => {
    const mirror = await makeMirror(await freshRoot());
    await mirror.start();
    const health = await startHealthServer({
      host: "127.0.0.1",
      port: 0,
      namespace: "test",
      streamBaseUrl: url,
      sources: [mirror],
      server: () => ({ reachable: false, lastProbeAt: 1, lastError: "connect ECONNREFUSED", unauthorized: false }),
      logger: silentLogger,
    });
    cleanup.push(() => health.stop());

    // A non-2xx here would tell every client "no mirror is running", which is a lie.
    const res = await fetch(`${health.url}/_mirror/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.server).toMatchObject({ reachable: false, lastError: "connect ECONNREFUSED" });
    // An unreachable host means the tail cannot be trusted, whatever the loop believes.
    expect(body.workspaces[0].connected).toBe(false);
  });

  it("treats a host that answers HTTP errors as degraded — 'answering' is not 'working'", async () => {
    const mirror = await makeMirror(await freshRoot());
    await mirror.start();
    const health = await startHealthServer({
      host: "127.0.0.1",
      port: 0,
      namespace: "test",
      streamBaseUrl: url,
      sources: [mirror],
      // A 502 in front of the stream: reachable, authorized, and getting no commits through.
      server: () => ({ reachable: true, lastProbeAt: 2, lastError: "the stream host answered 502", unauthorized: false }),
      logger: silentLogger,
    });
    cleanup.push(() => health.stop());

    const body = await (await fetch(`${health.url}/_mirror/status`)).json();
    expect(body.status).toBe("degraded");
    expect(body.server.lastError).toMatch(/502/);
  });

  it("reports an expired grant as degraded, naming the user, and never leaks a token", async () => {
    const health = await startHealthServer({
      host: "127.0.0.1",
      port: 0,
      namespace: "test",
      streamBaseUrl: url,
      sources: [],
      auth: () => ({
        mode: "oauth" as const,
        server: url,
        user: "thegoldenmule",
        accessTokenExpiresAt: 1,
        refreshTokenExpiresAt: 2,
        expired: true,
      }),
      logger: silentLogger,
    });
    cleanup.push(() => health.stop());

    const raw = await (await fetch(`${health.url}/_mirror/status`)).text();
    expect(raw).not.toMatch(/Bearer|accessToken"|refreshToken"/);
    const body = JSON.parse(raw);
    expect(body.status).toBe("degraded");
    expect(body.auth).toMatchObject({ mode: "oauth", user: "thegoldenmule", expired: true });
  });

  it("a workspace whose boot failed stays LISTED as disconnected with its reason, not omitted", async () => {
    // An empty registry can't fold this workspace, so the emitter never starts. Omitting it
    // (the old behavior) made a broken emitter indistinguishable from an unconfigured one.
    await writer.createPage("note", { title: "X", parentId: null });
    const root = await freshRoot();
    const running = await startMirror(
      {
        streamBaseUrl: url,
        namespace: "test",
        models: [],
        emitters: [{ workspaceId: writer.id, root }],
        healthHost: "127.0.0.1",
        healthPort: 0,
      },
      silentLogger,
    );
    cleanup.push(() => running.close());

    const body = await (await fetch(`${running.health.url}/_mirror/status`)).json();
    expect(body.status).toBe("degraded");
    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0]).toMatchObject({ workspaceId: writer.id, root, connected: false });
    // wiki-ui checks `lastReconcileError !== null` strictly: an undefined here renders "undefined".
    expect(typeof body.workspaces[0].lastReconcileError).toBe("string");
    expect(body.workspaces[0].attempts).toBeGreaterThan(0);
    expect(running.mirrors).toHaveLength(0); // listed, but no tail loop is running
  });
});
