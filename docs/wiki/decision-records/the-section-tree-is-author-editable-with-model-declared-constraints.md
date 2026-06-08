# ADR-10: The section tree is author-editable, with model-declared constraints

**Status:** accepted

## Metadata
- **Date:** 2026-06-03
- **Scope:** wiki

## Context
A fixed per-type layout (the implicit pre-redesign model) can't serve both rigid types
(a `feature-brief` with an exact set of sections) and open types (a design-doc or notebook the author
grows freely). We needed one mechanism spanning both.

## Decision
The section tree is author-editable by default via the closed section-tree
operations (addSection/moveSection/removeSection/renameSection); a page type constrains it
declaratively rather than fixing a layout (structured-content §6):
requiredSections (must exist — auto-materialized empty at PageCreated, the intra-page sibling of
requiredChildren, keyed by stable declared keys, no FSM), the section-set shape (open lets
authors add ad-hoc sections, closed forbids it; plus prohibit/cardinality, SHACL-style), per-field
required/schema (the transition-scoped well-formedness "must be filled" check, distinct from the
always-on "must exist"), mutableIn write-gates, and transition preconditions. These are
model data, validated mechanically in the Registry at load and hot-reloaded via the
ModelRegistry — not a general constraint language (decidable presence/cardinality/type/closed-open
+ simple pure guard predicates only; richer logic stays in pure produces/preconditions; §13
non-goals).

## Consequences
§6 entity catalog (Section row), §7.1 (sections gated by write-gates+contracts, not
an FSM), §9 contracts, and §10.5 (sectionSet, required, mutableIn, preconditions) reflect
this. A feature-brief is effectively closed; an open type grows its tree at runtime.

## Relations
_None._
