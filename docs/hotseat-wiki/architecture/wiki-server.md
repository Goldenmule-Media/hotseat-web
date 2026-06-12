# wiki-server

**Status:** current

## Kind
package

## Summary
Thin process **wiring** — implements no engine logic. Runs `@durable-streams/server` (the durable stream host) AND hosts `wiki-mcp` in-process, booting three listeners in one process: the **stream host** (`:4437`), a **control listener** (`:4438` — `/_server/health` | `/info` | `/logs` | `/models`), and the embedded **MCP** streamable-HTTP endpoint (`:4439/mcp`). With `--auth github`, an **auth gateway** takes over the public `:4437` (the stream host moves to an internal loopback port): GitHub OAuth + stateless signed bearer tokens + a per-workspace access ledger, plus an **OAuth 2.1 authorization-server façade** so MCP clients and CLIs obtain and refresh tokens themselves — no copied credentials.

## Purpose
Be the single runnable process that stands up storage + read model + MCP for local dev and deployment. It owns process lifecycle and configuration (`flags → env → defaults`), wires the embedded wiki-mcp's stream URL to its own co-hosted Durable Streams host, and loads page-type bundles at boot (`--models` / `--models-dir`) or at runtime via the control listener.

## Design notes
Auth plane (auth github mode): the gateway owns the public port and serves /auth/* locally (the GitHub dance, the membership/claim API) while reverse-proxying ONLY workspace/catalog stream paths behind a signed bearer session — deny-by-default. The stream host hides on an internal loopback port; the control listener becomes loopback-only; the embedded MCP demands the same token via a host-injected McpAuth, so identity is enforced per-surface and never trusted across surfaces. Sessions are stateless HMAC-signed blobs; rotating the session secret is the whole revocation story. A PUT that creates a workspace stream records the caller as its owner — creation is the claim.

OAuth 2.1 façade (auth/oauth.ts is pure logic; gateway.ts routes): RFC 8414/9728 discovery documents at /.well-known/* (public, carved out ahead of the deny-by-default proxy), RFC 7591 dynamic client registration (the client id is a signed wsid1 blob carrying its own registration record), /auth/authorize (PKCE S256 required; piggybacks the existing GitHub dance by riding the signed state), and /auth/token (authorization_code and refresh_token grants minting short-lived wsv1 access tokens plus wsr1 refresh tokens whose rotation is capped at the original grant's expiry; the allowlist is re-checked at refresh). Every 401 — gateway and embedded MCP — advertises resource_metadata, so an MCP client bootstraps its whole login from a bare 401. See the ADR: OAuth 2.1 façade over the stateless gateway.

## Components
_No components._

## Dependencies
- **depends-on** → [wiki-mcp](architecture:mpznj4z6-000d-dzkr85) — Hosts wiki-mcp in-process; must NOT import `wiki` directly (only transitively via wiki-mcp).

## Code references
- `wiki-server/src/main.ts`
- `wiki-server/src/control.ts`
- `wiki-server/src/config.ts`
- function `startGateway` in `wiki-server/src/auth/gateway.ts`
- `wiki-server/src/auth/oauth.ts`
- `wiki-server/src/auth/tokens.ts`
- class `AccessStore` in `wiki-server/src/auth/access.ts`

## Data model
Holds no domain state of its own — it composes others': the Durable Streams host owns the append-only event streams (file storage under the data dir), and the embedded wiki-mcp owns the SQL read model. Its own surface is operational: resolved config (`WIKI_SERVER_*`, precedence flags → env → defaults) and the control endpoints (`health` / `info` / `logs` / `models`, the last reporting the loaded bundles + a `generation` counter).

## Usage
`npm run start -w wiki-server` boots all three listeners; file storage defaults to `./.wiki-data`. Loads **no page types by default** — provide them: `--models wiki-models/feature` (or `WIKI_SERVER_MODELS`), or `--models-dir ../wiki-models/src` to load every bundle (id = directory name; `npm start` at the repo root and `start:all` do exactly this). At runtime: `POST /_server/models {id, specifier}` or `GET :4438/_server/models`. Config keys: `WIKI_SERVER_*` (host / port / storage / data-dir / control-port / mcp-port / models / models-dir) plus the resolved embedded `WIKI_MCP_*`. Auth: `--auth github` needs a GitHub OAuth App (`WIKI_SERVER_GITHUB_CLIENT_ID`/`_SECRET`, callback at `{WIKI_SERVER_PUBLIC_URL}/auth/github/callback`); `WIKI_SERVER_AUTH_USERS` allowlists sign-ins; `WIKI_SERVER_ACCESS_TOKEN_TTL_SECONDS` (default 3600) and `WIKI_SERVER_REFRESH_TOKEN_TTL_DAYS` govern OAuth-minted tokens, while the interactive flow keeps `WIKI_SERVER_SESSION_TTL_DAYS`.

## Invariants & constraints
- Thin wiring ONLY: implements no engine logic. Imports `@durable-streams/server` + `wiki-mcp`.
- MUST NOT import `wiki` directly — only transitively via wiki-mcp (a load-bearing import boundary).
- Loads no page types by default; the schema must be provided explicitly (`--models` / `--models-dir` / `WIKI_SERVER_MODELS*`).
- Three listeners in one process: stream host `:4437`, control `:4438`, MCP `:4439/mcp`. Config precedence is flags → env → defaults.
- Overrides the embedded wiki-mcp's stream URL to its own co-hosted Durable Streams host.
- Auth mode is deny-by-default: the gateway proxies ONLY workspace/catalog stream paths; /auth/* and /.well-known/* are served locally; every other path is refused. The MCP namespace may not be "auth" or ".well-known" (it would shadow those routes).
- All credentials are stateless HMAC-signed blobs (wsv1 sessions/access tokens, wst1 state, wsc1 authorization codes, wsr1 refresh tokens, wsid1 client ids) — no session store anywhere; rotating the session secret revokes every family at once.

## Synced commit
d5bdd9b
