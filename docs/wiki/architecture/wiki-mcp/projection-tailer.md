# Projection tailer

**Status:** current

## Kind
subsystem

## Summary
An event-driven service that discovers workspaces and projects each commit into SQL by folding the full event history with the engine's public `foldWorkspace` and serializing the resulting `IWorkspaceState` to rows in one transaction (ADR-M3).

## Purpose
Keeps the SQL read model and its derived indexes current off the engine's live tail without re-folding from zero on restart, and advances `appliedToken` atomically so a `waitFor` that sees base rows also sees the derived indexes.

## Components
_No components._

## Dependencies
- **depends-on** → [Section-operation reducer & fold](architecture:mpzoiq0g-004l-dunnzt) — Projects by folding full history via the engine's public `foldWorkspace`.
- **depends-on** → [SQL read model](architecture:mpzoix0f-004x-dlxbrw) — Writes every projected table + the applied offset in one transaction.

## Code references
- class `ProjectionService` in `wiki-mcp/src/tail/projection.ts`
- function `applyCommit` in `wiki-mcp/src/readmodel/project.ts`
- function `engineEventSource` in `wiki-mcp/src/tail/engine-source.ts`

## Data model
Operates the `Commit` shape (`{workspaceId, events, cursor}`) and writes every projected table; reads/writes `projection_offsets` for the resume cursor and idempotency (skips events with head `version <= applied_version`). Builds base rows plus the derived `outline` / `symbol_index` / `reference_index` / `xref_index` rows from folded state.

## Usage
Constructed in `createWikiMcp`, started via `ProjectionService.start(source)` over an `engineEventSource`; fed by three signals — per-workspace `subscribe` (external writes), the host's `notify(workspace)` after each local write tool, and a low-frequency catalog discovery poll. `rebind` + `reproject` rebuild on model hot-reload.

## Invariants & constraints
- Each commit's row writes AND the new `applied_version` (+ cursor + fingerprint) are written in ONE transaction, so the offset never reports ahead of the data; derived indexes recompute in that same transaction.
- Apply is idempotent and resumable: re-reading full history is safe because events at or below `applied_version` are skipped.
- An unfoldable event (`UnknownPageTypeError`) HALTS that workspace's projection (and rejects its `waitFor`s) rather than corrupting SQL; both sides use the same engine fold, so the read model can never semantically diverge from the write model.

## Synced commit
e357aa7
