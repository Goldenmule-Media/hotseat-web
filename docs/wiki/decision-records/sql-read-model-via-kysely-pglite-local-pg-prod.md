# ADR-14: SQL read model via Kysely; PGlite local, pg prod

**Status:** accepted

## Metadata
- **Date:** 2026-06-02
- **Scope:** wiki-mcp

## Context
_None._

## Decision
Materialize the read model in Postgres via Kysely, on PGlite locally and pg in
production — identical Postgres SQL both places. Schema is core relational tables + JSONB for the
engine's pluggable type-specific data, so one schema serves all page types with no per-type code. With the
section model (structured-content §2/§3) the core tables are the section
tree (sections(pageid, parentid, key, ord, fields JSONB, meta JSONB)), with list elements and
blocks/inline trees living inside field JSONB — not a separate flat fields/items pair (§5.2).

Why. Type-safe queries, dev/prod parity with zero local infra (embedded PGlite), and it completes the
ElectricSQL stack (Durable Streams + PGlite). JSONB keeps the schema type-agnostic while staying
queryable; typed per-type tables remain an opt-in optimization (§5.2).

## Consequences
The read model is a rebuildable cache (drop + re-fold from the stream); a fingerprint
guards schema/page-type drift; Kysely migrations manage the schema.

## Relations
_None._
