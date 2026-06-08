# ADR-13: CQRS with consistency tokens in the engine core

**Status:** accepted

## Metadata
- **Date:** 2026-06-02
- **Scope:** wiki-mcp

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
The engine's read and write surfaces change on both sides: every write return becomes Committed<T> (including the eight structural commands that previously returned Promise<void>); and the engine's single in-memory projection splits into a write-side decide-aggregate plus a separate IReadModel, with the handle's currently synchronous, token-free reads (tree/page/toMarkdown) becoming token-aware (and likely async). A public pure fold must also be exported. Writes never block on projection; reads convert "eventual" to "after my write" on demand.

## Relations
_None._
