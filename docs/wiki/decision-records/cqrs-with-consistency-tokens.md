# ADR-4: CQRS with consistency tokens

**Status:** accepted

## Metadata
- **Date:** 2026-06-02
- **Scope:** wiki

## Context
A stateless consumer (open then act then close) pays a full rehydrate per call — a non-starter once a long-lived host (wiki-mcp, the embedding read-model plus MCP server) wants to serve reads from a durable, queryable projection (SQL) rather than re-fold history. That host must keep its read store separate from the write path, yet an agent must still be able to read its own writes. Today the engine keeps a single in-memory projection and the handle's reads (tree, page, toMarkdown) are synchronous and token-free, conflating the write-side fold with the read view. The contract is one the host originally specified; per the owner's directive it must live in the core engine, not just the host.

Findings. The engine already owns the right quantity to name a position in history: the per-workspace version (0-based, monotonic, equal to stream length, drives fold order and OCC). So a consistency token is just a workspaceId and version, surfaced as an opaque, comparable string — compared within a workspace only (cross-workspace tokens are independent). Synchronously writing both stores would couple the write path and span two non-atomic stores; waiting on a token after the append converts "eventual" into "after my write" without that coupling. The reducer that validates a command is already a fold; reusing a public fold lets an external read model never semantically diverge from the write model.

## Decision
Adopt strict CQRS with eventual consistency as a core engine property:

- Split the single projection in two. A write-side decide-aggregate — the fold the command bus maintains to validate the FSM / invariants / OCC — and a separate read model (a default in-memory IReadModel, fed by the live tail and token-gated). The engine is CQRS-correct standalone; external read models (e.g. wiki-mcp's SQL projection) implement the same IReadModel.
- Every write returns Committed<T> — { readonly value: T; readonly token: ConsistencyToken }. The token is the committed head version after the append and any OCC rebase-retry, so it names where the events actually landed; an idempotent / zero-event write returns the current head. This includes the eight currently-void structural commands (reparent, reorder, setPageTitle, archivePage, link, unlink, moveItem, archive()) — they mutate a graph the agent reads back, so they carry a token too. Writes do not block on the read model; they return as soon as the append commits.
- Reads optionally take a token and waitFor. Read methods gain { consistentWith?: ConsistencyToken; timeoutMs?: number } and become async (return a Promise): a token present means waitFor(token) then serve (read-your-writes / monotonic); absent means serve current state (eventually consistent, possibly stale). The IReadModel interface is:

```ts
interface IReadModel {
  /** How far this read model has applied, for a workspace. */
  appliedToken(workspace: WorkspaceId): Promise<ConsistencyToken>;
  /** Resolve once applied >= token; reject after timeoutMs (default from config). */
  waitFor(token: ConsistencyToken, opts?: { timeoutMs?: number }): Promise<void>;
}
```

- Export a public, pure fold. foldWorkspace(events, registry, from?) / applyWorkspace(state, event, registry) are exported (with the Registry via the wiki/registry subpath) so external read models reuse exact write-model semantics (upcasting, unknown-type policy, item/FSM effects) and only own the state-to-storage mapping.
- A new ConsistencyTimeoutError (a WikiError subclass) when waitFor exceeds timeoutMs, so a caller can retry or read stale-with-a-flag. IWikiConfig gains a default read-consistency timeout (readConsistencyTimeoutMs, default 5000).

## Consequences
Both write and read surfaces change. Writes: every return becomes Committed<T> (including the eight Promise<void> structural commands and archive()), so every caller unwraps .value/.token. Reads: the handle's synchronous, token-free tree/page/toMarkdown become token-aware and async, served from the new read model rather than the write-side fold. Event sourcing and the API surface both change; the in-memory IReadModel keeps the engine CQRS-correct with no database. The payoff: fast writes, eventually-consistent reads, and a token to demand read-your-writes on demand — and a public fold that lets wiki-mcp's SQL read model stay semantically identical to the engine.

## Relations
_None._
