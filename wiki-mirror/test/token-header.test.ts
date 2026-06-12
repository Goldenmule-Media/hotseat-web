/**
 * Bearer-token auth on the wire. A recording `node:http` pass-through proxy sits between the
 * client under test and the REAL in-memory Durable Streams server (`wiki/testing`), capturing
 * every request's `authorization` header. Proves a configured token reaches the wire on every
 * stream request — through wiki-mirror's own `startMirror` createWiki path and through the
 * engine seam (`wikiOn(..., { headers })`, the write/append path) — and that NO header is sent
 * when no token is configured (byte-identical behavior to before).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startTestServer, wikiOn } from "wiki/testing";
import { CredentialsStore, defaultCredentialsPath } from "wiki/auth-client";

import { silentLogger } from "../src/logger.js";
import { startMirror } from "../src/main.js";

/** A pass-through proxy that records the `authorization` header of every request it forwards. */
interface RecordingProxy {
  readonly url: string;
  /** Captured `authorization` header per proxied request, in arrival order. */
  readonly auths: (string | undefined)[];
  stop(): Promise<void>;
}

/** Start a recording proxy in front of `targetUrl`; pipes requests/responses through verbatim. */
async function startRecordingProxy(targetUrl: string): Promise<RecordingProxy> {
  const target = new URL(targetUrl);
  const auths: (string | undefined)[] = [];
  const server: Server = createServer((req, res) => {
    auths.push(req.headers.authorization);
    const upstream = httpRequest(
      {
        host: target.hostname,
        port: Number(target.port),
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: target.host },
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.on("error", () => res.end());
        upRes.pipe(res); // streams long-poll/SSE bodies through unbuffered
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    // A client that walks away (e.g. an aborted live tail on close()) tears down both legs.
    req.on("error", () => upstream.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    auths,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections(); // in-flight live tails would otherwise pin close()
        server.close((err) => (err === undefined ? resolve() : reject(err)));
      }),
  };
}

describe("wiki-mirror — bearer token on the wire", () => {
  let server: { url: string; stop: () => Promise<void> };
  let proxy: RecordingProxy;
  const cleanup: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    server = await startTestServer();
    proxy = await startRecordingProxy(server.url);
  });

  afterEach(async () => {
    for (const c of cleanup.splice(0)) {
      try {
        await c();
      } catch {
        /* best-effort teardown */
      }
    }
    await proxy.stop();
    await server.stop();
  });

  /** A page-less workspace created straight against the server (so only mirror traffic is captured). */
  async function makeWorkspace(): Promise<string> {
    const writer = wikiOn(server.url, [], { namespace: "test" });
    cleanup.push(() => writer.close());
    const ws = await writer.createWorkspace({ name: "Docs" });
    return ws.id;
  }

  async function freshRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "wiki-mirror-auth-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    return root;
  }

  it("startMirror with a token sends `Bearer <token>` on every stream request", async () => {
    const workspaceId = await makeWorkspace();
    const running = await startMirror(
      {
        streamBaseUrl: proxy.url,
        namespace: "test",
        models: [],
        emitters: [{ workspaceId, root: await freshRoot() }],
        token: "mirror-token",
      },
      silentLogger,
    );
    cleanup.push(() => running.close());

    expect(running.mirrors.length).toBe(1); // booted through the proxy, not skipped
    expect(proxy.auths.length).toBeGreaterThan(0);
    expect([...new Set(proxy.auths)]).toEqual(["Bearer mirror-token"]);
  });

  it("startMirror without a token sends NO authorization header (unchanged behavior)", async () => {
    const workspaceId = await makeWorkspace();
    const running = await startMirror(
      { streamBaseUrl: proxy.url, namespace: "test", models: [], emitters: [{ workspaceId, root: await freshRoot() }] },
      silentLogger,
    );
    cleanup.push(() => running.close());

    expect(running.mirrors.length).toBe(1);
    expect(proxy.auths.length).toBeGreaterThan(0);
    expect([...new Set(proxy.auths)]).toEqual([undefined]);
  });

  /** Seed ~/.wiki/credentials.json under a throwaway HOME for `serverUrl`. */
  async function seedCredentials(serverUrl: string, accessToken: string): Promise<void> {
    const home = await mkdtemp(join(tmpdir(), "wiki-mirror-home-"));
    const realHome = process.env.HOME;
    process.env.HOME = home;
    cleanup.push(async () => {
      process.env.HOME = realHome;
      await rm(home, { recursive: true, force: true });
    });
    const now = Math.floor(Date.now() / 1000);
    new CredentialsStore(defaultCredentialsPath(process.env)).set(serverUrl, {
      clientId: "wsid1.test.sig",
      accessToken,
      accessTokenExp: now + 3600, // fresh — no refresh traffic in this test
      refreshToken: "wsr1.test.sig",
      refreshTokenExp: now + 86_400,
      tokenEndpoint: `${serverUrl}/auth/token`,
      user: "alice",
    });
  }

  it("startMirror with NO token falls back to a stored OAuth grant (refreshing header function)", async () => {
    const workspaceId = await makeWorkspace();
    await seedCredentials(proxy.url, "stored-access-token");
    const running = await startMirror(
      { streamBaseUrl: proxy.url, namespace: "test", models: [], emitters: [{ workspaceId, root: await freshRoot() }] },
      silentLogger,
    );
    cleanup.push(() => running.close());

    expect(running.mirrors.length).toBe(1);
    expect(proxy.auths.length).toBeGreaterThan(0);
    expect([...new Set(proxy.auths)]).toEqual(["Bearer stored-access-token"]);
  });

  it("an explicit static token still WINS over stored credentials (precedence preserved)", async () => {
    const workspaceId = await makeWorkspace();
    await seedCredentials(proxy.url, "stored-access-token");
    const running = await startMirror(
      {
        streamBaseUrl: proxy.url,
        namespace: "test",
        models: [],
        emitters: [{ workspaceId, root: await freshRoot() }],
        token: "explicit-static-token",
      },
      silentLogger,
    );
    cleanup.push(() => running.close());

    expect([...new Set(proxy.auths)]).toEqual(["Bearer explicit-static-token"]);
  });

  it("engine seam: wikiOn headers ride writes too (createWorkspace through the proxy)", async () => {
    const wiki = wikiOn(proxy.url, [], {
      namespace: "test",
      headers: { authorization: "Bearer engine-token" },
    });
    cleanup.push(() => wiki.close());

    const ws = await wiki.createWorkspace({ name: "Auth" }); // append path
    await ws.history(); // read path

    expect(proxy.auths.length).toBeGreaterThan(0);
    expect([...new Set(proxy.auths)]).toEqual(["Bearer engine-token"]);
  });
});
