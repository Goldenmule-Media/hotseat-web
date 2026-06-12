# MCP server surface

**Status:** current

## Kind
subsystem

## Summary
The agent-facing MCP server built on the SDK's low-level `Server`, exposing the engine command catalog and read-model queries as tools plus `wiki://` resources, with automatic per-session token management that plugs the two CQRS planes together.

## Purpose
Turns the engine into agent-callable tools / resources and threads consistency tokens automatically, so an agent always reads its own prior writes without managing tokens, while distinct sessions stay independent.

## Design notes
Host-injected auth (HTTP transport only): an optional McpAuth gates every request — 401 without a valid bearer, per-user workspace access checks on every tool, and ownership attribution on createWorkspace. An optional authDiscovery on the transport makes that 401 advertise an OAuth resource_metadata URL and serves a host-authored protected-resource document at /.well-known/oauth-protected-resource on the MCP listener, so an MCP client can bootstrap its login from the 401 alone. Both are opaque host-supplied values: this package stays auth-mechanism-agnostic and learns no OAuth concepts — wiki-server authors them from its gateway config.

## Components
_No components._

## Dependencies
- **depends-on** → [SQL read model](architecture:mpzoix0f-004x-dlxbrw) — Serves reads from it after `waitFor`.
- **depends-on** → [Projection tailer](architecture:mpzoiy4k-004z-xrbx5a) — Triggers `onWrite` → `notify` after each write tool.
- **depends-on** → [Model & language registries](architecture:mpzoj0as-0053-pq87xf) — Uses the LanguageRegistry for `renameSymbol` edits.

## Code references
- class `WikiMcpServer` in `wiki-mcp/src/mcp/server.ts`
- function `wikiTools` in `wiki-mcp/src/mcp/tools.ts`
- class `SessionTokenManager` in `wiki-mcp/src/mcp/tokens.ts`
- interface `McpAuth` in `wiki-mcp/src/mcp/auth.ts`

## Data model
Owns a `SessionTokenManager` (per-session high-water `{workspaceId→version}` marks), a `WikiTool` catalog, and a live HTTP session map. Write tools: `createWorkspace` / `createPage` / `reparent` / `setPageTitle` / `archivePage` / `link` / `unlink` / `mutatePage` / `renameSymbol`. Read tools: `describeMutations` / `getPage` / `tree` / `renderPage` / `search` / `openQuestions` / `outline` / `symbols` / `references`. Resources: `wiki://{ns}/workspace/{id}` and `wiki://{ns}/page/{wsId}/{pageId}`.

## Usage
Constructed by `createWikiMcp` and started over stdio (one ambient session) or streamable HTTP (per-session transports, used by `wiki-server`). Write tools record the returned token via `SessionTokenManager.recordWrite` and trigger `onWrite` → `projection.notify`; read tools call `awaitConsistency` (passing the session high-water token) before serving.

## Invariants & constraints
- Tool input schemas are the engine's RAW JSON Schema (page mutations via `describeMutations`'s `argsSchema`), advertised verbatim — which is why the low-level `Server` (not the Zod-based `McpServer`) is used.
- A single-workspace read waits on that workspace's high-water token; a cross-workspace read (`search`, `openQuestions`) fans out and waits on every workspace the session has written (tokens compare within a workspace only).
- The full catalog is always exposed; the engine's guard rejects illegal calls and a `WikiError` maps to a structured tool result (`isError: true`) with a stable `code` the agent self-corrects on. A session is the unit of consistency — a close drops its high-water marks.

## Synced commit
d5bdd9b
