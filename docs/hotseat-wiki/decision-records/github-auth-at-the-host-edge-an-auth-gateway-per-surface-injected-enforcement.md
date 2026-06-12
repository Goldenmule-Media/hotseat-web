# ADR-33: GitHub auth at the host edge: an auth gateway + per-surface injected enforcement

**Status:** accepted

## Metadata
- **Date:** 2026-06-12
- **Scope:** wiki-server (auth gateway) · wiki-mcp (injected McpAuth) · wiki engine (IStreamConfig.headers) · wiki-mirror + wiki-ui (token clients)

## Context
Deploying wiki-server beyond loopback needs sign-in and per-project sharing: a workspace should belong to whoever created it, be usable by members its owner adds, and be invisible work for everyone else. The constraints are structural. The engine is transport-free and schema-agnostic, so identity must never enter events, folds, or models. The wrapped Durable Streams host has no request middleware, so the stream port itself cannot authenticate. And there is no single front door: the browser engine (wiki-ui), the markdown mirror, and MCP agents are all independent stream clients that write directly. The client half was already decided — *Remote auth via an engine IStreamConfig.headers hook* (accepted) gives every embedded engine a way to send credentials. This record decides the server half: where authentication lives, what the credential is, and where each surface enforces access.

## Decision
GitHub OAuth is the only identity provider, and wiki-server owns the entire auth plane (src/auth): tokens, the OAuth dance, the access ledger, and the gateway. Nothing auth-shaped touches the engine or models — the engine's sole contribution stays the already-accepted IStreamConfig.headers hook, and event payloads remain identity-free.

An auth gateway takes over the public stream port when --auth github is set; the raw stream host moves to an internal loopback ephemeral port. The gateway serves /auth/* (OAuth, /auth/config discovery, /auth/me, membership API) and reverse-proxies everything else verbatim — SSE, long-polls, gzip, etags, and OCC 409s pass through unbuffered. With --auth none (the default) the wiring is byte-identical to before: no gateway, open local dev.

The credential is a stateless HMAC-signed bearer session (wsv1.<payload>.<sig>, default 30 days) minted by the gateway after GitHub sign-in and handed back in the redirect's URL fragment so it never lands in a server log. One token works against all three listeners and for non-browser clients (.mcp.json headers, WIKI_MIRROR_TOKEN). The signing secret is supplied by config or generated and persisted under <dataDir>/auth/; rotating it signs everyone out, which is the whole revocation story.

Workspace = project, and ownership is host state, not stream content: a JSON ledger at <dataDir>/auth/access.json maps workspaceId to { owner, members }. The creator becomes owner via the one wire signal every client shares — the PUT that 201-creates the workspace stream at the gateway, or the createWorkspace tool at the MCP surface. Owners manage members over /auth/workspaces/{id}/members; workspaces that predate auth are open to any signed-in user until someone claims them (first-wins) via /claim.

Enforcement is per-surface; identity is never trusted across surfaces. The gateway authorizes stream paths (/{ns}/workspace/{id}[/snapshot]) by membership before proxying. The embedded wiki-mcp keeps talking to the internal host and enforces the same ledger through an injected McpAuth seam: 401 at the HTTP transport, a generic gate on any tool whose args carry workspaceId (member level by default, owner level for rename/archive/unarchive), ownership attribution on createWorkspace, and filtered listWorkspaces/resource listings. wiki-mcp stays mechanism-agnostic — it sees hooks, never tokens. The control listener requires the same bearer for everything except /_server/health.

Hardening from the adversarial review, same edge philosophy: the gateway's data plane is DENY-BY-DEFAULT (only /{ns}/workspace/{id}[/snapshot] and /{ns}/_catalog proxy through — the wrapped server's fault-injection and subscription planes are unreachable, and stream DELETE is owner-only); the OAuth state nonce is mirrored in a short-lived SameSite=Lax cookie the callback must match, binding the dance to the browser that started it (login CSRF); WIKI_SERVER_AUTH_USERS optionally allowlists who may sign in at all (unset warns loudly — any GitHub account); and the control listener binds loopback-only in auth mode — its model-load/unregister/log routes are operator surface, and "holds a valid session" is not "operator".

## Consequences
The engine, the models, and the stream protocol are untouched; auth is strippable by config. Local development (--auth none, npm start) behaves exactly as before, and every package's no-auth test path still passes unchanged.

Stateless sessions mean no session store and nothing to replicate, but no per-token revocation: a leaked token lives until expiry unless the signing secret is rotated (global sign-out).

The namespace catalog stream stays shared: any signed-in user can read workspace names and append catalog events. Content isolation is per workspace stream only — acceptable for a small-team deployment; a per-user catalog projection is the escalation path if name leakage or catalog vandalism ever matters.

The ledger is one JSON file owned by one server process (the same single-writer trust the mirror manifest uses). A multi-node deployment would move it behind the read-model database; the McpAuth seam and gateway checks would not change shape.

TLS stays a fronting-proxy concern. The server warns at boot when bound non-loopback with auth off, and when auth is on but the public URL is plain http (bearer tokens would cross the network unencrypted).

## Relations
_None._
