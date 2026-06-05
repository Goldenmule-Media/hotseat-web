# Command bus

**Status:** current

## Kind
subsystem

## Summary
The engine's write-path pipeline. One `CommandBus` per open workspace runs the pure `validate → guard (FSM + per-op write-gate + preconditions) → build-context → decide → commit` sequence for both structural and page-scoped commands, then performs the single I/O step: an atomic append.

## Purpose
Centralizes all write legality (FSM transitions, `mutableIn` write-gates, content-hash edit preconditions, well-formedness dry-run) and makes every write atomic and OCC-safe via rebase-and-retry — so no per-type code ever touches storage or concurrency.

## Components
_No components._

## Dependencies
- **depends-on** → [Event log & storage adapter](architecture:mpzoioif-004j-c1rzal) — Calls `append` / `read` for the single I/O step.
- **depends-on** → [FSM guard](architecture:mpzoir7n-004n-5uignj) — Calls `guard.can(…)` to gate every transition.
- **depends-on** → [Structure & invariants](architecture:mpzoisan-004p-kwfmy3) — Dispatches structural commands through `STRUCTURAL_HANDLERS`.
- **calls** → [Section-operation reducer & fold](architecture:mpzoiq0g-004l-dunnzt) — Folds via `applyWorkspace` for absorb, rebase, and the well-formedness dry-run.
- **depends-on** → [CQRS read-model seam](architecture:mpzoiul5-004t-1l21pa) — Mints the committed-head token and notifies the read model.

## Code references
- class `CommandBus` in `wiki/src/core/command-bus.ts`
- interface `CommitOutcome` in `wiki/src/core/command-bus.ts`
- function `createWiki` in `wiki/src/core/wiki.ts`

## Data model
Operates on a `BusProjection` (folded `IWorkspaceState` + the in-memory `IEventEnvelope[]` + the DS cursor + snapshot bookkeeping + the subscriber set); decisions emit lightweight `DomainEvent`s carrying `SectionOp[]` payloads.

## Usage
`WorkspaceHandle` (`core/wiki.ts`) calls `bus.runStructural(…)` / `bus.runPage(…)` under a per-workspace mutex and wraps the returned `CommitOutcome` (result + committed-head version) into a `Committed<T>`.

## Invariants & constraints
- Everything before `commit` is pure — no host clock/RNG; time and ids enter only via injected services (`now()` / `newId()`).
- The append asserts `expectedVersion = state.version`; a stale append (409) triggers a rebase, then re-runs `decide` against fresh state, bounded by `MAX_REBASE_ATTEMPTS` (5) → `ConcurrencyError`.
- A `commandId` already present in history short-circuits before guard/decide (idempotent replay), returning the current head token; per-op write-gating uses each target section's `mutableIn`.

## Synced commit
e357aa7
