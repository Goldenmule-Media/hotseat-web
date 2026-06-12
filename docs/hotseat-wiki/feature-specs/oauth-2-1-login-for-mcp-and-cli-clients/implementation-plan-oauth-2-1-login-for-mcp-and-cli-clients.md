# Implementation plan — OAuth 2.1 login for MCP and CLI clients

**Status:** draft

## Steps
- [x] wiki-server/src/auth/tokens.ts: add the wsc1 authorization-code family (signAuthCode/verifyAuthCode; payload {sub, name?, avatarUrl?, cid, ru, cc, resource?, iat, exp}, default TTL 120s) and the wsr1 refresh-token family (signRefreshToken/verifyRefreshToken; payload {sub, name?, avatarUrl?, cid, iat, exp}), reusing the private sign()/verify()/hmac()/safeEqual() primitives; add verifyPkceS256(codeVerifier, codeChallenge) using node:crypto sha256 → base64url + safeEqual. Extend signState/verifyState to carry an optional oauth request object alongside redirect+nonce.
- [x] wiki-server/src/config.ts: add accessTokenTtlSeconds (default 3600) and refreshTokenTtlDays (default = sessionTtlDays) to WikiServerConfig and resolveConfig, env keys WIKI_SERVER_ACCESS_TOKEN_TTL_SECONDS / WIKI_SERVER_REFRESH_TOKEN_TTL_DAYS; thread both through GatewayConfig at the startGateway call in main.ts.
- [x] New wiki-server/src/auth/oauth.ts with pure functions for: (a) the RFC 8414 authorization-server metadata document and RFC 9728 protected-resource document built from cfg.publicUrl; (b) RFC 7591 stateless registration — validate redirect_uris (https, or http on 127.0.0.1/[::1]/localhost per RFC 8252), mint client_id as a signed wsid1 blob carrying {redirect_uris, client_name?, iat}, return token_endpoint_auth_method 'none'; (c) authorize-request validation (response_type=code, code_challenge_method=S256 required, redirect_uri must match the verified client_id blob); (d) grant handlers for authorization_code (verify wsc1, match cid+ru, verify PKCE, mint wsv1 via signSession with accessTokenTtlSeconds + wsr1 refresh) and refresh_token (verify wsr1, re-check allowedUsers, mint new wsv1 + rotated wsr1 with exp capped at the original), returning RFC 6749 JSON shapes/errors.
- [x] wiki-server/src/auth/gateway.ts: route the new surface. Serve GET /.well-known/oauth-authorization-server and /.well-known/oauth-protected-resource publicly (with CORS headers) before handleDataPlane's deny-by-default proxy. In handleAuthRoute before the bearer-session gate: POST /auth/register, GET /auth/authorize (validate request, embed it in signState with the existing nonce-cookie pattern, 302 to GitHub), POST /auth/token (parse form-encoded body, dispatch to oauth.ts grant handlers). In /auth/github/callback, after exchangeCodeForUser + allowedUsers check, branch: if the verified state carries an oauth request, mint a wsc1 code and 302 to the client redirect_uri with ?code=…&state=… (client state echoed verbatim); else keep the existing session-token fragment/HTML flow byte-for-byte.
- [x] gateway.ts unauthenticated(): extend the header to Bearer realm="wiki-server", resource_metadata="<publicUrl>/.well-known/oauth-protected-resource". Extend the main.ts namespace-collision guard to also reserve the .well-known prefix.
- [x] wiki-mcp/src/mcp/server.ts + wiki-server/src/main.ts: add an optional host-injected resourceMetadataUrl to the MCP HTTP transport config so its 401 emits Bearer realm="wiki-mcp", resource_metadata=…, and have the MCP listener answer GET /.well-known/oauth-protected-resource with {resource: <mcp url>, authorization_servers: [publicUrl]} so MCP-spec origin-based discovery works on the MCP port; McpAuth itself is untouched.
- [x] New shared CLI OAuth client at wiki/auth-client (Node-only subpath export beside wiki/authoring · wiki/registry · wiki/testing): discoverAuthServer(serverUrl) (fetch resource metadata → AS metadata), registerClient(), loginLoopback() (bind http://127.0.0.1:<random port>/callback, print/open the /auth/authorize URL with PKCE verifier+S256 challenge, await the code, exchange at /auth/token), a CredentialsStore for ~/.wiki/credentials.json keyed by server origin (atomic temp+rename, chmod 0600, never logged), and oauthHeaders(serverUrl) returning an IStreamHeaders authorization function that returns the cached access token, refreshing via grant_type=refresh_token when expired or within a skew window.
- [x] wiki-mirror: add a login subcommand to bin.ts/main.ts running loginLoopback against the resolved streamBaseUrl and persisting credentials; in startMirror replace the static Bearer header with: explicit static token (flags → WIKI_MIRROR_TOKEN → config file token) wins; else if ~/.wiki/credentials.json has an entry for the server, headers: { authorization: oauthHeaders(streamBaseUrl) }; else unauthenticated as today.
- [x] wiki-mcp/src/migrate-workspace.ts: streamConfig() gains the same fallback — --source-token/--dest-token/WIKI_MIGRATE_*_TOKEN still win, else oauthHeaders(url) from the shared client; document the login path in its usage text for first-time credential acquisition.
- [x] Tests: new wiki-server/test/auth-oauth.test.ts (metadata, registration, full authorize→GitHub-stub→code→token→refresh dance with injected clock, PKCE failure, tamper/expiry, allowedUsers-at-refresh, secret-rotation kill-switch) extending the githubStub + DurableStreamTestServer harness from auth-gateway.test.ts; extend auth-tokens.test.ts for wsc1/wsr1/wsid1; wiki client tests for CredentialsStore + refreshing-header behavior using the RecordingProxy pattern from wiki-mirror/test/token-header.test.ts; auth-wiring.test.ts assertion that the MCP 401 carries resource_metadata.
- [x] Docs: update .env.example (new TTL vars; note .mcp.json no longer needs a pasted Authorization header — Claude Code auto-discovers via the 401), update the CLAUDE.md running-locally auth bullet, write the ADR ('OAuth 2.1 façade over the stateless gateway — signed-blob codes and refresh tokens', documenting the deliberate single-use/reuse-detection deviations) linking the IStreamConfig.headers and GitHub-auth ADRs, update the tokens.ts header comment that documents the token families, and fill this feature's spec page.

## Data models & interfaces
```typescript
// ── wiki-server/src/auth/tokens.ts — new stateless token families ──
// All follow the existing `<prefix>.<base64url(json)>.<base64url(hmac-sha256)>`
// shape. No server-side storage; secret rotation revokes everything at once,
// exactly like wsv1/wst1 today.

/** wsc1 — authorization code (short TTL, default 120s; RFC 6749 §4.1 + PKCE). */
export interface AuthCodePayload {
  readonly sub: string;            // GitHub login, lowercase (same principal as wsv1 `sub`)
  readonly name?: string;
  readonly avatarUrl?: string;
  readonly cid: string;            // client_id (itself a signed wsid1 blob) this code is bound to
  readonly ru: string;             // redirect_uri the code was issued to (must match at /auth/token)
  readonly cc: string;             // PKCE code_challenge (S256, base64url)
  readonly resource?: string;      // optional RFC 8707 resource indicator (carried, not enforced)
  readonly iat: number;
  readonly exp: number;            // unix seconds — verify() already enforces expiry
}

/** wsr1 — refresh token (long TTL, default = sessionTtlDays). */
export interface RefreshTokenPayload {
  readonly sub: string;
  readonly name?: string;
  readonly avatarUrl?: string;
  readonly cid: string;            // issuing client_id
  readonly iat: number;
  readonly exp: number;            // rotation re-mints with exp capped at the ORIGINAL exp
}

/** wsid1 — stateless RFC 7591 client_id (public clients, token_endpoint_auth_method "none"). */
export interface ClientIdPayload {
  readonly redirect_uris: readonly string[]; // https, or http on a loopback host (RFC 8252)
  readonly client_name?: string;
  readonly iat: number;
  readonly exp: number;            // effectively non-expiring (far-future); registration is free
}

// Access tokens remain the EXISTING wsv1 session shape minted by signSession —
// only the TTL drops to cfg.accessTokenTtlSeconds, so gateway proxy, control
// listener, and McpAuth verify them with zero changes.

/** Pending OAuth request carried through the GitHub round-trip inside the wst1 state. */
export interface PendingOAuthRequest {
  readonly cid: string;            // verified wsid1 client_id
  readonly ru: string;             // chosen redirect_uri
  readonly cc: string;             // PKCE code_challenge (S256)
  readonly cs: string;             // the CLIENT's opaque `state`, echoed back verbatim
  readonly resource?: string;
}
// state payload becomes { redirect?, nonce, oauth?: PendingOAuthRequest, exp }

/** /auth/token response (RFC 6749 §5.1). */
export interface TokenResponse {
  readonly access_token: string;   // wsv1.…  (short-lived)
  readonly token_type: "Bearer";
  readonly expires_in: number;     // = accessTokenTtlSeconds
  readonly refresh_token: string;  // wsr1.…
}
```

```typescript
// ── wiki/auth-client — ~/.wiki/credentials.json (per-machine, mode 0600) ──
// Sibling of ~/.wiki/wiki-mirror.config.json; atomic temp+rename writes.
// Never logged (the rule already stated for the static wiki-mirror token).

export interface CredentialsFile {
  /** Keyed by server ORIGIN (e.g. "https://wiki.example.com"). */
  readonly servers: Readonly<Record<string, ServerCredentials>>;
}

export interface ServerCredentials {
  readonly clientId: string;        // wsid1.… from POST /auth/register
  readonly accessToken: string;     // wsv1.…  (current short-lived token)
  readonly accessTokenExp: number;  // unix seconds — refresh when now >= exp - skew
  readonly refreshToken: string;    // wsr1.…  (replaced on each rotation)
  readonly refreshTokenExp: number; // when this passes, a new `login` is required
  readonly tokenEndpoint: string;   // captured at login; reused for refresh (no re-discovery)
  readonly user: string;            // login, for whoami-style display only
}

/**
 * The integration point: an IStreamHeaders-compatible value
 * (`string | (() => string | Promise<string>)`, evaluated per request by the
 * engine's EventLog headerOpts()). Replaces today's static strings in
 * wiki-mirror main.ts and wiki-mcp migrate-workspace.ts.
 */
export declare function oauthHeaders(serverUrl: string): {
  readonly authorization: () => Promise<string>;
};
```

## Open questions
_None._

## Resolved questions
_None._

## References
_None._

## Child pages
_None._
