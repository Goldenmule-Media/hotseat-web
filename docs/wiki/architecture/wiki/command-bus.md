# Command bus

**Status:** current

## Kind
subsystem

## Summary
The engine's write-path pipeline. One `CommandBus` per open workspace runs the pure `validate → guard (FSM + per-op write-gate + preconditions) → build-context → decide → commit` sequence for both structural and page-scoped commands, then performs the single I/O step: an atomic append.

## Purpose
Centralizes all write legality (FSM transitions, `mutableIn` write-gates, content-hash edit preconditions, well-formedness dry-run) and makes every write atomic and OCC-safe via rebase-and-retry — so no per-type code ever touches storage or concurrency.

## Design notes
The bus exposes three entry points, all of which funnel into one shared commit step. runStructural drives workspace-shape commands (create, reparent, rename, archive, link) through a fixed table of structural handlers and rejects any unknown verb as a forbidden mutation; it also refuses to run on an archived workspace, the sole exception being unarchive, which by definition acts on an archived one. runPage drives a single FSM-gated command against one page. runPageBatch (the engine surface behind mutateMany) lands an ordered list of commands on one page as a single atomic commit. Each entry point closes over a pure decide function and hands it to commit, which alone performs IO; everything upstream of the append is side-effect-free and re-runnable.

For a page command the decision runs a fixed sequence against the live folded state. It resolves the page node (a missing or archived page fails loudly), looks the command up among the page type's declared and generated commands, then parses the raw arguments with the command's Zod schema. Page-level transitions are checked against the page FSM; element-level transitions are checked against the element's own FSM, and a computed element whose status is derived from a flag is rejected outright so its rendered checkbox stays the single source of truth. The command is then lowered into a flat list of section operations, each content op is gated by its target section's write-gate, code edits carrying an expected content hash are re-verified against the live source, id-addressed ops are checked to hit a real target, declared preconditions run against a read-only related-page reader, and finally the whole op list is dry-run on a clone and the resulting sections are validated for well-formedness before a single section-ops event is emitted.

The write-gate is deliberately keyed off the engine's closed operation vocabulary rather than off the command name, which cleanly separates editing a section's content from driving an element's lifecycle on that same section. Content ops (setField, applyTextEdits, addElement, setElementField, addBlock, setMeta, and so on) are frozen by their target section's mutableIn list once the page leaves an editable status; FSM transition ops and section-tree ops (add, remove, move, rename a section) carry no body content and are never frozen by a section's content gate, only by their own FSM rules. This is what lets a page type say author the set while in draft, then record outcomes while in a later status on one and the same section: the answer write is gated, but the lifecycle transition that accompanies it is not.

commit is the only place that touches storage, and it is built as a bounded rebase-and-retry loop. On each attempt it first short-circuits on idempotency: if the command id is already present anywhere in the projection's history, the original append already produced the effect, so it returns the current head token without re-deciding (the FSM would otherwise reject the replayed command). Otherwise it re-runs decide against the freshest folded state, captures expectedVersion as the current head, envelopes the raw events (minting event ids, occurredAt, schema versions, and a shared per-commit metadata record), and appends them asserting that expected version. A stale append (the optimistic-concurrency conflict, surfaced as HTTP 409 from the stream) triggers a rebase: read the new tail past the cursor, fold it forward, advance the cursor, and loop. Folds are idempotent against the cursor, events already below the projection version are skipped. After at most five attempts an unresolved conflict surfaces as a ConcurrencyError. On a successful append the bus folds its own envelopes back in, advances the version and bookkeeping, fans each event out to subscribers, and may write a count-based snapshot.

Two ordering and atomicity facts make the loop sound. First, decide must never mutate the state it is handed, because commit re-invokes it against the live projection on every rebase attempt; structural decisions re-evaluate their invariants from scratch each pass, and the batch path clones the state before folding. Second, a batch is decided by folding each command over an evolving in-flight copy: command k is decided against the state left by commands 0 through k minus 1, its events applied to the copy with a throwaway envelope, and so on, so an order-dependent batch (set a field, then take a transition gated on that field) is legal, and the accumulated events are committed as one array-message that lands or fails as a unit. Any single command's rejection throws a BatchCommandError pinned to the failing index before anything is appended. Because the whole batch reuses commit verbatim, OCC retry, idempotency, snapshotting, fan-out, and the single committed-head token all apply to it unchanged; the entire batch simply re-decides wholesale on a conflict. The bus itself is re-entrant and stateless about locking: strict per-workspace serialization (so one process never races itself) is provided by a mutex on the workspace handle that wraps every entry-point call.

```text
// commit(projection, decide, meta) - the only IO step, bounded rebase-and-retry
for (attempt = 0; attempt < MAX_REBASE_ATTEMPTS /* = 5 */; attempt++) {
  // (1) idempotent replay: this commandId already in history -> effect already landed
  if (meta.commandId && commandSeen(projection, meta.commandId))
    return { result: undefined, committedVersion: projection.state.version };

  // (2) (re)decide against the FRESHEST folded state - pure, no mutation of state
  const { events, result } = decide(projection.state);
  const expectedVersion = projection.state.version;
  if (events.length === 0)                       // empty decision -> no append
    return { result, committedVersion: expectedVersion };

  // (3) envelope: assign version = expectedVersion + i, eventId, schemaVersion, shared meta
  const envelopes = envelope(projection.state, events, expectedVersion, meta);

  try {
    // (4) atomic append - asserts expectedVersion == current head (OCC)
    await eventLog.append(ws, envelopes, { expectedVersion });
  } catch (e) {
    if (isStaleAppend(e)) {                       // 409: someone else advanced the head
      await rebase(projection);                  //   read tail past cursor, fold fwd, advance cursor
      continue;                                   //   loop: re-decide against the new head
    }
    throw e;
  }

  // (5) success: fold our own envelopes in, advance version/cursor, fan out, maybe snapshot
  absorb(projection, envelopes);
  await maybeSnapshot(projection);
  return { result, committedVersion: projection.state.version };
}
throw new ConcurrencyError(expected, actual);    // exhausted retries
```

## Components
_No components._

## Dependencies
- **depends-on** → [Event log & storage adapter](architecture:mpzoioif-004j-c1rzal) — Calls `append` / `read` for the single I/O step.
- **depends-on** → [FSM guard](architecture:mpzoir7n-004n-5uignj) — Calls `guard.can(…)` to gate every transition.
- **depends-on** → [Structure & invariants](architecture:mpzoisan-004p-kwfmy3) — Dispatches structural commands through `STRUCTURAL_HANDLERS`.
- **calls** → [Section-operation reducer & fold](architecture:mpzoiq0g-004l-dunnzt) — Folds via `applyWorkspace` for absorb, rebase, and the well-formedness dry-run.
- **depends-on** → [CQRS read-model seam](architecture:mpzoiul5-004t-1l21pa) — Mints the committed-head token and notifies the read model.

## Code references
- class `CommandBus` in `wiki/src/core/command-bus.ts`
- interface `CommitOutcome` in `wiki/src/core/command-bus.ts`
- function `createWiki` in `wiki/src/core/wiki.ts`

## Data model
Operates on a `BusProjection` (folded `IWorkspaceState` + the in-memory `IEventEnvelope[]` + the DS cursor + snapshot bookkeeping + the subscriber set); decisions emit lightweight `DomainEvent`s carrying `SectionOp[]` payloads.

## Usage
`WorkspaceHandle` (`core/wiki.ts`) calls `bus.runStructural(…)` / `bus.runPage(…)` under a per-workspace mutex and wraps the returned `CommitOutcome` (result + committed-head version) into a `Committed<T>`.

## Invariants & constraints
- Everything before `commit` is pure — no host clock/RNG; time and ids enter only via injected services (`now()` / `newId()`).
- The append asserts `expectedVersion = state.version`; a stale append (409) triggers a rebase, then re-runs `decide` against fresh state, bounded by `MAX_REBASE_ATTEMPTS` (5) → `ConcurrencyError`.
- A `commandId` already present in history short-circuits before guard/decide (idempotent replay), returning the current head token; per-op write-gating uses each target section's `mutableIn`.

## Synced commit
e357aa7
