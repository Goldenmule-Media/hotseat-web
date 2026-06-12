/**
 * Stateless session tokens. After GitHub OAuth the gateway mints
 * `wsv1.<base64url(payload)>.<base64url(hmac-sha256(secret, payload))>`; every
 * surface (gateway proxy, control listener, embedded MCP) verifies the same
 * way, so there is no session store and nothing to replicate. Revocation is by
 * expiry only (default 30 days) — rotating `sessionSecret` invalidates all.
 *
 * The same shape (different prefix) signs the short-lived OAuth `state`. The
 * signature alone only proves WE minted the state (redirect-target integrity);
 * login-CSRF protection comes from the gateway ALSO setting the state's nonce
 * in a short-lived cookie and requiring the two to match at the callback — that
 * binds the round-trip to the browser that started it, still without server state.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** The signed identity inside a session token. */
export interface SessionUser {
  /** GitHub login, lowercase — the stable principal every ACL key uses. */
  readonly login: string;
  /** Display name (GitHub `name`), when set. */
  readonly name?: string;
  /** Avatar image URL, when set. */
  readonly avatarUrl?: string;
}

/** A decoded, signature-checked, unexpired session. */
export interface Session extends SessionUser {
  /** Expiry, unix seconds. */
  readonly exp: number;
}

const SESSION_PREFIX = "wsv1";
const STATE_PREFIX = "wst1";

const b64url = (s: string): string => Buffer.from(s, "utf8").toString("base64url");
const fromB64url = (s: string): string => Buffer.from(s, "base64url").toString("utf8");

function hmac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Constant-time string comparison (signature checks). */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function sign(prefix: string, secret: string, payload: Record<string, unknown>): string {
  const body = b64url(JSON.stringify(payload));
  return `${prefix}.${body}.${hmac(secret, body)}`;
}

/**
 * Verify a `prefix.payload.sig` token: shape, signature (constant-time), and
 * expiry against `nowSeconds`. Returns the parsed payload or `undefined` —
 * never throws on malformed input (this runs on every proxied request).
 */
function verify(prefix: string, secret: string, token: string, nowSeconds: number): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== prefix) return undefined;
  if (!safeEqual(hmac(secret, parts[1]), parts[2])) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(fromB64url(parts[1]));
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null) return undefined;
  const exp = (payload as { exp?: unknown }).exp;
  if (typeof exp !== "number" || exp <= nowSeconds) return undefined;
  return payload as Record<string, unknown>;
}

/** Mint a session token for `user`, expiring `ttlSeconds` from `nowSeconds`. */
export function signSession(secret: string, user: SessionUser, ttlSeconds: number, nowSeconds: number): string {
  return sign(SESSION_PREFIX, secret, {
    sub: user.login,
    ...(user.name !== undefined ? { name: user.name } : {}),
    ...(user.avatarUrl !== undefined ? { avatarUrl: user.avatarUrl } : {}),
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
  });
}

/** Verify a session token → the session, or `undefined` (bad shape/signature/expired). */
export function verifySession(secret: string, token: string, nowSeconds: number): Session | undefined {
  const payload = verify(SESSION_PREFIX, secret, token, nowSeconds);
  if (payload === undefined || typeof payload.sub !== "string" || payload.sub.length === 0) return undefined;
  return {
    login: payload.sub,
    ...(typeof payload.name === "string" ? { name: payload.name } : {}),
    ...(typeof payload.avatarUrl === "string" ? { avatarUrl: payload.avatarUrl } : {}),
    exp: payload.exp as number,
  };
}

/** Extract + verify the `Authorization: Bearer …` session on a request, if any. */
export function bearerSession(
  secret: string,
  authorization: string | string[] | undefined,
  nowSeconds: number,
): Session | undefined {
  const raw = Array.isArray(authorization) ? authorization[0] : authorization;
  if (raw === undefined || !raw.toLowerCase().startsWith("bearer ")) return undefined;
  return verifySession(secret, raw.slice("bearer ".length).trim(), nowSeconds);
}

/** Mint a short-lived OAuth `state` carrying the post-login redirect target. */
export function signState(secret: string, redirect: string | undefined, nonce: string, nowSeconds: number, ttlSeconds = 600): string {
  return sign(STATE_PREFIX, secret, {
    ...(redirect !== undefined ? { redirect } : {}),
    nonce,
    exp: nowSeconds + ttlSeconds,
  });
}

/** Verify an OAuth `state` → its redirect target + the browser-binding nonce. */
export function verifyState(
  secret: string,
  state: string,
  nowSeconds: number,
): { readonly redirect?: string; readonly nonce: string } | undefined {
  const payload = verify(STATE_PREFIX, secret, state, nowSeconds);
  if (payload === undefined || typeof payload.nonce !== "string" || payload.nonce.length === 0) return undefined;
  return {
    nonce: payload.nonce,
    ...(typeof payload.redirect === "string" ? { redirect: payload.redirect } : {}),
  };
}
