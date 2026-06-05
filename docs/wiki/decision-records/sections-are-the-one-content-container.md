# ADR: Sections are the one content container

**Status:** accepted

## Metadata
- **Date:** 2026-06-03
- **Scope:** wiki
- **Legacy ID:** wiki/ADR-004

## Context
The original model split a page's content into a `fields` record (typed scalars/prose)
and an `items` map of typed sub-entities (`IPageNode.fields` / `IPageNode.items`, §6.2 pre-redesign).
Two containers, each with bespoke per-type shape, render code, and reducers. There was no addressable,
contract-bearing structural unit *between* "the whole page" and "one item," and the document's shape
was implied by each type's hand-written render.

## Decision
A page's content is a tree of typed Sections — the one content container
(structured-content §2). IPageNode.fields/items are replaced by
IPageNode.sections: ISection[]. A section is the addressable (stable key + engine-minted id),
contract-bearing (§6 there), write-gated, meta-bearing unit; it may nest (heading hierarchies). A
section has typed fields (by field-kind, ADR-005) and may carry a typed meta bag.
Sub-entities ("items") live inside a list field as elements and keep their model FSMs; blocks
are the document field-kind (ADR-005). The tree-vs-block rule: use a (sub-)section when a unit needs
a stable key, a contract, a write-gate, meta, or to be a command target / outline entry; use a block
otherwise.

## Consequences
Engine state, the §6 entity catalog, §6.5 composition, and the worked example are
reframed on sections. Two tree levels coexist (workspace page tree + intra-page section tree), the
latter inheriting the workspace's OCC/aggregate guarantees with no new stream or consistency
boundary. The defineItemType free-standing registration is retired in favor of inline elements
(ADR-007's declarative authoring). Greenfield — no fields/items migration (ADR-010).

## Relations
_None._
