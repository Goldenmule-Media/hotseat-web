/**
 * Stateless signed tokens. Every family follows the same
 * `<prefix>.<base64url(payload)>.<base64url(hmac-sha256(secret, payload))>`
 * shape; nothing is stored server-side, so there is no session store and
 * nothing to replicate. Rotating `sessionSecret` invalidates ALL of them at
 * once — the whole revocation story. The families:
 *
 *  - `wsv1` — the session/access token every surface (gateway proxy, control
 *    listener, embedded MCP) verifies identically. Minted by the interactive
 *    GitHub flow (long TTL) and by the OAuth `/auth/token` endpoint (short TTL).
 *  - `wst1` — the short-lived OAuth `state` through the GitHub round-trip. The
 *    signature alone only proves WE minted it (redirect-target integrity);
 *    login-CSRF protection comes from the gateway ALSO setting the state's nonce
 *    in a short-lived cookie and requiring the two to match at the callback. The
 *    state optionally carries a {@link PendingOAuthRequest} so the OAuth 2.1
 *    authorize flow piggybacks the same GitHub dance.
 *  - `wsc1` — OAuth 2.1 authorization codes (very short TTL, PKCE-bound). A
 *    stateless blob cannot be marked consumed, so single-use is approximated by
 *    the short TTL + the PKCE verifier requirement — a deliberate, documented
 *    deviation (see the OAuth ADR).
 *  - `wsr1` — OAuth refresh tokens. Rotation re-mints with `exp` capped at the
 *    ORIGINAL grant's expiry, so a leaked refresh token can't extend itself;
 *    reuse of a superseded token is NOT detectable without a store (ditto ADR).
 *  - `wsid1` — stateless RFC 7591 client ids for public OAuth clients: the
 *    registration record (redirect URIs) IS the token, so registration persists
 *    nothing.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

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
const AUTH_CODE_PREFIX = "wsc1";
const REFRESH_PREFIX = "wsr1";
const CLIENT_ID_PREFIX = "wsid1";

/** Default authorization-code lifetime (seconds) — the single-use mitigation. */
export const AUTH_CODE_TTL_SECONDS = 120;
/** Client ids are effectively non-expiring (registration is free and stateless). */
const CLIENT_ID_TTL_SECONDS = 10 * 365 * 86_400;

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

/**
 * An OAuth 2.1 authorize request carried through the GitHub round-trip inside
 * the signed state — how `/auth/authorize` piggybacks the existing dance
 * without a cookie session.
 */
export interface PendingOAuthRequest {
  /** The verified `wsid1` client id the code will be bound to. */
  readonly cid: string;
  /** The chosen redirect_uri (must be one of the client id's registered URIs). */
  readonly ru: string;
  /** The PKCE code_challenge (S256, base64url). */
  readonly cc: string;
  /** The CLIENT's opaque `state`, echoed back verbatim on the code redirect. */
  readonly cs?: string;
  /** Optional RFC 8707 resource indicator (carried, not enforced). */
  readonly resource?: string;
}

/** Mint a short-lived OAuth `state` carrying the post-login redirect target. */
export function signState(
  secret: string,
  redirect: string | undefined,
  nonce: string,
  nowSeconds: number,
  ttlSeconds = 600,
  oauth?: PendingOAuthRequest,
): string {
  return sign(STATE_PREFIX, secret, {
    ...(redirect !== undefined ? { redirect } : {}),
    nonce,
    ...(oauth !== undefined ? { oauth } : {}),
    exp: nowSeconds + ttlSeconds,
  });
}

/** Verify an OAuth `state` → its redirect target + the browser-binding nonce. */
export function verifyState(
  secret: string,
  state: string,
  nowSeconds: number,
): { readonly redirect?: string; readonly nonce: string; readonly oauth?: PendingOAuthRequest } | undefined {
  const payload = verify(STATE_PREFIX, secret, state, nowSeconds);
  if (payload === undefined || typeof payload.nonce !== "string" || payload.nonce.length === 0) return undefined;
  const oauth = parsePendingOAuth(payload.oauth);
  return {
    nonce: payload.nonce,
    ...(typeof payload.redirect === "string" ? { redirect: payload.redirect } : {}),
    ...(oauth !== undefined ? { oauth } : {}),
  };
}

/** Validate the optional `oauth` member of a state payload (untrusted JSON shape). */
function parsePendingOAuth(raw: unknown): PendingOAuthRequest | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.cid !== "string" || typeof o.ru !== "string" || typeof o.cc !== "string") return undefined;
  return {
    cid: o.cid,
    ru: o.ru,
    cc: o.cc,
    ...(typeof o.cs === "string" ? { cs: o.cs } : {}),
    ...(typeof o.resource === "string" ? { resource: o.resource } : {}),
  };
}

// ── wsc1: OAuth authorization codes ─────────────────────────────────────────

/** The signed contents of a `wsc1` authorization code. */
export interface AuthCode extends SessionUser {
  /** The `wsid1` client id this code is bound to. */
  readonly cid: string;
  /** The redirect_uri the code was issued to (must match at `/auth/token`). */
  readonly ru: string;
  /** The PKCE code_challenge (S256, base64url). */
  readonly cc: string;
  /** Optional RFC 8707 resource indicator (carried, not enforced). */
  readonly resource?: string;
  readonly exp: number;
}

/** Mint an authorization code binding `user` to a client + redirect + PKCE challenge. */
export function signAuthCode(
  secret: string,
  user: SessionUser,
  req: Pick<PendingOAuthRequest, "cid" | "ru" | "cc" | "resource">,
  nowSeconds: number,
  ttlSeconds = AUTH_CODE_TTL_SECONDS,
): string {
  return sign(AUTH_CODE_PREFIX, secret, {
    sub: user.login,
    ...(user.name !== undefined ? { name: user.name } : {}),
    ...(user.avatarUrl !== undefined ? { avatarUrl: user.avatarUrl } : {}),
    cid: req.cid,
    ru: req.ru,
    cc: req.cc,
    ...(req.resource !== undefined ? { resource: req.resource } : {}),
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
  });
}

/** Verify an authorization code → its bound identity/client/PKCE, or `undefined`. */
export function verifyAuthCode(secret: string, code: string, nowSeconds: number): AuthCode | undefined {
  const payload = verify(AUTH_CODE_PREFIX, secret, code, nowSeconds);
  if (payload === undefined) return undefined;
  if (typeof payload.sub !== "string" || payload.sub.length === 0) return undefined;
  if (typeof payload.cid !== "string" || typeof payload.ru !== "string" || typeof payload.cc !== "string") return undefined;
  return {
    login: payload.sub,
    ...(typeof payload.name === "string" ? { name: payload.name } : {}),
    ...(typeof payload.avatarUrl === "string" ? { avatarUrl: payload.avatarUrl } : {}),
    cid: payload.cid,
    ru: payload.ru,
    cc: payload.cc,
    ...(typeof payload.resource === "string" ? { resource: payload.resource } : {}),
    exp: payload.exp as number,
  };
}

// ── wsr1: OAuth refresh tokens ──────────────────────────────────────────────

/** The signed contents of a `wsr1` refresh token. */
export interface RefreshToken extends SessionUser {
  /** The `wsid1` client id the grant was issued to. */
  readonly cid: string;
  readonly exp: number;
}

/**
 * Mint a refresh token. On rotation, pass the PREVIOUS token's `exp` as
 * `capSeconds` so the chain never outlives the original grant.
 */
export function signRefreshToken(
  secret: string,
  user: SessionUser,
  cid: string,
  nowSeconds: number,
  ttlSeconds: number,
  capSeconds?: number,
): string {
  const exp = Math.min(nowSeconds + ttlSeconds, capSeconds ?? Number.MAX_SAFE_INTEGER);
  return sign(REFRESH_PREFIX, secret, {
    sub: user.login,
    ...(user.name !== undefined ? { name: user.name } : {}),
    ...(user.avatarUrl !== undefined ? { avatarUrl: user.avatarUrl } : {}),
    cid,
    iat: nowSeconds,
    exp,
  });
}

/** Verify a refresh token → its identity + issuing client, or `undefined`. */
export function verifyRefreshToken(secret: string, token: string, nowSeconds: number): RefreshToken | undefined {
  const payload = verify(REFRESH_PREFIX, secret, token, nowSeconds);
  if (payload === undefined) return undefined;
  if (typeof payload.sub !== "string" || payload.sub.length === 0 || typeof payload.cid !== "string") return undefined;
  return {
    login: payload.sub,
    ...(typeof payload.name === "string" ? { name: payload.name } : {}),
    ...(typeof payload.avatarUrl === "string" ? { avatarUrl: payload.avatarUrl } : {}),
    cid: payload.cid,
    exp: payload.exp as number,
  };
}

// ── wsid1: stateless RFC 7591 client ids ────────────────────────────────────

/** The signed contents of a `wsid1` client id — the registration record itself. */
export interface ClientId {
  readonly redirectUris: readonly string[];
  readonly clientName?: string;
  readonly exp: number;
}

/** Mint a client id carrying its registered redirect URIs (the only state we need). */
export function signClientId(
  secret: string,
  redirectUris: readonly string[],
  clientName: string | undefined,
  nowSeconds: number,
): string {
  return sign(CLIENT_ID_PREFIX, secret, {
    ru: redirectUris,
    ...(clientName !== undefined ? { cn: clientName } : {}),
    iat: nowSeconds,
    exp: nowSeconds + CLIENT_ID_TTL_SECONDS,
  });
}

/** Verify a client id → its registered redirect URIs, or `undefined`. */
export function verifyClientId(secret: string, clientId: string, nowSeconds: number): ClientId | undefined {
  const payload = verify(CLIENT_ID_PREFIX, secret, clientId, nowSeconds);
  if (payload === undefined) return undefined;
  if (!Array.isArray(payload.ru) || payload.ru.length === 0 || !payload.ru.every((u) => typeof u === "string")) {
    return undefined;
  }
  return {
    redirectUris: payload.ru as string[],
    ...(typeof payload.cn === "string" ? { clientName: payload.cn } : {}),
    exp: payload.exp as number,
  };
}

// ── PKCE (RFC 7636, S256 only) ──────────────────────────────────────────────

/** The S256 transform: `base64url(sha256(verifier))`. */
export function pkceS256Challenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "utf8").digest("base64url");
}

/** Does `codeVerifier` prove possession of `codeChallenge` (constant-time)? */
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  return safeEqual(pkceS256Challenge(codeVerifier), codeChallenge);
}
