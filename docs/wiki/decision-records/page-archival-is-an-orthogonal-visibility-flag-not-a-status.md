# ADR: Page archival is an orthogonal visibility flag, not a status

**Status:** accepted

## Metadata
- **Date:** 2026-06-04
- **Scope:** wiki
- **Legacy ID:** wiki/ADR-011

## Context
The first cut of `archivePage` set `node.status = "archived"`, overwriting the page-type
lifecycle status. That conflated two orthogonal axes — *lifecycle* (a per-type FSM, `draft → … →
shipped`) and *visibility* (should this page appear in default tree/sidebar views?). It destroyed the
prior status (a `shipped` page forgot it shipped), was a one-way door (`"archived"` is in no model's
FSM, so the transition machinery could never leave it), and made the model-inspection FSM graph show a
"current status" that is not a node in that graph.

## Decision
Archival is a first-class, schema-agnostic archived boolean on the page node — a
sibling of pinned, independent of status. PageArchived flips the flag (status is preserved);
a new PageUnarchived event + unarchivePage command clears it, making archival a round-trip. While
archived, both structural and content mutations are blocked — the freeze that was previously implicit
in "no FSM transition leaves archived" is now an explicit guard. archived is surfaced on ITreeNode
and via IRenderCtx.archivedOf(id); reads annotate, never filter — the engine exposes archived
pages so consumers (the SQL read model's tree, the UI sidebar) hide them by policy with an opt-in to
reveal. Archival does not cascade: a page is effectively hidden when it or any ancestor is
archived, computed by readers — so archiving a feature hides its pinned plan/checklist/testing subtree
without mutating those children, and unarchiving restores them exactly.

## Consequences
archivePage is no longer terminal — it is reversible and status-preserving. Models
that surface archived-ness in render read ctx.archivedOf (e.g. the architecture bundle's
"(archived)" dependency marker) instead of comparing statusOf to a magic string. Sort/visibility
policies (e.g. "hide finished pages") live in read models / the UI, not the engine — the engine owns
only the durable visibility fact. Greenfield (ADR-010): no migration for the old status = "archived"
representation.

## Relations
_None._
