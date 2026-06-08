# ADR-6: Closed field-kinds, including the `blocks` document model

**Status:** accepted

## Metadata
- **Date:** 2026-06-03
- **Scope:** wiki

## Context
Sections need a way to say how each field is shaped, validated, and rendered without
the engine learning each type's meaning (the schema-agnostic line). And the standing "no free-form
rich text" tenet needed a positive answer for genuinely document-shaped content — prose with
emphasis, inline code, links, tables — that does not reintroduce an opaque Markdown/HTML blob.

## Decision
Field values are typed by a closed, engine-owned field-kind vocabulary:
scalar | prose | code | attachment-ref | ref | blocks | list.
Which kinds a type uses is model data;
the set is fixed so the one reducer and the render read model handle any field generically.
blocks is the document field-kind: an ordered, heterogeneous sequence of typed,
id-bearing block nodes (paragraph/heading/code/list/table/quote/divider) with inline runs
(text+marks / code-span / ref), marks carried ProseMirror-style (a canonical-sorted set on a
text run, not nesting nodes — so strong(em x) and em(strong x) can't fold differently). A code
block is a code field with a blockId (same payload + machinery, no second code path).

This is structured rich text, not free-form. Every node has a closed tag and an id; the only
string leaves are text runs and code source; a text run carrying Markdown syntax is rejected
at ingestion and reified as a code-span, a mark, or a ref. There is no
html/raw/markdown block, ever, and no block/inline zoo — a new kind requires a decision record proving
closed render, stable-id addressability, and no opaque leaf.

## Consequences
The IField union and exported types gain the seven kinds; ingestion
grammar validation lives in core/contracts.ts. Blocks reuse the list operations and
every determinism rule. spliceInline, nested-block list items, and block embed are
deferred.

## Relations
_None._
