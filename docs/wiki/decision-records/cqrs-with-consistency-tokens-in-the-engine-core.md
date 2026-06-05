# ADR: CQRS with consistency tokens in the engine core

**Status:** accepted

## Metadata
- **Date:** 2026-06-02
- **Scope:** wiki-mcp
- **Legacy ID:** wiki-mcp/ADR-M1

## Context
Reads must be fast and durable without re-folding, yet an agent must be able to read its own
writes. Synchronously writing both stores couples the write path and spans two non-atomic stores.

## Decision
Adopt strict CQRS with eventual consistency as a core engine contract: the write
model (commands → events) and read model (projections) are separate; writes return a ConsistencyToken
(the per-workspace version), and reads optionally take a token and waitFor read-side catch-up
before serving. The engine ships a default in-memory read model so it is CQRS-correct standalone; external
read models implement the same IReadModel.

## Consequences
wiki/DESIGN.md §8/§10 change on both
sides: every write return becomes Committed<T> (including the eight Promise<void> structural
commands, §3.2); and the engine's single in-memory projection (wiki/DESIGN.md §8.4)
splits into a write-side decide-aggregate plus a separate IReadModel, with the handle's currently
synchronous, token-free reads (tree/page/toMarkdown — wiki/DESIGN.md §10.3)
becoming token-aware (and likely async). A public pure fold must also be exported
(ADR-M3). Writes never block on projection;
reads convert "eventual" to "after my write" on demand. This doc states the contract; the engine doc must
own it.

## Relations
_None._
