# ADR: Design decisions live in the wiki

**Status:** accepted

## Metadata
- **Date:** 2026-06-05
- **Scope:** wiki-models
- **Deciders:** Ben Jordan

## Context
For its first weeks this system recorded its own architecture decisions the conventional way: an ADR appendix pinned to the bottom of each package's DESIGN.md. That form has no status or lifecycle, no link from a decision to the one that revises it, and identity that is only per-file — wiki-mcp and wiki-models each shipped a different "ADR-M7", a collision a single namespace makes impossible. There was no way to ask which decisions touch the read model, or to follow a decision's consequences.

## Decision
Adopt a decision-record (ADR) page type and gather every existing ADR under a Decision Records section of this repository's own wiki workspace — alongside its Architecture and Feature Specs, since a workspace maps to a repo/product and is the single consistency aggregate. A decision becomes a typed, FSM-governed wiki page — Context, Decision, Consequences, plus date, scope, deciders, and the preserved legacy label — that moves through proposed to accepted and then, if revised, to superseded or deprecated. Supersession is an integrity-checked reference: a decision may enter superseded only once it names a live successor, so the decision graph cannot silently rot. The engine and host stay schema-agnostic; the ADR type ships as one more runtime-loaded wiki-models bundle.

This record is itself the proof: it was authored in the wiki, not migrated from a DESIGN.md appendix — which is why, alone among the records here, it carries no legacy id.

## Consequences
Design decisions are now searchable, cross-linked, and governed objects inside the very system they govern. Deterministic render keeps a future docs/adr snapshot churn-free (a separate Markdown-projection feature). The DESIGN.md appendices are retired only once that snapshot lands, so there is never a window with two sources of truth — nor one with none.

## Relations
_None._
