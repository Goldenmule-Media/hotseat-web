# ADR: Workspace as the aggregate (one stream)

**Status:** accepted

## Metadata
- **Date:** 2026-06-01
- **Scope:** wiki
- **Legacy ID:** wiki/ADR-002

## Context
First draft used **one stream per page**. Reviewer: that's too granular — we want to
reparent a page within a "workspace" (a graph of pages), and with multiple streams that isn't
atomic. Question raised: *can Durable Streams aggregate streams?*

**Findings.** **No cross-stream transactions** — atomicity is per-stream (servers commit producer
state + append atomically; a writer can append-and-close atomically). A **single POST of a JSON
array is an atomic multi-event append.** Conditional append is native (`PreconditionFailedError`).
The StreamFS precedent uses a *hybrid* (structure stream + per-file content streams), which makes
*structural* ops atomic but **not cross-page content** ops.

**Requirements gathered.** Atomic operations needed: structural (reparent/reorder/link) **and**
cross-page **content** moves (e.g. move an open question onto a page's implementation plan). Scale: *gentle* multi-writer (~5
concurrent writers, mostly different pages); a key desired benefit is **one stream everyone tails
for all updates**.

## Decision
The workspace is the aggregate = one Durable Stream; pages are entities
within it (tree + typed links). A command's events are written as one atomic batch. The hybrid
was rejected because it can't make cross-page content moves atomic and would force readers to
tail many streams.

Tradeoff (explicit). A coarser aggregate trades intra-workspace write parallelism for
cross-page atomicity and single-tail reads. At the target scale this is a clear win;
concurrency is handled by in-process per-workspace serialization + optimistic concurrency with
rebase-and-retry — no actor/routing system.

## Consequences
Snapshots recommended as the stream grows (§8.3); version is
per-workspace; cross-workspace moves are a non-atomic saga (a non-goal). Escape hatch if a
workspace gets write-hot: single epoch-fenced owner, split the workspace, or adopt the StreamFS
hybrid.

## Relations
_None._
