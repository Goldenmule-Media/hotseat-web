# ADR-7: Generic section operations + one engine-owned reducer (no per-type events/reducers/renderers)

**Status:** accepted

## Metadata
- **Date:** 2026-06-03
- **Scope:** wiki

## Context
Pre-redesign, each page/item type authored its own **events** (`QuestionAnswered`,
`ConstraintAdded`, …), a per-type **`apply` reducer**, and a per-type **`render`** — three pieces of
imperative model code the engine folded and dispatched per type (§10.5 pre-redesign). That made the
fold's surface per-type-unbounded, coupled history to each type's event shapes, and put canonical
content under model-written reducers the tooling then had to trust.

## Decision
Content mutates only through a closed, engine-owned section-operation
vocabulary — setField, addSection/removeSection/moveSection/renameSection,
addBlock/removeBlock/moveBlock/setBlock, addElement/removeElement/moveElement/
setElementField, applyTextEdits, setMeta, transition
(structured-content §9.4) — folded by one built-in reducer
(§8.1.1). There are no per-type events, no author-written content reducers, and no author-written
renderers. Content events are generic (they carry the operation); the originating command
name lives in event metadata, so history() stays semantic (answerQuestion) without per-type
events. The only sanctioned model fold-extension is a bounded, pure, meta-scoped reduceMeta
(structured-content §9.5) that may write only a section's meta bag — never canonical content, the
section tree, or status.

## Consequences
§4 vocabulary, §6.1, §7.3, §8.1/§8.1.1/§8.2, and §16 are reframed: workspace.ts
routes, core/section-reducer.ts is the one content reducer, and the per-type apply/render
disappear from IPageTypeDef. Upcasting reshapes operation payloads (ADR-008). moveItem becomes
a removeElement+addElement pair in one append. The canonical content the tooling depends on stays
engine-folded and uniformly legible.

## Relations
_None._
