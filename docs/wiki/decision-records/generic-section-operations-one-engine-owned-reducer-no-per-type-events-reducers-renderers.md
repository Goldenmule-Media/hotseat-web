# ADR-7: Generic section operations + one engine-owned reducer (no per-type events/reducers/renderers)

**Status:** accepted

## Metadata
- **Date:** 2026-06-03
- **Scope:** wiki

## Context
Pre-redesign, each page/item type authored its own events (QuestionAnswered, ConstraintAdded, ...), a per-type apply reducer, and a per-type render — three pieces of imperative model code the engine folded and dispatched per type. That made the fold's surface per-type-unbounded, coupled history to each type's event shapes, and put canonical content under model-written reducers the tooling then had to trust.

## Decision
Content mutates only through a closed, engine-owned section-operation vocabulary — setField, addSection/removeSection/moveSection/renameSection, addBlock/removeBlock/moveBlock/setBlock, addElement/removeElement/moveElement/setElementField, applyTextEdits, setMeta, transition — folded by one built-in reducer. There are no per-type events, no author-written content reducers, and no author-written renderers. Content events are generic (they carry the operation); the originating command name lives in event metadata, so history() stays semantic (answerQuestion) without per-type events. The only sanctioned model fold-extension is a bounded, pure, meta-scoped reduceMeta that may write only a section's meta bag — never canonical content, the section tree, or status.

## Consequences
Several parts of the design are reframed: workspace.ts routes, core/section-reducer.ts is the one content reducer, and the per-type apply/render disappear from IPageTypeDef. Upcasting reshapes operation payloads. moveItem becomes a removeElement+addElement pair in one append. The canonical content the tooling depends on stays engine-folded and uniformly legible.

## Relations
_None._
