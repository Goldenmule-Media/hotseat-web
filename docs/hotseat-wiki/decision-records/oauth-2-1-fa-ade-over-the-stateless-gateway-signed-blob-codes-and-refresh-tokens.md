# ADR-34: OAuth 2.1 façade over the stateless gateway — signed-blob codes and refresh tokens

**Status:** accepted

## Metadata
- **Date:** 2026-06-12
- **Scope:** wiki-server (auth gateway); wiki/auth-client; wiki-mirror; wiki-mcp transport
- **Deciders:** Benjamin Jordan

## Context
The gateway's GitHub auth mints stateless wsv1 bearer sessions, but MCP clients and CLIs obtained them by a human copying a token from the wiki-ui account menu into .mcp.json or WIKI_MIRROR_TOKEN — a 30-day credential pasted into config files (one of them git-tracked), expiring silently with no refresh story. The MCP specification mandates OAuth 2.1 for HTTP servers, and MCP clients (Claude Code) implement the client half natively: discovery from a 401's resource_metadata, dynamic client registration, a browser PKCE flow, and automatic token refresh. The question was how to serve that flow without betraying the gateway's stateless design (no session store; revocation = secret rotation).

## Decision
The gateway grows an OAuth 2.1 authorization-server façade in front of the SAME token mint: RFC 8414/9728 discovery documents at /.well-known/_, RFC 7591 dynamic client registration at /auth/register, /auth/authorize, and /auth/token — all pure logic in auth/oauth.ts, with gateway.ts doing thin routing. The /.well-known/_ paths are carved out as public routes ahead of the deny-by-default data-plane proxy, and the reserved-namespace guard also reserves .well-known.

Every artifact stays a stateless HMAC-signed blob in tokens.ts, beside wsv1/wst1: client ids (wsid1) carry their own registration record (redirect URIs), authorization codes (wsc1) carry the PKCE challenge and client binding at a 120-second TTL, refresh tokens (wsr1) carry the principal and issuing client. No store of any kind is added; rotating the session secret remains the single revocation switch and now kills sessions, codes, refresh tokens, and client ids at once.

Access tokens remain the EXISTING wsv1 session format, minted with a short TTL (default 3600 seconds, WIKI_SERVER_ACCESS_TOKEN_TTL_SECONDS) — every verifying surface (gateway data plane, control listener, the embedded MCP's McpAuth) works unchanged. OAuth changes only how clients OBTAIN tokens, never how tokens are verified.

/auth/authorize piggybacks the existing GitHub dance: the gateway has no cookie session, so every authorize chains into GitHub (a signed-in user sees one silent redirect), carrying the pending OAuth request inside the signed wst1 state with the same nonce-cookie CSRF binding. The callback branches on that payload: with it, a wsc1 code goes back to the client's registered redirect_uri; without it, the existing fragment-token flow is byte-identical.

Two deliberate deviations from OAuth 2.1 strictness, forced by statelessness and accepted: authorization codes are not strictly single-use (mitigated by the 120-second TTL plus mandatory PKCE S256 — a replayed code is useless without the verifier), and refresh rotation cannot detect reuse of a superseded token (mitigated by capping every rotation's expiry at the original grant's, so a leaked refresh chain never outlives its grant). The allowlist is re-checked at every code mint AND refresh grant, so removing a user cuts them off within one access-token lifetime.

wiki-mcp stays auth-mechanism-agnostic: the host injects an opaque authDiscovery into the HTTP transport (the 401's resource_metadata URL plus a protected-resource document the MCP listener serves at its own /.well-known path); McpAuth is untouched and learns no OAuth concepts.

CLIs share one client implementation: the Node-only wiki/auth-client subpath export (loopback-redirect login per RFC 8252, credentials at ~/.wiki/credentials.json with mode 0600 and atomic writes, and a refreshing IStreamHeaders authorization function riding the engine's per-request header seam). wiki-mirror gains a login subcommand; migrate-workspace falls back to the same stored grant. Static tokens keep working everywhere and take precedence.

## Consequences
.mcp.json needs no Authorization header: an MCP client discovers the flow from the 401, opens the browser once, and manages its own tokens from then on. wiki-mirror login replaces token copying for CLIs. The copied-token path (wiki-ui account menu) remains as an escape hatch and wins when set.

Credential exposure shrinks: a leaked OAuth access token dies within the hour instead of 30 days, and a leaked refresh token cannot extend its own life. The interactive wiki-ui session is unchanged (30-day fragment token) — moving it onto short-access-plus-refresh is possible later but out of scope here.

Registration is unauthenticated and free by design (public clients, stateless ids): a registered client id grants nothing by itself — every token still requires a GitHub sign-in by an allowlisted user through the gateway's own dance.

Headless machines (no local browser) are not yet served: device-code (RFC 8628) is additive later — the façade's grant handlers are pure functions a /auth/device route can reuse.

## Relations
_None._
