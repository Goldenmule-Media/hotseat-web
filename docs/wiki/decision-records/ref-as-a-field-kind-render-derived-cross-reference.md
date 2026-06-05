# ADR: `ref` as a field-kind (render-derived cross-reference)

**Status:** accepted

## Metadata
- **Date:** 2026-06-03
- **Scope:** wiki
- **Legacy ID:** wiki/ADR-008

## Context
Cross-references inside content (to a section, another page, a code symbol, or a block)
were previously either workspace **links** (page→page only, not intra-content) or inline text the
author hand-typed and had to keep in sync on every reorder/rename/renumber. Neither gives an
integrity-checked reference *inside a sentence* whose label updates automatically.

## Decision
ref is a first-class field-kind (and an inline-run kind) whose value is a typed
target (section | page | symbol | block) and whose displayed label is render-derived — the
section number, page title, or symbol name, computed by the render read model
(structured-content §3, §3.2). Integrity (target exists) is enforced
like link integrity, and the §7-there integrity walk recurses into block/inline trees so an
inline reference can never dangle undetected. It complements, not replaces, page→page links (which
stay the non-hierarchical graph edge).

## Consequences
The IField union and the inline vocabulary gain ref/RefTarget; the §6.2
invariants and the well-formedness check gain ref-target resolution. Because the label is a
projection, reorders/renames/renumbers update every reference deterministically with no stored-label
drift.

## Relations
_None._
