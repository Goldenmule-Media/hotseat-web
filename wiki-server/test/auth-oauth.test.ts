/**
 * The OAuth 2.1 façade end-to-end against a REAL gateway (GitHub stubbed via
 * `fetchImpl`, clock injected): discovery documents, stateless registration,
 * the authorize → GitHub → code → token dance with PKCE S256, the refresh
 * grant (rotation capped at the original expiry, allowlist re-checked), and
 * RFC 9728 discovery on the data plane's 401.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DurableStreamTestServer } from "@durable-streams/server";

import { AccessStore } from "../src/auth/access";
import { startGateway, type Gateway } from "../src/auth/gateway";
import { signRefreshToken, verifySession } from "../src/auth/tokens";
import { createLogger } from "../src/logger";

const SECRET = "oauth-test-secret-oauth-test-secret";
const NOW = 1_750_000_000;

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

const s256 = (verifier: string): string => createHash("sha256").update(verifier, "utf8").digest("base64url");

/** Decode a signed blob's payload (tests may inspect; the server still verifies). */
const payloadOf = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as Record<string, unknown>;

describe("OAuth 2.1 façade", () => {
  let internal: DurableStreamTestServer;
  let internalUrl: string;
  let gateway: Gateway;
  let store: AccessStore;
  let dir: string;
  /** Injected clock — advanced by expiry tests. */
  let clock = NOW;

  const ACCESS_TTL = 3600;
  const REFRESH_TTL = 86_400;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "wiki-oauth-"));
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
      sessionTtlSeconds: 30 * 86_400,
      accessTokenTtlSeconds: ACCESS_TTL,
      refreshTokenTtlSeconds: REFRESH_TTL,
      store,
      logger: createLogger({ bufferSize: 100, format: "json" }),
      nowSeconds: () => clock,
    });
  });

  afterAll(async () => {
    await gateway?.stop();
    await internal?.stop();
    await store?.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Register a loopback client → its client_id. */
  async function register(redirectUris: string[] = ["http://127.0.0.1:7777/callback"]): Promise<string> {
    const res = await fetch(`${gateway.url}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: redirectUris, client_name: "test-cli" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string; token_endpoint_auth_method: string };
    expect(body.client_id.startsWith("wsid1.")).toBe(true);
    expect(body.token_endpoint_auth_method).toBe("none");
    return body.client_id;
  }

  /** Run authorize → GitHub-stub callback → the redirected code. */
  async function obtainCode(clientId: string, redirectUri: string, challenge: string, clientState = "xyz"): Promise<string> {
    const authorize = await fetch(
      `${gateway.url}/auth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256&state=${clientState}`,
      { redirect: "manual" },
    );
    expect(authorize.status).toBe(302);
    const ghUrl = new URL(authorize.headers.get("location") ?? "");
    expect(ghUrl.origin + ghUrl.pathname).toBe("https://github.com/login/oauth/authorize");
    const state = ghUrl.searchParams.get("state") ?? "";
    const cookie = (authorize.headers.get("set-cookie") ?? "").split(";")[0];
    expect(cookie).toMatch(/^wiki_oauth_nonce=.+/);

    const callback = await fetch(`${gateway.url}/auth/github/callback?code=gh-abc&state=${encodeURIComponent(state)}`, {
      redirect: "manual",
      headers: { cookie },
    });
    expect(callback.status).toBe(302);
    const back = new URL(callback.headers.get("location") ?? "");
    expect(back.origin + back.pathname).toBe(new URL(redirectUri).origin + new URL(redirectUri).pathname);
    expect(back.searchParams.get("state")).toBe(clientState);
    const code = back.searchParams.get("code") ?? "";
    expect(code.startsWith("wsc1.")).toBe(true);
    return code;
  }

  /** POST /auth/token (form-encoded) → parsed body + status. */
  async function tokenRequest(form: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${gateway.url}/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("serves both discovery documents publicly (no auth, CORS on) while the data plane still 401s", async () => {
    const as = await fetch(`${gateway.url}/.well-known/oauth-authorization-server`);
    expect(as.status).toBe(200);
    expect(as.headers.get("access-control-allow-origin")).toBe("*");
    expect(await as.json()).toMatchObject({
      issuer: "http://127.0.0.1:4437",
      authorization_endpoint: "http://127.0.0.1:4437/auth/authorize",
      token_endpoint: "http://127.0.0.1:4437/auth/token",
      registration_endpoint: "http://127.0.0.1:4437/auth/register",
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
    });

    const pr = await fetch(`${gateway.url}/.well-known/oauth-protected-resource`);
    expect(pr.status).toBe(200);
    expect(await pr.json()).toMatchObject({
      resource: "http://127.0.0.1:4437",
      authorization_servers: ["http://127.0.0.1:4437"],
    });

    expect((await fetch(`${gateway.url}/test/workspace/x`)).status).toBe(401);
  });

  it("advertises resource_metadata on the data plane's 401 (RFC 9728 discovery)", async () => {
    const res = await fetch(`${gateway.url}/test/workspace/x`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer realm="wiki-server", resource_metadata="http://127.0.0.1:4437/.well-known/oauth-protected-resource"',
    );
  });

  it("registers loopback and https redirect URIs, refusing non-loopback http", async () => {
    await register(["http://127.0.0.1:7777/callback"]);
    await register(["http://[::1]:7777/callback", "https://app.example.com/cb"]);
    const res = await fetch(`${gateway.url}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.com/cb"] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_redirect_uri");
  });

  it("rejects malformed authorize requests without redirecting", async () => {
    const clientId = await register();
    const ru = encodeURIComponent("http://127.0.0.1:7777/callback");
    const base = `${gateway.url}/auth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${ru}`;

    // Missing code_challenge / wrong method.
    expect((await fetch(`${base}`, { redirect: "manual" })).status).toBe(400);
    expect((await fetch(`${base}&code_challenge=x&code_challenge_method=plain`, { redirect: "manual" })).status).toBe(400);
    // redirect_uri not registered for this client.
    const other = `${gateway.url}/auth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent("http://127.0.0.1:9999/other")}&code_challenge=x&code_challenge_method=S256`;
    expect((await fetch(other, { redirect: "manual" })).status).toBe(400);
    // Tampered client_id.
    const forged = `${gateway.url}/auth/authorize?response_type=code&client_id=wsid1.YWJj.ZGVm&redirect_uri=${ru}` +
      `&code_challenge=x&code_challenge_method=S256`;
    const forgedRes = await fetch(forged, { redirect: "manual" });
    expect(forgedRes.status).toBe(400);
    expect(((await forgedRes.json()) as { error: string }).error).toBe("invalid_client");
  });

  it("runs the full dance: authorize → code → token, and the minted access token opens the data plane", async () => {
    const redirectUri = "http://127.0.0.1:7777/callback";
    const clientId = await register([redirectUri]);
    const verifier = randomBytes(32).toString("base64url");
    const code = await obtainCode(clientId, redirectUri, s256(verifier));

    const { status, body } = await tokenRequest({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: redirectUri,
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: ACCESS_TTL });
    const accessToken = body.access_token as string;
    const refreshToken = body.refresh_token as string;
    expect(accessToken.startsWith("wsv1.")).toBe(true);
    expect(refreshToken.startsWith("wsr1.")).toBe(true);

    // The access token is a REGULAR wsv1 session: /auth/me and the proxy accept it.
    expect(verifySession(SECRET, accessToken, clock)).toMatchObject({ login: "alice", exp: clock + ACCESS_TTL });
    const me = await fetch(`${gateway.url}/auth/me`, { headers: { authorization: `Bearer ${accessToken}` } });
    expect(me.status).toBe(200);
    const dataPlane = await fetch(`${gateway.url}/test/workspace/oauth-ws`, { headers: { authorization: `Bearer ${accessToken}` } });
    expect(dataPlane.status).not.toBe(401);
    expect(dataPlane.status).not.toBe(403);
  });

  it("refuses a wrong verifier, a foreign client, a mismatched redirect_uri, and an expired code", async () => {
    const redirectUri = "http://127.0.0.1:7777/callback";
    const clientId = await register([redirectUri]);
    const verifier = randomBytes(32).toString("base64url");
    const code = await obtainCode(clientId, redirectUri, s256(verifier));

    const wrongVerifier = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: "not-the-verifier", client_id: clientId });
    expect(wrongVerifier.status).toBe(400);
    expect(wrongVerifier.body.error).toBe("invalid_grant");

    // A genuinely different client: stateless wsid1 ids are deterministic over
    // (uris, name, iat), so an identical registration under the frozen test
    // clock would mint the SAME id — vary the redirect list.
    const otherClient = await register(["http://127.0.0.1:8888/foreign"]);
    const foreign = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: otherClient });
    expect(foreign.body.error).toBe("invalid_grant");

    const wrongRedirect = await tokenRequest({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: "http://127.0.0.1:7777/elsewhere",
    });
    expect(wrongRedirect.body.error).toBe("invalid_grant");

    clock += 121; // past the 120s code TTL
    try {
      const expired = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: redirectUri });
      expect(expired.status).toBe(400);
      expect(expired.body.error).toBe("invalid_grant");
    } finally {
      clock = NOW;
    }
  });

  it("honors the refresh grant, rotating the refresh token with expiry capped at the original", async () => {
    const redirectUri = "http://127.0.0.1:7777/callback";
    const clientId = await register([redirectUri]);
    const verifier = randomBytes(32).toString("base64url");
    const code = await obtainCode(clientId, redirectUri, s256(verifier));
    const grant = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId });
    const originalRefresh = grant.body.refresh_token as string;
    const originalExp = payloadOf(originalRefresh).exp as number;
    expect(originalExp).toBe(clock + REFRESH_TTL);

    clock += 50_000; // deep into the grant, so an uncapped rotation WOULD extend it
    try {
      const refreshed = await tokenRequest({ grant_type: "refresh_token", refresh_token: originalRefresh, client_id: clientId });
      expect(refreshed.status).toBe(200);
      const newAccess = refreshed.body.access_token as string;
      const newRefresh = refreshed.body.refresh_token as string;
      expect(verifySession(SECRET, newAccess, clock)?.login).toBe("alice");
      // Rotation cap: the chain never outlives the original grant.
      expect(payloadOf(newRefresh).exp).toBe(originalExp);

      // A tampered/expired refresh token is refused.
      const tampered = await tokenRequest({ grant_type: "refresh_token", refresh_token: `${originalRefresh}x` });
      expect(tampered.body.error).toBe("invalid_grant");
      clock = originalExp + 1;
      const expired = await tokenRequest({ grant_type: "refresh_token", refresh_token: newRefresh });
      expect(expired.body.error).toBe("invalid_grant");
    } finally {
      clock = NOW;
    }
  });

  it("re-checks the allowlist at refresh, so a removed user is cut off", async () => {
    // A second gateway whose allowlist excludes alice; a refresh token signed
    // with the same secret (as if minted before the allowlist changed) is refused.
    const restricted = await startGateway({
      host: "127.0.0.1",
      port: 0,
      internalBaseUrl: internalUrl,
      publicUrl: "http://127.0.0.1:4437",
      uiOrigins: [],
      github: { clientId: "cid", clientSecret: "csecret", callbackUrl: "http://127.0.0.1:4437/auth/github/callback", fetchImpl: githubStub },
      allowedUsers: ["someone-else"],
      sessionSecret: SECRET,
      sessionTtlSeconds: 3600,
      accessTokenTtlSeconds: ACCESS_TTL,
      refreshTokenTtlSeconds: REFRESH_TTL,
      store,
      logger: createLogger({ bufferSize: 100, format: "json" }),
      nowSeconds: () => clock,
    });
    try {
      const staleRefresh = signRefreshToken(SECRET, { login: "alice" }, "wsid1.client", clock, REFRESH_TTL);
      const res = await fetch(`${restricted.url}/auth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: staleRefresh }).toString(),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
    } finally {
      await restricted.stop();
    }
  });

  it("rejects an unknown grant_type", async () => {
    const { status, body } = await tokenRequest({ grant_type: "password", username: "alice", password: "hunter2" });
    expect(status).toBe(400);
    expect(body.error).toBe("unsupported_grant_type");
  });

  it("keeps the plain (non-OAuth) login flow byte-identical: token still arrives in the URL fragment", async () => {
    const redirect = "http://localhost:3000/auth/complete";
    const authorize = await fetch(`${gateway.url}/auth/github?redirect=${encodeURIComponent(redirect)}`, { redirect: "manual" });
    const state = new URL(authorize.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const cookie = (authorize.headers.get("set-cookie") ?? "").split(";")[0];
    const callback = await fetch(`${gateway.url}/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`, {
      redirect: "manual",
      headers: { cookie },
    });
    expect(callback.status).toBe(302);
    const back = callback.headers.get("location") ?? "";
    expect(back.startsWith(`${redirect}#token=`)).toBe(true);
    const token = decodeURIComponent(back.split("#token=")[1]);
    expect(verifySession(SECRET, token, clock)?.login).toBe("alice");
  });
});
