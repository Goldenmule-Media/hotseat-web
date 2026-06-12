/**
 * `wiki/auth-client` unit tests against a stub authorization server (node:http,
 * no network, no browser): discovery, the loopback login dance end-to-end (the
 * test plays the browser), the credentials store's permissions/atomicity, and
 * the refreshing `oauthHeaders` function — cached while fresh, one shared
 * refresh when stale, rotation persisted.
 */
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CredentialsStore,
  discoverAuthServer,
  loginLoopback,
  oauthHeaders,
  resolveAuthorization,
  type ServerCredentials,
} from "../src/auth-client";

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
/** A decodable stand-in for the server's signed blobs (the client never verifies them). */
const fakeToken = (prefix: string, payload: Record<string, unknown>): string => `${prefix}.${b64(payload)}.sig`;

/** A stub wiki-server gateway: discovery + register + authorize + token. */
interface StubAS {
  readonly url: string;
  /** Count of POST /auth/token calls per grant type. */
  readonly grants: { code: number; refresh: number };
  stop(): Promise<void>;
}

async function startStubAS(): Promise<StubAS> {
  const grants = { code: 0, refresh: 0 };
  let urlBase = "";
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", urlBase);
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      json(200, { resource: urlBase, authorization_servers: [urlBase] });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      json(200, {
        issuer: urlBase,
        authorization_endpoint: `${urlBase}/auth/authorize`,
        token_endpoint: `${urlBase}/auth/token`,
        registration_endpoint: `${urlBase}/auth/register`,
      });
      return;
    }
    if (url.pathname === "/auth/register" && req.method === "POST") {
      json(201, { client_id: "wsid1.stub-client.sig" });
      return;
    }
    if (url.pathname === "/auth/authorize") {
      // The stub "GitHub dance" collapses to an immediate code redirect.
      const target = new URL(url.searchParams.get("redirect_uri") ?? "");
      target.searchParams.set("code", "stub-code");
      const state = url.searchParams.get("state");
      if (state !== null) target.searchParams.set("state", state);
      res.writeHead(302, { location: target.toString() });
      res.end();
      return;
    }
    if (url.pathname === "/auth/token" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += String(c)));
      req.on("end", () => {
        const form = new URLSearchParams(raw);
        const now = Math.floor(Date.now() / 1000);
        if (form.get("grant_type") === "authorization_code") {
          if (form.get("code") !== "stub-code" || form.get("code_verifier") === null) {
            json(400, { error: "invalid_grant", error_description: "bad code or missing verifier" });
            return;
          }
          grants.code++;
          json(200, {
            access_token: fakeToken("wsv1", { sub: "alice", exp: now + 3600 }),
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: fakeToken("wsr1", { sub: "alice", exp: now + 86_400 }),
          });
          return;
        }
        if (form.get("grant_type") === "refresh_token") {
          grants.refresh++;
          json(200, {
            access_token: fakeToken("wsv1", { sub: "alice", exp: now + 3600, n: grants.refresh }),
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: fakeToken("wsr1", { sub: "alice", exp: now + 86_400, n: grants.refresh }),
          });
          return;
        }
        json(400, { error: "unsupported_grant_type", error_description: "stub" });
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  urlBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: urlBase,
    grants,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe("wiki/auth-client", () => {
  let as: StubAS;
  let dir: string;

  beforeAll(async () => {
    as = await startStubAS();
    dir = mkdtempSync(join(tmpdir(), "wiki-auth-client-"));
  });

  afterAll(async () => {
    await as.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("discovers the authorization server via the protected-resource document", async () => {
    const meta = await discoverAuthServer(as.url);
    expect(meta).toEqual({
      issuer: as.url,
      authorizationEndpoint: `${as.url}/auth/authorize`,
      tokenEndpoint: `${as.url}/auth/token`,
      registrationEndpoint: `${as.url}/auth/register`,
    });
  });

  it("CredentialsStore round-trips with mode 0600 and survives a corrupt file", () => {
    const path = join(dir, "credentials.json");
    const store = new CredentialsStore(path);
    const credentials: ServerCredentials = {
      clientId: "wsid1.c.s",
      accessToken: "wsv1.a.s",
      accessTokenExp: 1000,
      refreshToken: "wsr1.r.s",
      refreshTokenExp: 2000,
      tokenEndpoint: `${as.url}/auth/token`,
      user: "alice",
    };
    store.set(as.url, credentials);
    expect(store.get(as.url)).toEqual(credentials);
    expect(store.get(`${as.url}/some/deeper/path`)).toEqual(credentials); // keyed by ORIGIN
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain("wsv1.a.s");

    // A second server coexists; deleting one leaves the other.
    store.set("http://other.example", { ...credentials, user: "bob" });
    expect(store.delete(as.url)).toBe(true);
    expect(store.get(as.url)).toBeUndefined();
    expect(store.get("http://other.example")?.user).toBe("bob");

    // Corrupt file → empty store, not a crash.
    const corrupt = new CredentialsStore(join(dir, "nope", "..", "corrupt.json"));
    expect(corrupt.get(as.url)).toBeUndefined();
  });

  it("loginLoopback runs the full dance (the test plays the browser) and persists the grant", async () => {
    const store = new CredentialsStore(join(dir, "login.json"));
    const credentials = await loginLoopback({
      serverUrl: as.url,
      store,
      onAuthorizeUrl: (authorizeUrl) => {
        // The "browser": follow the authorize redirect back to the loopback listener.
        void (async (): Promise<void> => {
          const url = new URL(authorizeUrl);
          expect(url.searchParams.get("code_challenge_method")).toBe("S256");
          expect(url.searchParams.get("code_challenge")?.length).toBeGreaterThan(20);
          const redirect = await fetch(authorizeUrl, { redirect: "manual" });
          await fetch(redirect.headers.get("location") ?? "");
        })();
      },
      timeoutMs: 10_000,
    });
    expect(credentials.user).toBe("alice");
    expect(credentials.accessToken.startsWith("wsv1.")).toBe(true);
    expect(credentials.refreshToken.startsWith("wsr1.")).toBe(true);
    expect(store.get(as.url)).toEqual(credentials);
    expect(as.grants.code).toBe(1);
  });

  it("loginLoopback rejects a redirect with a mismatched state", async () => {
    await expect(
      loginLoopback({
        serverUrl: as.url,
        store: new CredentialsStore(join(dir, "evil.json")),
        onAuthorizeUrl: (authorizeUrl) => {
          void (async (): Promise<void> => {
            const url = new URL(authorizeUrl);
            const target = new URL(url.searchParams.get("redirect_uri") ?? "");
            target.searchParams.set("code", "stub-code");
            target.searchParams.set("state", "not-the-state");
            await fetch(target.toString());
          })();
        },
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(/state mismatch/);
  });

  it("oauthHeaders serves the cached token while fresh and refreshes (once, shared) when stale", async () => {
    const store = new CredentialsStore(join(dir, "headers.json"));
    let clock = 1_000_000;
    store.set(as.url, {
      clientId: "wsid1.c.s",
      accessToken: "wsv1.cached.s",
      accessTokenExp: clock + 3600,
      refreshToken: "wsr1.original.s",
      refreshTokenExp: clock + 86_400,
      tokenEndpoint: `${as.url}/auth/token`,
      user: "alice",
    });
    const headers = oauthHeaders(as.url, { store, nowSeconds: () => clock });

    // Fresh: the cached token, no network.
    const before = as.grants.refresh;
    expect(await headers.authorization()).toBe("Bearer wsv1.cached.s");
    expect(as.grants.refresh).toBe(before);

    // Stale (within the 60s skew): one refresh shared by concurrent callers.
    clock += 3600 - 30;
    const [a, b] = await Promise.all([headers.authorization(), headers.authorization()]);
    expect(as.grants.refresh).toBe(before + 1);
    expect(a).toBe(b);
    expect(a.startsWith("Bearer wsv1.")).toBe(true);
    expect(a).not.toBe("Bearer wsv1.cached.s");

    // The rotation was persisted: the stored refresh token moved on.
    expect(store.get(as.url)?.refreshToken).not.toBe("wsr1.original.s");
  });

  it("oauthHeaders throws a run-login error when no credentials exist", async () => {
    const headers = oauthHeaders(as.url, { store: new CredentialsStore(join(dir, "empty.json")) });
    await expect(headers.authorization()).rejects.toThrow(/sign in first/);
  });

  it("oauthHeaders fails fast (no network) when the refresh grant itself has expired", async () => {
    const store = new CredentialsStore(join(dir, "expired.json"));
    let clock = 2_000_000;
    store.set(as.url, {
      clientId: "wsid1.c.s",
      accessToken: "wsv1.stale.s",
      accessTokenExp: clock - 10, // access already stale → would need a refresh
      refreshToken: "wsr1.dead.s",
      refreshTokenExp: clock - 5, // …but the grant is gone too
      tokenEndpoint: `${as.url}/auth/token`,
      user: "alice",
    });
    const before = as.grants.refresh;
    const headers = oauthHeaders(as.url, { store, nowSeconds: () => clock });
    await expect(headers.authorization()).rejects.toThrow(/sign in again/);
    expect(as.grants.refresh).toBe(before); // no doomed round-trip
  });

  it("resolveAuthorization honors the shared precedence: static token, stored grant, open", () => {
    const store = new CredentialsStore(join(dir, "precedence.json"));
    // Static token wins even with a stored grant present.
    store.set(as.url, {
      clientId: "wsid1.c.s",
      accessToken: "wsv1.a.s",
      accessTokenExp: Math.floor(Date.now() / 1000) + 3600,
      refreshToken: "wsr1.r.s",
      refreshTokenExp: 0,
      tokenEndpoint: `${as.url}/auth/token`,
      user: "alice",
    });
    expect(resolveAuthorization(as.url, "static-token", { store })).toBe("Bearer static-token");
    // Stored grant → a refreshing function.
    expect(typeof resolveAuthorization(as.url, undefined, { store })).toBe("function");
    // Neither → undefined (no header at all).
    expect(resolveAuthorization(as.url, undefined, { store: new CredentialsStore(join(dir, "none.json")) })).toBeUndefined();
    expect(resolveAuthorization(as.url, "", { store: new CredentialsStore(join(dir, "none.json")) })).toBeUndefined();
  });
});
