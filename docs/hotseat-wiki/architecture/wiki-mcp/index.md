# wiki-mcp

**Status:** current

## Kind
package

## Summary
The **long-lived host**: embeds the `wiki` engine (write side — a hot LRU of workspace handles), maintains a **durable SQL read model** (Kysely → PGlite local / pg prod) fed by a **projection tailer**, owns the live **ModelRegistry** (runtime page-type loading / hot-reload, ADR-M6), and exposes everything over **MCP** (tools + resources). Imports `wiki`'s public surface only.

## Purpose
Turn the embeddable engine into a durable, queryable, agent-facing service. It supplies the external `IReadModel` over the engine's read seam (so token-gated read-your-writes works against SQL, not just the in-memory projection), projects the event log into relational tables for rich reads (tree, outline, symbol / reference / xref indexes), and surfaces an LLM tool + resource API: `createWorkspace`, `createPage`, `mutatePage`, `describeMutations`, `getPage`, `tree`, `renderPage`, `search`, `link`, …

## Design notes
_None._

## Components
- [SQL read model](architecture:mpzoix0f-004x-dlxbrw)
- [Projection tailer](architecture:mpzoiy4k-004z-xrbx5a)
- [MCP server surface](architecture:mpzoizbf-0051-gizqv1)
- [Model & language registries](architecture:mpzoj0as-0053-pq87xf)

## Dependencies
- **depends-on** → [wiki](architecture:mpznj2kb-0009-pvqw9d) — Embeds the engine; imports wiki's PUBLIC surface only (createWiki, foldWorkspace, the registry, the consistency-token codec).

## Code references
- `wiki-mcp/src/engine.ts`
- interface `ReadModelDatabase` in `wiki-mcp/src/readmodel/schema.ts`
- `wiki-mcp/src/readmodel/readmodel.ts`
- `wiki-mcp/src/readmodel/project.ts`
- `wiki-mcp/src/tail/projection.ts`
- `wiki-mcp/src/mcp/tools.ts`
- `wiki-mcp/src/mcp/resources.ts`
- `wiki-mcp/src/models/registry.ts`

## Data model
A relational projection of `IWorkspaceState` — **one schema for every page type**, with type-specific content in JSONB. Kysely tables: `workspaces`; `pages` (the typed section tree as a `sections` JSONB column); `tree_edges` (ordered children, `@root` sentinel); `links`; `events` (the queryable log); plus projection indexes `outline`, `symbol_index`, `reference_index`, `xref_index`. The applied read position is the single source of truth in `projection_offsets(applied_version, cursor, fingerprint)` — `waitFor({ws, version})` resolves once `applied_version >= version`; a `fingerprint` change (page-type set / schema version) triggers a rebuild.

## Usage
Compiled and run as Node (built with `tsdown`; relative imports use `.js` extensions). Embeds the engine and provides a SQL `IReadModel` over the same `waitFor` / `appliedToken` seam. Configured via `WIKI_MCP_*` env: namespace, `WIKI_MCP_DB` = `pglite` | `pg`, `WIKI_MCP_PG_URL`, data-dir. Not run standalone in this repo — it is **hosted in-process by wiki-server**, which overrides its stream URL to the co-hosted Durable Streams host and exposes the MCP endpoint at `:4439/mcp`.

## Invariants & constraints
- Imports `wiki`'s PUBLIC surface only — never engine internals (the command bus, EventLog, and structure/render modules are not exported).
- The SQL read model implements the engine's `IReadModel` seam and encodes/decodes the SAME opaque `{ workspaceId, version }` consistency token the engine's writes return, so read-your-writes works across the SQL projection.
- One read-model schema serves every page type; type-specific data lives in JSONB (`fields` / `items` / event `payload`), queried with Postgres JSON operators.
- `projection_offsets.applied_version` is the single source of truth for the read-side position — never stored on `workspaces`.
- Owns the live ModelRegistry: page types are loaded / reloaded at runtime (ADR-M6); a `fingerprint` change rebuilds the projection.
- Compiled and run as Node: relative imports MUST use `.js` extensions (unlike the source-consumed `wiki` / `wiki-models`).

## Synced commit
e357aa7
