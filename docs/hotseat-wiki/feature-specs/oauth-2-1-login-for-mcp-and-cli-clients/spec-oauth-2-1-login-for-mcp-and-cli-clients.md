# Spec — OAuth 2.1 login for MCP and CLI clients

**Status:** drafting

## Overview
MCP clients and CLIs sign in to an auth-gated wiki-server through the standard OAuth 2.1 flow instead of copying static bearer tokens. The gateway exposes an authorization-server façade (discovery, dynamic registration, authorize, token) in front of its existing GitHub login and stateless token mint; clients hold short-lived wsv1 access tokens and refresh them autonomously. Shipped surfaces: the gateway endpoints, RFC 9728 discovery on every 401 (gateway and embedded MCP), the Node-only wiki/auth-client subpath (loopback login + ~/.wiki/credentials.json + a refreshing header function), a wiki-mirror login subcommand, and a credentials fallback in migrate-workspace. Static tokens keep working and take precedence everywhere.

## Design
## Endpoints (gateway)

GET /.well-known/oauth-authorization-server and GET /.well-known/oauth-protected-resource: public RFC 8414 / RFC 9728 documents, served ahead of the deny-by-default data-plane proxy, CORS-open. POST /auth/register: RFC 7591 public-client registration; redirect URIs must be https or loopback http; the minted client_id is a signed wsid1 blob carrying the registration itself (nothing persisted). GET /auth/authorize: validates response_type=code, a registered client_id + exact redirect_uri, and a mandatory S256 code_challenge, then chains into the existing GitHub dance with the pending request embedded in the signed state; the callback redirects back with a 120-second wsc1 code. POST /auth/token (form-encoded): authorization_code grant (PKCE verified against the code's embedded challenge) and refresh_token grant (rotation capped at the original expiry, allowlist re-checked) — both return a short-lived wsv1 access token plus a wsr1 refresh token.

## Discovery on 401

The gateway's unauthenticated data-plane response carries WWW-Authenticate: Bearer realm="wiki-server", resource_metadata="<publicUrl>/.well-known/oauth-protected-resource". The embedded MCP transport's 401 carries the same resource_metadata via a host-injected authDiscovery (wiki-mcp itself learns no OAuth concepts), and the MCP listener serves its own protected-resource document naming the gateway as the authorization server. An MCP client therefore bootstraps the whole login from a bare 401 — .mcp.json needs no Authorization header.

## CLI client (wiki/auth-client)

A Node-only subpath export of the engine package (never imported by browser surfaces). loginLoopback() binds 127.0.0.1 on an ephemeral port, registers a client, sends the user through /auth/authorize with PKCE, exchanges the redirected code, and persists the grant to ~/.wiki/credentials.json (keyed by server origin, mode 0600, atomic temp+rename, never logged). oauthHeaders(serverUrl) returns an authorization FUNCTION compatible with the engine's IStreamHeaders seam: it serves the cached access token while fresh and runs one shared refresh when within 60 seconds of expiry — the engine evaluates header functions per request, so renewal lands on the next stream request with no restart. wiki-mirror grows a login subcommand and falls back to the stored grant when no static token is configured; migrate-workspace does the same behind its --source-token/--dest-token flags.

## Decisions
Authorization codes are NOT strictly single-use: a stateless signed blob cannot be marked consumed. Accepted mitigation: 120-second TTL plus mandatory PKCE S256 (a replayed code is useless without the verifier). No seen-codes cache — consistent with the gateway's no-store philosophy; documented as a deliberate deviation in the OAuth ADR. Single-use authorization codes: OAuth 2.1 requires codes be single-use, but a stateless signed blob cannot be marked consumed. Accept very short TTL (120s) + PKCE binding as the mitigation (consistent with the no-store philosophy), or add a tiny per-process in-memory seen-codes cache (fine single-node, lost on restart)?

Refresh tokens rotate WITHOUT reuse detection (detection requires a store). Every rotation's expiry is capped at the original grant's, so a leaked refresh chain cannot extend its own life. The gap is stated plainly rather than implying a guarantee the design cannot honor. Refresh-token rotation semantics: OAuth 2.1 expects rotation with reuse detection for public clients; statelessly we can rotate (new wsr1 per refresh, exp capped at the original) but CANNOT detect reuse of the old one until expiry. Is capped rotation without reuse detection acceptable, or should refresh tokens be fixed (no rotation)?

The shared CLI client lives at wiki/auth-client — a new Node-only subpath export beside wiki/authoring, wiki/registry, and wiki/testing. One implementation beats two drifting copies; the engine core stays transport-free because the subpath is opt-in and no browser surface imports it. Home of the shared CLI OAuth client: a new Node-only wiki/auth-client subpath export (engine package gains node:fs/node:http in an isolated subpath — wiki-ui simply never imports it) vs. duplicating a small module in wiki-mirror and wiki-mcp (no boundary risk, but two copies)?

v1 ships loopback-redirect (RFC 8252) only — both current consumers run on machines with a browser. Device-code (RFC 8628) for headless/SSH hosts is deferred; the façade's grant handlers are pure functions a future /auth/device route reuses additively. CLI flow: ship loopback-redirect (RFC 8252) only, or also device-code (RFC 8628) for headless/SSH machines where no local browser can open the authorize URL? Device-code adds two endpoints (/auth/device, polling on /auth/token) and a verification-URI page.

OAuth clients get 3600-second access tokens (WIKI_SERVER_ACCESS_TOKEN_TTL_SECONDS) with refresh tokens defaulting to the 30-day session TTL (WIKI_SERVER_REFRESH_TOKEN_TTL_DAYS). The interactive wiki-ui flow keeps its 30-day fragment token byte-identically; migrating wiki-ui to short-access-plus-refresh is a separate feature. TTL defaults and the wiki-ui session: keep the interactive GitHub-callback fragment token at sessionTtlDays (30d wsv1, today's behavior) while OAuth clients get 1h access + 30d refresh — or move wiki-ui onto the short-access+refresh model too (more work in wiki-ui/lib/auth.ts, better hygiene)?

Tokens stay global-per-user: the existing per-surface enforcement (every surface re-checks the access ledger per request; identity is never trusted across surfaces) already provides the isolation RFC 8707 audiences would add. The resource parameter is accepted and carried in the code blob for forward-compatibility but does not scope the minted token. Token scope/resource: keep tokens global-per-user with per-request ledger checks (the existing per-surface enforcement; simplest), or honor RFC 8707 resource indicators to mint audience-scoped tokens (stream vs MCP)?

## References
_None._

## Child pages
_None._
