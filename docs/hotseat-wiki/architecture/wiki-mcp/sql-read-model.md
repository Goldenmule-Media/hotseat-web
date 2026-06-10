# SQL read model

**Status:** current

## Kind
subsystem

## Summary
A durable Kysely-over-Postgres read model (PGlite in-process locally, node-postgres in prod) that materializes folded workspace state into relational tables and implements the engine's `IReadModel` consistency seam.

## Purpose
Serves the bulk of agent traffic (reads) from a queryable, restart-survivable cache instead of re-folding event history per call, and provides the `appliedToken` / `waitFor` contract that converts eventual consistency into read-your-writes.

## Design notes
_No design notes._

## Components
_No components._

## Dependencies
- **implements** → [CQRS read-model seam](architecture:mpzoiul5-004t-1l21pa) — Implements `IReadModel` over the SAME token codec, so read-your-writes works against SQL.

## Code references
- class `SqlReadModel` in `wiki-mcp/src/readmodel/readmodel.ts`
- interface `ReadModelDatabase` in `wiki-mcp/src/readmodel/schema.ts`
- class `PGliteDialect` in `wiki-mcp/src/readmodel/pglite-dialect.ts`

## Data model
Owns 10 tables: `workspaces`, `pages` (content is a `sections` JSONB column, not a separate table), `tree_edges`, `links`, `events`, `projection_offsets` (the single source of truth for applied position + resume cursor + fingerprint), plus derived `outline`, `symbol_index`, `reference_index`, `xref_index`.

## Usage
Built once at startup by `openStore` + `new SqlReadModel`; the projection tailer writes its rows and calls `notifyApplied` / `halt`, while MCP read tools call its typed query methods (`getPage`, `listPages`, `treeEdges`, `outline`, `symbols`, `references`) after `waitFor`.

## Invariants & constraints
- `appliedToken` is encoded with the engine's PUBLIC token codec (`encodeToken`), so it is directly comparable to a write's token; an unknown workspace is the zero token.
- `waitFor(token)` resolves only once `projection_offsets.applied_version >= token.version`; it rejects with `ConsistencyTimeoutError` after the timeout and re-throws a halt cause non-retryably for a halted workspace.
- SQL never feeds command validation — it is a rebuildable cache, so its failure degrades reads but cannot corrupt the write model; the PGlite dialect reuses the Postgres adapter/compiler so SQL is identical across PGlite and pg.

## Synced commit
e357aa7
