/**
 * Gateway integration: a REAL `DurableStreamTestServer` on an internal port with
 * the auth gateway in front, driven by the real `@durable-streams/client` (the
 * same client the engine uses). Covers the OAuth dance (GitHub stubbed via the
 * injectable `fetchImpl`), the bearer-gated data plane, PUT-201 ownership
 * capture, the membership/claim API, and that live tails stream through the
 * proxy.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DurableStreamTestServer } from "@durable-streams/server";
import { DurableStream, stream } from "@durable-streams/client";

import { AccessStore } from "../src/auth/access";
import { startGateway, type Gateway } from "../src/auth/gateway";
import { signSession, verifySession } from "../src/auth/tokens";
import { createLogger } from "../src/logger";

const SECRET = "gateway-test-secret-gateway-test";
const JSON_CT = "application/json";

/** Mint a real session token for `login` (1h from real now — the gateway uses Date.now). */
const mint = (login: string): string => signSession(SECRET, { login }, 3600, Math.floor(Date.now() / 1000));
const bearer = (login: string): Record<string, string> => ({ authorization: `Bearer ${mint(login)}` });

/** A fetch stub standing in for GitHub: code exchange + user profile. */
const githubStub: typeof fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://github.com/login/oauth/access_token")) {
    return new Response(JSON.stringify({ access_token: "gh-token" }), { headers: { "content-type": "application/json" } });
  }
  if (url.startsWith("https://api.github.com/user")) {
    return new Response(JSON.stringify({ login: "Alice", name: "Alice A", avatar_url: "https://avatars/alice" }), {
      headers: { "content-type": "application/json" },
    });
  }
  throw new Error(`unexpected fetch in github stub: ${url}`);
};

describe("auth gateway", () => {
  let internal: DurableStreamTestServer;
  let internalUrl: string;
  let gateway: Gateway;
  let store: AccessStore;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "wiki-gw-"));
    internal = new DurableStreamTestServer({ port: 0 });
    internalUrl = await internal.start();
    store = new AccessStore(dir);
    gateway = await startGateway({
      host: "127.0.0.1",
      port: 0,
      internalBaseUrl: internalUrl,
      publicUrl: "http://127.0.0.1:4437",
      uiOrigins: ["http://localhost:3000"],
      github: { clientId: "cid", clientSecret: "csecret", callbackUrl: "http://127.0.0.1:4437/auth/github/callback", fetchImpl: githubStub },
      sessionSecret: SECRET,
      sessionTtlSeconds: 3600,
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 86_400,
      store,
      logger: createLogger({ bufferSize: 100, format: "json" }),
    });
  });

  afterAll(async () => {
    await gateway?.stop();
    await internal?.stop();
    await store?.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  const ws = (id: string): string => `${gateway.url}/test/workspace/${id}`;

  it("answers /auth/config publicly", async () => {
    const res = await fetch(`${gateway.url}/auth/config`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, provider: "github" });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("runs the OAuth dance: authorize redirect (+nonce cookie) → callback → token in the fragment", async () => {
    const redirect = "http://localhost:3000/auth/complete";
    const authorize = await fetch(`${gateway.url}/auth/github?redirect=${encodeURIComponent(redirect)}`, { redirect: "manual" });
    expect(authorize.status).toBe(302);
    const location = new URL(authorize.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("cid");
    const state = location.searchParams.get("state") ?? "";
    const cookie = (authorize.headers.get("set-cookie") ?? "").split(";")[0];
    expect(cookie).toMatch(/^wiki_oauth_nonce=.+/);

    const callback = await fetch(`${gateway.url}/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`, {
      redirect: "manual",
      headers: { cookie },
    });
    expect(callback.status).toBe(302);
    const back = callback.headers.get("location") ?? "";
    expect(back.startsWith(`${redirect}#token=`)).toBe(true);
    const token = decodeURIComponent(back.split("#token=")[1]);
    const session = verifySession(SECRET, token, Math.floor(Date.now() / 1000));
    expect(session).toMatchObject({ login: "alice", name: "Alice A", avatarUrl: "https://avatars/alice" });
  });

  it("refuses a redirect outside the allowed origins, a forged state, and a callback whose browser did not start the dance", async () => {
    const evil = await fetch(`${gateway.url}/auth/github?redirect=${encodeURIComponent("https://evil.example/steal")}`, {
      redirect: "manual",
    });
    expect(evil.status).toBe(400);

    const forged = await fetch(`${gateway.url}/auth/github/callback?code=abc&state=forged`, { redirect: "manual" });
    expect(forged.status).toBe(400);

    // Login-CSRF: a VALID server-minted state without the matching nonce cookie
    // (the victim's browser never started this dance) must be refused.
    const authorize = await fetch(`${gateway.url}/auth/github`, { redirect: "manual" });
    const state = new URL(authorize.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const noCookie = await fetch(`${gateway.url}/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`, {
      redirect: "manual",
    });
    expect(noCookie.status).toBe(400);
  });

  it("401s the data plane without a valid bearer; OPTIONS preflights pass through", async () => {
    expect((await fetch(ws("nope"))).status).toBe(401);
    expect((await fetch(ws("nope"), { headers: { authorization: "Bearer junk" } })).status).toBe(401);
    const preflight = await fetch(ws("nope"), { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers") ?? "").toContain("authorization");
  });

  it("proxies authenticated stream traffic and records the creator as owner on PUT-201", async () => {
    const handle = await DurableStream.create({ url: ws("ws-alpha"), contentType: JSON_CT, headers: bearer("alice") });
    expect(store.record("ws-alpha")?.owner).toBe("alice");

    // Appends + reads flow through with protocol semantics intact.
    await handle.append(JSON.stringify([{ n: 1 }]));
    const res = await stream<Array<{ n: number }>>({ url: ws("ws-alpha"), offset: "-1", live: false, headers: bearer("alice") });
    expect((await res.json()).flat()).toEqual([{ n: 1 }]);

    // A non-member's cold-open PUT never reaches the upstream — the membership
    // gate 403s it first; ownership stays put.
    const coldOpen = await fetch(ws("ws-alpha"), { method: "PUT", headers: { ...bearer("bob-cold"), "content-type": JSON_CT } });
    expect(coldOpen.status).toBe(403);
    expect(store.record("ws-alpha")?.owner).toBe("alice");

    // The claim hook fires ONLY on a true creation (201): an idempotent
    // re-create of an UNCLAIMED stream answers 200 and must NOT hand out
    // ownership (regression guard for claim-on-any-2xx).
    await DurableStream.create({ url: `${internalUrl}/test/workspace/ws-gamma`, contentType: JSON_CT });
    const recreate = await fetch(ws("ws-gamma"), { method: "PUT", headers: { ...bearer("bob"), "content-type": JSON_CT } });
    expect(recreate.status).toBe(200);
    expect(store.record("ws-gamma")).toBeUndefined();
  });

  it("denies everything outside workspace/catalog paths, and survives malformed escapes", async () => {
    // Deny-by-default: the wrapped server's fault-injection and subscription
    // planes must be unreachable even WITH a valid session.
    const inject = await fetch(`${gateway.url}/_test/inject-error`, {
      method: "POST",
      headers: { ...bearer("alice"), "content-type": "application/json" },
      body: JSON.stringify({ path: "/test/workspace/ws-alpha", status: 500 }),
    });
    expect(inject.status).toBe(403);
    expect((await fetch(`${gateway.url}/subscriptions/x`, { headers: bearer("alice") })).status).toBe(403);
    expect((await fetch(`${gateway.url}/test`, { headers: bearer("alice") })).status).toBe(403);
    // The shared catalog stays reachable for any signed-in user.
    expect((await fetch(`${gateway.url}/test/_catalog`, { method: "HEAD", headers: bearer("alice") })).status).not.toBe(403);

    // A malformed percent-escape is a 400, not a process-killing URIError…
    expect((await fetch(`${gateway.url}/test/%zz`, { headers: bearer("alice") })).status).toBe(400);
    expect((await fetch(`${gateway.url}/auth/%zz`, { headers: bearer("alice") })).status).toBe(400);
    // …and the gateway is still alive afterwards.
    expect((await fetch(`${gateway.url}/auth/config`)).status).toBe(200);
  });

  it("owner-gates stream deletion on claimed workspaces", async () => {
    await DurableStream.create({ url: ws("ws-delta"), contentType: JSON_CT, headers: bearer("alice") });
    await fetch(`${gateway.url}/auth/workspaces/ws-delta/members`, {
      method: "POST",
      headers: { ...bearer("alice"), "content-type": "application/json" },
      body: JSON.stringify({ login: "bob" }),
    });
    // A member may read/write but NOT erase the stream; the owner may.
    expect((await fetch(ws("ws-delta"), { method: "DELETE", headers: bearer("bob") })).status).toBe(403);
    expect((await fetch(ws("ws-delta"), { method: "DELETE", headers: bearer("alice") })).status).not.toBe(403);
  });

  it("enforces membership on workspace streams and the members API manages it", async () => {
    await DurableStream.create({ url: ws("ws-beta"), contentType: JSON_CT, headers: bearer("alice") });

    // Non-member: every data-plane verb on the workspace stream is 403.
    const denied = await fetch(ws("ws-beta"), { headers: bearer("bob") });
    expect(denied.status).toBe(403);

    // Non-owner may not manage members; the owner may.
    const bobAdds = await fetch(`${gateway.url}/auth/workspaces/ws-beta/members`, {
      method: "POST",
      headers: { ...bearer("bob"), "content-type": "application/json" },
      body: JSON.stringify({ login: "bob" }),
    });
    expect(bobAdds.status).toBe(403);

    const aliceAdds = await fetch(`${gateway.url}/auth/workspaces/ws-beta/members`, {
      method: "POST",
      headers: { ...bearer("alice"), "content-type": "application/json" },
      body: JSON.stringify({ login: "Bob" }),
    });
    expect(aliceAdds.status).toBe(200);
    expect(await aliceAdds.json()).toEqual({ owner: "alice", members: ["bob"] });

    // Bob is in: reads pass, and he can list the roster.
    expect((await fetch(ws("ws-beta"), { headers: bearer("bob") })).status).toBe(200);
    const roster = await fetch(`${gateway.url}/auth/workspaces/ws-beta/members`, { headers: bearer("bob") });
    expect(roster.status).toBe(200);

    // Removal closes the door again.
    const removed = await fetch(`${gateway.url}/auth/workspaces/ws-beta/members/bob`, {
      method: "DELETE",
      headers: bearer("alice"),
    });
    expect(removed.status).toBe(200);
    expect((await fetch(ws("ws-beta"), { headers: bearer("bob") })).status).toBe(403);
  });

  it("leaves pre-auth (unclaimed) workspaces open and lets any user claim them once", async () => {
    // Created directly on the INTERNAL host — as if it predates auth. No record.
    await DurableStream.create({ url: `${internalUrl}/test/workspace/ws-legacy`, contentType: JSON_CT });
    expect(store.record("ws-legacy")).toBeUndefined();

    // Open to any signed-in user…
    expect((await fetch(ws("ws-legacy"), { headers: bearer("bob") })).status).toBe(200);

    // …until someone claims it.
    const claim = await fetch(`${gateway.url}/auth/workspaces/ws-legacy/claim`, { method: "POST", headers: bearer("bob") });
    expect(claim.status).toBe(200);
    expect(await claim.json()).toEqual({ owner: "bob", members: [] });

    const reclaim = await fetch(`${gateway.url}/auth/workspaces/ws-legacy/claim`, { method: "POST", headers: bearer("alice") });
    expect(reclaim.status).toBe(409);
    expect((await fetch(ws("ws-legacy"), { headers: bearer("alice") })).status).toBe(403);
  });

  it("reports identity and memberships on /auth/me", async () => {
    const res = await fetch(`${gateway.url}/auth/me`, { headers: bearer("bob") });
    expect(res.status).toBe(200);
    const me = (await res.json()) as { user: { login: string }; workspaces: { owned: string[]; member: string[]; restricted: string[] } };
    expect(me.user.login).toBe("bob");
    expect(me.workspaces.owned).toContain("ws-legacy");
    expect(me.workspaces.restricted).toContain("ws-alpha");
  });

  it("refuses sign-in for users outside the allowed-users list", async () => {
    // A second gateway with an allowlist that does NOT include the stub's "alice".
    const restricted = await startGateway({
      host: "127.0.0.1",
      port: 0,
      internalBaseUrl: internalUrl,
      publicUrl: "http://127.0.0.1:4437",
      uiOrigins: ["http://localhost:3000"],
      github: { clientId: "cid", clientSecret: "csecret", callbackUrl: "http://127.0.0.1:4437/auth/github/callback", fetchImpl: githubStub },
      allowedUsers: ["someone-else"],
      sessionSecret: SECRET,
      sessionTtlSeconds: 3600,
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 86_400,
      store,
      logger: createLogger({ bufferSize: 100, format: "json" }),
    });
    try {
      const authorize = await fetch(`${restricted.url}/auth/github`, { redirect: "manual" });
      const state = new URL(authorize.headers.get("location") ?? "").searchParams.get("state") ?? "";
      const cookie = (authorize.headers.get("set-cookie") ?? "").split(";")[0];
      const callback = await fetch(`${restricted.url}/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`, {
        redirect: "manual",
        headers: { cookie },
      });
      expect(callback.status).toBe(403);
      expect(await callback.text()).toContain("not on this server's allowed-users list");
    } finally {
      await restricted.stop();
    }
  });

  it("streams a live tail through the proxy (append fans out to a subscriber)", async () => {
    await DurableStream.create({ url: ws("ws-live"), contentType: JSON_CT, headers: bearer("alice") });

    const res = await stream<Array<{ tick: number }>>({ url: ws("ws-live"), offset: "-1", live: true, headers: bearer("alice") });
    const first = new Promise<Array<{ tick: number }>>((resolve) => {
      const unsub = res.subscribeJson((batch) => {
        const flat = (batch.items as Array<Array<{ tick: number }>>).flat();
        if (flat.length > 0) {
          unsub();
          resolve(flat);
        }
      });
    });

    const writer = await DurableStream.create({ url: ws("ws-live"), contentType: JSON_CT, headers: bearer("alice") });
    await writer.append(JSON.stringify([{ tick: 42 }]));

    await expect(first).resolves.toEqual([{ tick: 42 }]);
    res.cancel?.();
  });
});
