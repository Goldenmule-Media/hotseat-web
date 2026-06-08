# ADR-5: Sections are the one content container

**Status:** accepted

## Metadata
- **Date:** 2026-06-03
- **Scope:** wiki

## Context
The original model split a page's content into a fields record (typed scalars/prose)
and an items map of typed sub-entities (the pre-redesign IPageNode.fields and IPageNode.items).
Two containers, each with bespoke per-type shape, render code, and reducers. There was no addressable,
contract-bearing structural unit between "the whole page" and "one item," and the document's shape
was implied by each type's hand-written render.

## Decision
A page's content is a tree of typed Sections — the one content container.
IPageNode.fields/items are replaced by IPageNode.sections: ISection[]. A section is the addressable
(stable key + engine-minted id), contract-bearing, write-gated, meta-bearing unit; it may nest
(heading hierarchies). A section has typed fields (by field-kind) and may carry a typed meta bag.
Sub-entities ("items") live inside a list field as elements and keep their model FSMs; blocks are the
document field-kind. The tree-vs-block rule: use a (sub-)section when a unit needs a stable key, a
contract, a write-gate, meta, or to be a command target / outline entry; use a block otherwise.

## Consequences
Engine state, the entity catalog, composition, and the worked example are
reframed on sections. Two tree levels coexist (workspace page tree + intra-page section tree), the
latter inheriting the workspace's OCC/aggregate guarantees with no new stream or consistency
boundary. The defineItemType free-standing registration is retired in favor of inline elements via
declarative authoring. Greenfield — no fields/items migration.

## Relations
_None._
