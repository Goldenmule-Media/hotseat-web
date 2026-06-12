/**
 * The OAuth 2.1 authorization-server façade over the stateless gateway — pure
 * functions the gateway routes into (no I/O here, no listener, no store). This
 * is how MCP clients (whose spec mandates OAuth 2.1 discovery) and CLIs obtain
 * the SAME `wsv1` bearer tokens the interactive GitHub flow mints, without a
 * human copying them around:
 *
 *   discovery   GET /.well-known/oauth-authorization-server   (RFC 8414)
 *               GET /.well-known/oauth-protected-resource     (RFC 9728)
 *   register    POST /auth/register                           (RFC 7591)
 *   authorize   GET  /auth/authorize → GitHub → callback → `wsc1` code
 *   token       POST /auth/token (authorization_code | refresh_token grants)
 *
 * Everything is a signed blob (tokens.ts): the client_id carries its own
 * registration record, the code carries its PKCE challenge, the refresh token
 * carries its principal. Deviations from OAuth 2.1 strictness forced by
 * statelessness — codes not strictly single-use (120s TTL + PKCE instead),
 * refresh rotation without reuse detection (expiry capped at the original
 * grant) — are deliberate and documented in the OAuth ADR.
 */
import {
  AUTH_CODE_TTL_SECONDS,
  signAuthCode,
  signClientId,
  signRefreshToken,
  signSession,
  verifyAuthCode,
  verifyClientId,
  verifyPkceS256,
  verifyRefreshToken,
  type PendingOAuthRequest,
  type SessionUser,
} from "./tokens.js";

/** What the grant handlers need to know about the server. */
export interface OAuthConfig {
  /** The gateway's external base URL (issuer). */
  readonly publicUrl: string;
  readonly sessionSecret: string;
  /** Access-token lifetime for OAuth-minted `wsv1` tokens (seconds). */
  readonly accessTokenTtlSeconds: number;
  /** Refresh-token lifetime (seconds). */
  readonly refreshTokenTtlSeconds: number;
  /** GitHub logins allowed to sign in; checked again at refresh. Unset = anyone. */
  readonly allowedUsers?: readonly string[];
}

/** An RFC 6749 error response body (the gateway maps `status` onto it). */
export interface OAuthError {
  readonly status: number;
  readonly error: string;
  readonly error_description: string;
}

const oauthError = (status: number, error: string, description: string): OAuthError => ({
  status,
  error,
  error_description: description,
});

/** Is this value an {@link OAuthError}? (Discriminates handler results.) */
export function isOAuthError(value: unknown): value is OAuthError {
  return typeof value === "object" && value !== null && "error" in value && "status" in value;
}

// ── discovery documents ─────────────────────────────────────────────────────

/** RFC 8414 authorization-server metadata. */
export function authorizationServerMetadata(publicUrl: string): Record<string, unknown> {
  return {
    issuer: publicUrl,
    authorization_endpoint: `${publicUrl}/auth/authorize`,
    token_endpoint: `${publicUrl}/auth/token`,
    registration_endpoint: `${publicUrl}/auth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [],
  };
}

/**
 * RFC 9728 protected-resource metadata. `resource` is the protected surface
 * (the gateway itself, or the MCP endpoint when served from the MCP listener);
 * the authorization server is always the gateway.
 */
export function protectedResourceMetadata(resource: string, authServerUrl: string): Record<string, unknown> {
  return {
    resource,
    authorization_servers: [authServerUrl],
    bearer_methods_supported: ["header"],
  };
}

// ── RFC 7591 dynamic client registration (stateless) ────────────────────────

/** Loopback hosts allowed plain-http redirect URIs (RFC 8252 §7.3). */
const LOOPBACK_REDIRECT_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/** Is this a registrable redirect URI: https anywhere, or http on a loopback host? */
export function isAllowedRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  // URL.host keeps the brackets on an IPv6 literal and the port if present.
  return LOOPBACK_REDIRECT_HOSTS.has(url.hostname === "::1" ? "[::1]" : url.hostname);
}

/** A successful RFC 7591 registration response. */
export interface ClientRegistration {
  readonly client_id: string;
  readonly redirect_uris: readonly string[];
  readonly token_endpoint_auth_method: "none";
  readonly grant_types: readonly string[];
  readonly response_types: readonly string[];
  readonly client_name?: string;
}

/**
 * Register a public client: validate the redirect URIs and mint a `wsid1`
 * client_id that IS the registration record. Nothing is persisted — a client_id
 * verifies on any future request because the secret signs it.
 */
export function registerClient(
  cfg: OAuthConfig,
  body: unknown,
  nowSeconds: number,
): ClientRegistration | OAuthError {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === "string")) {
    return oauthError(400, "invalid_redirect_uri", "redirect_uris must be a non-empty array of strings");
  }
  for (const uri of uris as string[]) {
    if (!isAllowedRedirectUri(uri)) {
      return oauthError(
        400,
        "invalid_redirect_uri",
        `redirect_uri "${uri}" is not allowed: must be https, or http on a loopback host (127.0.0.1, [::1], localhost)`,
      );
    }
  }
  const clientName = typeof b.client_name === "string" && b.client_name.length > 0 ? b.client_name : undefined;
  const client_id = signClientId(cfg.sessionSecret, uris as string[], clientName, nowSeconds);
  return {
    client_id,
    redirect_uris: uris as string[],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    ...(clientName !== undefined ? { client_name: clientName } : {}),
  };
}

// ── authorize-request validation ────────────────────────────────────────────

/**
 * Validate a `/auth/authorize` query into the {@link PendingOAuthRequest} the
 * gateway embeds in the signed GitHub state. Per RFC 6749 §4.1.2.1 an invalid
 * client_id/redirect_uri must NOT redirect (the caller answers 400 directly);
 * other failures could redirect with `?error=…`, but every current client
 * surfaces the 400 body just as well, so the gateway keeps one error path.
 */
export function validateAuthorizeRequest(
  cfg: OAuthConfig,
  params: URLSearchParams,
  nowSeconds: number,
): PendingOAuthRequest | OAuthError {
  const clientId = params.get("client_id");
  if (clientId === null) return oauthError(400, "invalid_request", "client_id is required");
  const client = verifyClientId(cfg.sessionSecret, clientId, nowSeconds);
  if (client === undefined) return oauthError(400, "invalid_client", "client_id is not a valid registered client");

  const redirectUri = params.get("redirect_uri");
  if (redirectUri === null || !client.redirectUris.includes(redirectUri)) {
    return oauthError(400, "invalid_request", "redirect_uri must exactly match one registered for this client");
  }

  if (params.get("response_type") !== "code") {
    return oauthError(400, "unsupported_response_type", 'response_type must be "code"');
  }
  const challenge = params.get("code_challenge");
  if (challenge === null || challenge.length === 0) {
    return oauthError(400, "invalid_request", "code_challenge is required (PKCE S256)");
  }
  if (params.get("code_challenge_method") !== "S256") {
    return oauthError(400, "invalid_request", 'code_challenge_method must be "S256"');
  }

  const state = params.get("state") ?? undefined;
  const resource = params.get("resource") ?? undefined;
  return {
    cid: clientId,
    ru: redirectUri,
    cc: challenge,
    ...(state !== undefined ? { cs: state } : {}),
    ...(resource !== undefined ? { resource } : {}),
  };
}

/** Mint the `wsc1` code the callback redirects back with (post-GitHub, post-allowlist). */
export function mintAuthorizationCode(
  cfg: OAuthConfig,
  user: SessionUser,
  request: PendingOAuthRequest,
  nowSeconds: number,
): string {
  return signAuthCode(cfg.sessionSecret, user, request, nowSeconds, AUTH_CODE_TTL_SECONDS);
}

// ── /auth/token grants ──────────────────────────────────────────────────────

/** A successful RFC 6749 §5.1 token response. */
export interface TokenResponse {
  readonly access_token: string;
  readonly token_type: "Bearer";
  readonly expires_in: number;
  readonly refresh_token: string;
}

/** Dispatch a parsed `/auth/token` form body to the right grant handler. */
export function handleTokenGrant(
  cfg: OAuthConfig,
  form: URLSearchParams,
  nowSeconds: number,
): TokenResponse | OAuthError {
  const grantType = form.get("grant_type");
  if (grantType === "authorization_code") return authorizationCodeGrant(cfg, form, nowSeconds);
  if (grantType === "refresh_token") return refreshTokenGrant(cfg, form, nowSeconds);
  return oauthError(400, "unsupported_grant_type", 'grant_type must be "authorization_code" or "refresh_token"');
}

function userAllowed(cfg: OAuthConfig, login: string): boolean {
  return cfg.allowedUsers === undefined || cfg.allowedUsers.includes(login);
}

function mintTokens(cfg: OAuthConfig, user: SessionUser, cid: string, nowSeconds: number, refreshCap?: number): TokenResponse {
  return {
    access_token: signSession(cfg.sessionSecret, user, cfg.accessTokenTtlSeconds, nowSeconds),
    token_type: "Bearer",
    expires_in: cfg.accessTokenTtlSeconds,
    refresh_token: signRefreshToken(cfg.sessionSecret, user, cid, nowSeconds, cfg.refreshTokenTtlSeconds, refreshCap),
  };
}

function authorizationCodeGrant(cfg: OAuthConfig, form: URLSearchParams, nowSeconds: number): TokenResponse | OAuthError {
  const code = form.get("code");
  const verifier = form.get("code_verifier");
  const clientId = form.get("client_id");
  const redirectUri = form.get("redirect_uri");
  if (code === null || verifier === null || clientId === null) {
    return oauthError(400, "invalid_request", "code, code_verifier, and client_id are required");
  }
  const parsed = verifyAuthCode(cfg.sessionSecret, code, nowSeconds);
  if (parsed === undefined) return oauthError(400, "invalid_grant", "authorization code is invalid or expired");
  if (parsed.cid !== clientId) return oauthError(400, "invalid_grant", "code was issued to a different client");
  if (redirectUri !== null && redirectUri !== parsed.ru) {
    return oauthError(400, "invalid_grant", "redirect_uri does not match the one the code was issued to");
  }
  if (!verifyPkceS256(verifier, parsed.cc)) {
    return oauthError(400, "invalid_grant", "PKCE verification failed");
  }
  // Allowlist membership was checked when the code was minted, but re-check —
  // the list may have changed between mint and redemption.
  if (!userAllowed(cfg, parsed.login)) {
    return oauthError(400, "invalid_grant", "user is no longer allowed on this server");
  }
  const user: SessionUser = {
    login: parsed.login,
    ...(parsed.name !== undefined ? { name: parsed.name } : {}),
    ...(parsed.avatarUrl !== undefined ? { avatarUrl: parsed.avatarUrl } : {}),
  };
  return mintTokens(cfg, user, parsed.cid, nowSeconds);
}

function refreshTokenGrant(cfg: OAuthConfig, form: URLSearchParams, nowSeconds: number): TokenResponse | OAuthError {
  const token = form.get("refresh_token");
  if (token === null) return oauthError(400, "invalid_request", "refresh_token is required");
  const parsed = verifyRefreshToken(cfg.sessionSecret, token, nowSeconds);
  if (parsed === undefined) return oauthError(400, "invalid_grant", "refresh token is invalid or expired");
  const clientId = form.get("client_id");
  if (clientId !== null && clientId !== parsed.cid) {
    return oauthError(400, "invalid_grant", "refresh token was issued to a different client");
  }
  // The allowlist gate at refresh is what makes removing a user actually cut
  // them off (their access token dies within accessTokenTtlSeconds).
  if (!userAllowed(cfg, parsed.login)) {
    return oauthError(400, "invalid_grant", "user is no longer allowed on this server");
  }
  const user: SessionUser = {
    login: parsed.login,
    ...(parsed.name !== undefined ? { name: parsed.name } : {}),
    ...(parsed.avatarUrl !== undefined ? { avatarUrl: parsed.avatarUrl } : {}),
  };
  // Rotation: the new refresh token's expiry is capped at the OLD one's, so a
  // refresh chain never outlives its original grant.
  return mintTokens(cfg, user, parsed.cid, nowSeconds, parsed.exp);
}
