/**
 * Session/state token unit tests: sign → verify roundtrips, expiry, and that
 * every malformed/tampered shape verifies to `undefined` (never throws — this
 * code runs on every proxied request).
 */
import { describe, expect, it } from "vitest";

import {
  bearerSession,
  pkceS256Challenge,
  signAuthCode,
  signClientId,
  signRefreshToken,
  signSession,
  signState,
  verifyAuthCode,
  verifyClientId,
  verifyPkceS256,
  verifyRefreshToken,
  verifySession,
  verifyState,
} from "../src/auth/tokens";

const SECRET = "test-secret-test-secret-test-secret";
const NOW = 1_750_000_000;

describe("session tokens", () => {
  it("roundtrips the signed identity and expiry", () => {
    const token = signSession(SECRET, { login: "alice", name: "Alice A", avatarUrl: "https://a/img" }, 3600, NOW);
    const session = verifySession(SECRET, token, NOW + 10);
    expect(session).toMatchObject({ login: "alice", name: "Alice A", avatarUrl: "https://a/img", exp: NOW + 3600 });
  });

  it("omits optional fields it was not given", () => {
    const token = signSession(SECRET, { login: "bob" }, 3600, NOW);
    const session = verifySession(SECRET, token, NOW);
    expect(session?.login).toBe("bob");
    expect(session?.name).toBeUndefined();
    expect(session?.avatarUrl).toBeUndefined();
  });

  it("rejects an expired token", () => {
    const token = signSession(SECRET, { login: "alice" }, 3600, NOW);
    expect(verifySession(SECRET, token, NOW + 3600)).toBeUndefined();
    expect(verifySession(SECRET, token, NOW + 3599)).toBeDefined();
  });

  it("rejects tampering: payload edits, wrong secret, wrong prefix, garbage", () => {
    const token = signSession(SECRET, { login: "alice" }, 3600, NOW);
    const [prefix, payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "mallory", exp: NOW + 9999 })).toString("base64url");
    expect(verifySession(SECRET, `${prefix}.${forged}.${sig}`, NOW)).toBeUndefined();
    expect(verifySession("other-secret-other-secret-other", token, NOW)).toBeUndefined();
    expect(verifySession(SECRET, `wst1.${payload}.${sig}`, NOW)).toBeUndefined();
    expect(verifySession(SECRET, "not-a-token", NOW)).toBeUndefined();
    expect(verifySession(SECRET, "", NOW)).toBeUndefined();
    expect(verifySession(SECRET, "wsv1..", NOW)).toBeUndefined();
  });

  it("bearerSession parses the Authorization header shape", () => {
    const token = signSession(SECRET, { login: "alice" }, 3600, NOW);
    expect(bearerSession(SECRET, `Bearer ${token}`, NOW)?.login).toBe("alice");
    expect(bearerSession(SECRET, `bearer ${token}`, NOW)?.login).toBe("alice");
    expect(bearerSession(SECRET, token, NOW)).toBeUndefined();
    expect(bearerSession(SECRET, undefined, NOW)).toBeUndefined();
    expect(bearerSession(SECRET, "Basic dXNlcjpwYXNz", NOW)).toBeUndefined();
  });
});

describe("oauth state tokens", () => {
  it("roundtrips the redirect target + browser-binding nonce, and expires", () => {
    const state = signState(SECRET, "http://localhost:3000/auth/complete", "nonce-1", NOW);
    expect(verifyState(SECRET, state, NOW + 1)).toEqual({
      redirect: "http://localhost:3000/auth/complete",
      nonce: "nonce-1",
    });
    expect(verifyState(SECRET, state, NOW + 600)).toBeUndefined();
  });

  it("a redirect-less state still carries its nonce (token-page mode)", () => {
    const state = signState(SECRET, undefined, "nonce-2", NOW);
    expect(verifyState(SECRET, state, NOW + 1)).toEqual({ nonce: "nonce-2" });
  });

  it("a session token is not a valid state (and vice versa)", () => {
    const session = signSession(SECRET, { login: "alice" }, 3600, NOW);
    expect(verifyState(SECRET, session, NOW)).toBeUndefined();
  });
});

describe("oauth state with a pending request", () => {
  it("roundtrips the embedded authorize request through the GitHub round-trip", () => {
    const oauth = { cid: "wsid1.abc.def", ru: "http://127.0.0.1:7777/callback", cc: "challenge", cs: "client-state" };
    const state = signState(SECRET, undefined, "nonce-3", NOW, 600, oauth);
    expect(verifyState(SECRET, state, NOW + 1)).toEqual({ nonce: "nonce-3", oauth });
  });

  it("drops a malformed oauth member instead of crashing", () => {
    const state = signState(SECRET, undefined, "nonce-4", NOW, 600, { cid: "x" } as never);
    const parsed = verifyState(SECRET, state, NOW + 1);
    expect(parsed?.nonce).toBe("nonce-4");
    expect(parsed?.oauth).toBeUndefined();
  });
});

describe("authorization codes (wsc1)", () => {
  const REQ = { cid: "wsid1.abc.def", ru: "http://127.0.0.1:7777/callback", cc: "challenge" };

  it("roundtrips identity + client binding and expires at the short TTL", () => {
    const code = signAuthCode(SECRET, { login: "alice", name: "Alice A" }, REQ, NOW);
    expect(code.startsWith("wsc1.")).toBe(true);
    expect(verifyAuthCode(SECRET, code, NOW + 119)).toMatchObject({ login: "alice", name: "Alice A", ...REQ });
    expect(verifyAuthCode(SECRET, code, NOW + 120)).toBeUndefined();
  });

  it("rejects tampering, the wrong secret, and cross-family confusion", () => {
    const code = signAuthCode(SECRET, { login: "alice" }, REQ, NOW);
    expect(verifyAuthCode(SECRET, `${code}x`, NOW)).toBeUndefined();
    expect(verifyAuthCode("other-secret-other-secret-other!", code, NOW)).toBeUndefined();
    // A session token is not a code; a code is not a session.
    expect(verifyAuthCode(SECRET, signSession(SECRET, { login: "alice" }, 3600, NOW), NOW)).toBeUndefined();
    expect(verifySession(SECRET, code, NOW)).toBeUndefined();
  });
});

describe("refresh tokens (wsr1)", () => {
  it("roundtrips and caps a rotated expiry at the original grant", () => {
    const original = signRefreshToken(SECRET, { login: "alice" }, "wsid1.c", NOW, 86_400);
    const parsed = verifyRefreshToken(SECRET, original, NOW + 1);
    expect(parsed).toMatchObject({ login: "alice", cid: "wsid1.c", exp: NOW + 86_400 });

    // Rotation deep into the grant: capped at the ORIGINAL exp, not extended.
    const rotated = signRefreshToken(SECRET, { login: "alice" }, "wsid1.c", NOW + 50_000, 86_400, parsed?.exp);
    expect(verifyRefreshToken(SECRET, rotated, NOW + 50_001)?.exp).toBe(NOW + 86_400);
  });

  it("rejects tampering and expiry", () => {
    const token = signRefreshToken(SECRET, { login: "alice" }, "wsid1.c", NOW, 100);
    expect(verifyRefreshToken(SECRET, token, NOW + 100)).toBeUndefined();
    expect(verifyRefreshToken(SECRET, `${token}x`, NOW)).toBeUndefined();
    expect(verifyRefreshToken("other-secret-other-secret-other!", token, NOW)).toBeUndefined();
  });
});

describe("client ids (wsid1)", () => {
  it("roundtrips the registration record (redirect URIs + name)", () => {
    const id = signClientId(SECRET, ["http://127.0.0.1:7/cb", "https://app/cb"], "my-cli", NOW);
    expect(id.startsWith("wsid1.")).toBe(true);
    expect(verifyClientId(SECRET, id, NOW + 1)).toMatchObject({
      redirectUris: ["http://127.0.0.1:7/cb", "https://app/cb"],
      clientName: "my-cli",
    });
  });

  it("rejects tampering and an empty URI list", () => {
    const id = signClientId(SECRET, ["http://127.0.0.1:7/cb"], undefined, NOW);
    expect(verifyClientId(SECRET, `${id}x`, NOW)).toBeUndefined();
    const forgedPayload = Buffer.from(JSON.stringify({ ru: [], exp: NOW + 999 })).toString("base64url");
    expect(verifyClientId(SECRET, `wsid1.${forgedPayload}.${id.split(".")[2]}`, NOW)).toBeUndefined();
  });
});

describe("PKCE S256", () => {
  it("accepts the matching verifier and refuses any other", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = pkceS256Challenge(verifier);
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
    expect(verifyPkceS256("not-the-verifier", challenge)).toBe(false);
  });
});
