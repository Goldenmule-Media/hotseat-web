# Section-operation reducer & fold

**Status:** current

## Kind
subsystem

## Summary
The single engine-owned reducer. `applyOps` folds an ordered `SectionOp[]` (the closed vocabulary: `setField` / `applyTextEdits` / `add|remove|move|setElementField` / `add|remove|move|renameSection` / block ops + `setMeta` / `transition`) into a page's section tree; `foldWorkspace` / `applyWorkspace` rebuild `IWorkspaceState` from events, upcasting content payloads to the page type's current schema version first.

## Purpose
Replaces all per-type, author-written reducers with one total, pure fold over a closed operation vocabulary — a single audit/replay path, one upcasting target per op kind, and a reducer the engine (not the model) owns.

## Components
_No components._

## Dependencies
- **depends-on** → [Page-type authoring & registry](architecture:mpzoithh-004r-hd8cmg) — Resolves field-kinds, element decls, upcasters, and FSM `next`.

## Code references
- function `applyOps` in `wiki/src/core/operations.ts`
- function `foldWorkspace` in `wiki/src/core/workspace.ts`
- type `SectionOp` in `wiki/src/api.ts`

## Data model
Operates over `IWorkspaceState` (pages / children / links / version) and, per content event, a `PageState` view aliasing an `IPageNode`'s `sections` (`ISection` → `IField` → `IItem` / `IBlock`); the one author fold-seam is a bounded, meta-scoped `reduceMeta`.

## Usage
`applyWorkspace` is called by the bus (absorb, rebase, dry-run via `applyOps`), by the handle's live tail, and by external read models; `foldWorkspace` backs `openWorkspace` and is exported publicly (`wiki/registry`) for external projections.

## Invariants & constraints
- Total and pure — no clock/RNG; `now` and any ids ride in via the op payload / `ApplyOpsCtx`; equal events fold to equal state.
- `foldWorkspace` asserts `version` contiguity (throws on a gap) but skips events with `version <= fromVersion`, so a coarse-cursor snapshot read stays idempotent.
- Upcasting composes registered `upcasters` from `event.schemaVersion` up to the type's current `version` before the reducer runs; a `schemaVersion` beyond the registered version is a hard `UnknownPageTypeError`.

## Synced commit
e357aa7
