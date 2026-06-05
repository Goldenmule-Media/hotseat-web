# ADR: Closed field-kinds, including the `blocks` document model

**Status:** accepted

## Metadata
- **Date:** 2026-06-03
- **Scope:** wiki
- **Legacy ID:** wiki/ADR-005

## Context
Sections need a way to say *how* each field is shaped, validated, and rendered without
the engine learning each type's *meaning* (the schema-agnostic line). And the standing "no free-form
rich text" tenet (§2) needed a positive answer for genuinely document-shaped content — prose with
emphasis, inline code, links, tables — that does not reintroduce an opaque Markdown/HTML blob.

## Decision
Field values are typed by a closed, engine-owned field-kind vocabulary:
scalar | prose | code | attachment-ref | ref | blocks | list
(structured-content §3). Which kinds a type uses is model data;
the set is fixed so the one reducer and the render read model handle any field generically.
blocks is the document field-kind (§3.1 there): an ordered, heterogeneous sequence of typed,
id-bearing block nodes (paragraph/heading/code/list/table/quote/divider) with inline runs
(text+marks / code-span / ref), marks carried ProseMirror-style (a canonical-sorted set on a
text run, not nesting nodes — so strong(em x) and em(strong x) can't fold differently). A code
block is a code field with a blockId (same payload + machinery, no second code path).

This is structured rich text, not free-form. Every node has a closed tag and an id; the only
string leaves are text runs and code source; a text run carrying Markdown syntax is rejected
at ingestion (§7 there) and reified as a code-span, a mark, or a ref. There is no
html/raw/markdown block, ever, and no block/inline zoo — a new kind requires an ADR proving
closed render, stable-id addressability, and no opaque leaf.

## Consequences
The §6.2 IField union and §10.6 exported types gain the seven kinds; ingestion
grammar validation (§7 there) lives in core/contracts.ts. Blocks reuse the list operations and
every determinism rule (ADR-008). spliceInline, nested-block list items, and block embed are
deferred (structured-content §12/§13).

## Relations
_None._
