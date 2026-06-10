# architecture

**Status:** current

## Kind
component

## Summary
One node in a typed graph describing the codebase — documents a single unit (module / component / subsystem / service / layer / package, set by `kind`) with summary, purpose, usage, data model, code references, dependencies, and invariants. (This page is itself an `architecture` node.)

## Purpose
Lets an agent maintain living architecture docs as guarded mutations, linking to code (file + symbol) and to other architecture nodes (typed dependency edges), with freshness recorded as an agent fact rather than an engine-faked flag.

## Design notes
_No design notes._

## Components
_No components._

## Dependencies
_No dependencies._

## Code references
- constant `Architecture` in `wiki-models/src/architecture/architecture.ts`

## Data model
`list` elements `codeRef` (scalar `file` / `symbol`, `kind` enum-validated to CODEREF_KINDS), `dependency` (`ref` `target` with `targetKinds: ["page"]`, `role` enum ROLES, prose `note`), and `invariant` (prose `statement`); the `summary.kind` scalar is enum-validated to KINDS. Declares `derived: { "code-reference-rows", "dependency-rows" }` (pure formatters). No element FSMs, no `computed`.

## Usage
**Lifecycle:** `current → stale` (`markStale`) and `stale → current` (`markCurrent`) — born `current`, no draft. Sections: `summary` (+ `kind`), `purpose`, `usage`, `dataModel`, `codeReferences`, `dependencies`, `invariants`, `sync`. Representative commands: `setKind` / `setSummary`, `addCodeRef`, `addDependency`, `addInvariant`, `recordSync`, and `markStale` / `markCurrent`.

## Invariants & constraints
- `addDependency` enforces (in `produces`) that the target is an existing, OTHER `architecture` page — rejecting self-edges and wrong-type targets; the `ref` is integrity-checked at WRITE time only.
- A dependency target archived later is NOT re-checked: it keeps rendering with an "(archived)" marker; ref labels are render-derived so renames reflow.
- The `kind` / `role` / codeRef-`kind` enums are declared on the FIELDs (via `schema: zodSchema(z.enum(…))`) so the engine enforces them on every path incl. auto-generated structural commands; `addCodeRef` also refines that `kind` requires a `symbol`, and code refs carry NO line numbers.

## Synced commit
e357aa7
