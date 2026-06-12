/**
 * Session/state token unit tests: sign → verify roundtrips, expiry, and that
 * every malformed/tampered shape verifies to `undefined` (never throws — this
 * code runs on every proxied request).
 */
import { describe, expect, it } from "vitest";

import { bearerSession, signSession, signState, verifySession, verifyState } from "../src/auth/tokens";

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
