# Structure & invariants

**Status:** current

## Kind
subsystem

## Summary
The structural-command handlers (`createPage`, `reparent`, `reorder`, `setPageTitle`, `archivePage`, `link` / `unlink`, `moveItem`, `archiveWorkspace`) plus the workspace-graph integrity rules and intra-page section-tree mechanics. Each handler is a pure `(state, args, services, registry) → { events, result }`.

## Purpose
Enforces tree/graph integrity (acyclic page tree, parent/page exists, unique sibling title, link target exists, pinned-child protection) and cross-page atomicity (e.g. `moveItem` as one `removeElement` + `addElement` in a single commit) — the payoff of one stream = one aggregate.

## Components
_No components._

## Dependencies
- **depends-on** → [Section-operation reducer & fold](architecture:mpzoiq0g-004l-dunnzt) — Its emitted events are applied by `applyWorkspace`.

## Code references
- constant `STRUCTURAL_HANDLERS` in `wiki/src/core/structure.ts`
- function `moveSectionByKey` in `wiki/src/core/section-structure.ts`
- function `validatePage` in `wiki/src/core/ingestion.ts`

## Data model
Reads/derives `IWorkspaceState.children` (the ordered page tree, keyed by `PageId | ROOT`), `links`, and `pages`; section-tree helpers maintain `ISection.parentId` / `order` under unique-sibling-key and acyclic invariants.

## Usage
The command bus dispatches `runStructural` through `STRUCTURAL_HANDLERS[name]`; the reducer's `applyWorkspace` and the `section-structure.ts` helpers apply the resulting events; handlers re-run on every OCC rebase, so invariants re-check against fresh state.

## Invariants & constraints
- `reparent` rejects making a page its own descendant (`CycleError`); unique sibling title among page children (`DuplicateTitleError`) and unique sibling key among sections (`DuplicateSectionKeyError`).
- Both link endpoints must exist (`LinkTargetNotFoundError`); a missing page/parent is `PageNotFoundError` / `ParentNotFoundError`.
- Pinned (required-child) pages can't be reparented out of their owner or archived alone (`InvariantViolationError`); `createPage` emits the page + its `requiredChildren` recursively as pinned in one atomic commit.

## Synced commit
e357aa7
