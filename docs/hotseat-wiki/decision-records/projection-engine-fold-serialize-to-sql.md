# ADR-15: Projection = engine-fold + serialize-to-SQL

**Status:** accepted

## Metadata
- **Date:** 2026-06-02
- **Scope:** wiki-mcp

## Context
_No context yet._

## Decision
The projection applies each commit by folding it with the engine's reducer to an
IWorkspaceState, then serializing that state into SQL — rather than writing bespoke per-event SQL
handlers. The applied version advances in the same transaction as the rows. This requires the engine
to export a public, pure fold (today the workspace fold and apply helpers are internal); that export is part of the coordinated engine changes.

Why. Reusing the fold guarantees the read model matches write-model semantics exactly (upcasting,
unknown-type policy, item/FSM effects) — the only thing we own is the state-to-rows mapping, which is
mechanical. Atomic apply keeps appliedToken honest. The cost (holding a fold to serialize) coincides with
keeping workspaces hydratable anyway.

## Consequences
Per-type rich query tables, when wanted, are derived from the same serialized state by
opt-in projectors; the base layer needs no per-type code. The derived projections (outline · symbol
index · cross-reference index) are derived from the same folded state in the same per-commit
transaction — engine-defined and language-defined respectively, but all read-side, none folded by wiki.

## Relations
_None._
