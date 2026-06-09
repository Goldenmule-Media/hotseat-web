# Event log & storage adapter

**Status:** current

## Kind
subsystem

## Summary
The single module that imports `@durable-streams/client`. `EventLog` maps the engine's event model onto Durable Streams: one stream per workspace, a command's events stored as ONE array-message (a "commit"), flattened back to a flat event list on read, plus sibling snapshot and namespace-catalog streams.

## Purpose
Isolates all storage I/O behind the `IEventLog` port so the rest of the engine never touches the DS client, and realizes the two DS guarantees the design leans on: per-stream atomic multi-event append and native `Stream-Seq` optimistic concurrency.

## Design notes
A workspace maps one-to-one onto a single Durable Stream, and that stream is the workspace's only durable consistency boundary. EventLog derives the stream URL from a namespace plus the workspace id, caches one stream handle per workspace, and ensures it exists idempotently before any read or write. Two sibling streams hang off each workspace for secondary concerns: a per-workspace snapshot stream (the workspace URL with a snapshot suffix) and one namespace-wide catalog stream (a dedicated catalog path) that records workspace registration, rename, and archive events. The snapshot and catalog streams are caches and indexes, never sources of truth: only the workspace stream's flat event sequence is authoritative.

The persistence model rests on one empirically verified property of Durable Streams: a POSTed JSON array is stored as exactly ONE message, not split into per-element messages. EventLog exploits this so that all the events a single command produces are appended as ONE atomic array-message, a commit. The whole array lands or none of it does, which is what makes a multi-event mutation transactional without a separate transaction protocol. On the read side this is reversed: a read pulls the array-messages and flattens them back into one continuous, version-ordered event sequence, so the rest of the engine sees a flat event list and never has to know about the commit grouping on the wire.

Optimistic concurrency is realized directly on the Durable Streams Stream-Seq mechanism, which enforces strict-greater sequencing. Before appending, the bus computes expectedVersion as the current folded head and EventLog stamps the append with that value as the stream seq; the host accepts the write only if it advances the sequence, and an equal-or-lower seq is rejected as HTTP 409. EventLog detects that conflict (chiefly a fetch error with status 409, with defensive fallbacks for conflict-coded errors) and translates it into a single typed StaleAppendError. The seq value is zero-padded to twenty digits so the host's lexicographic ordering coincides with numeric ordering. This is the entire concurrency control surface: no locks on the wire, just a conditional append keyed on the expected head.

version is the 0-based per-workspace event count, and because each event occupies one position it equals the stream length. It is the engine's single source of order: it drives the fold (events are applied in version order, and after applying an event the folded head becomes that event's version plus one) AND it is the OCC assertion (the next legal append must claim exactly the current head). Critically, ordering and deduplication come from version alone, never from the Durable Streams offset. The offset is treated only as a coarse, opaque resume cursor for reads and live tails; it may overlap or be approximate, so a rebase skips any tailed event whose version is below the already-folded head, keeping the fold idempotent under a sloppy cursor.

A 409 does not surface to the caller; it drives an in-process rebase-and-retry loop in the command bus. On a StaleAppendError the bus reads the new tail past its cursor, folds those events forward to advance its head and cursor, then re-runs the pure decide step against the now-fresh state and re-appends at the new expectedVersion. Because decide re-runs every attempt, FSM legality and structural invariants are re-checked against whatever a concurrent writer just committed, so a rebase can legitimately reject a mutation that has become illegal. The loop is bounded; after a small fixed number of attempts (currently five) it gives up with a typed ConcurrencyError. Idempotency rides alongside: a commandId already present in folded history short-circuits before decide, so a replayed command returns the current head rather than re-applying or tripping the FSM.

To keep reopen cost bounded as a stream grows, the bus snapshots on a count cadence: after each successful commit it advances an events-since-snapshot counter and, once that crosses the configured threshold (default 100), writes a snapshot to the sibling stream recording the workspace version it covers, the coarse resume cursor at that point, the serialized state, and a registry fingerprint. Snapshotting is strictly best-effort and its failures are swallowed, because the workspace stream remains the source of truth. The fingerprint is the page-type version digest of the live model registry; on load, a fingerprint mismatch invalidates the snapshot (a schema bump moved the reducers) and the workspace re-folds from zero. The load-snapshot path supports folding only the tail past a snapshot's version, but the live open path deliberately folds the full stream from zero so the complete event history stays available for history reads, treating snapshots as a tested optimization rather than a load-time shortcut in this build.

```ts
// IEventLog — the persistence port; EventLog is its only implementation,
// and the only module that imports @durable-streams/client.
interface IEventLog {
  ensure(ws: WorkspaceId): Promise<void>;            // idempotent create
  exists(ws: WorkspaceId): Promise<boolean>;

  // One command's events => ONE atomic array-message, asserting the folded head.
  // A 409 (seq not strict-greater) is raised as StaleAppendError for rebase-retry.
  append(
    ws: WorkspaceId,
    events: IEventEnvelope[],
    opts: { expectedVersion: number },
  ): Promise<AppendResult>;                            // { headVersion, cursor }

  read(ws: WorkspaceId, fromCursor?: string): Promise<ReadResult>; // events flattened
  subscribe(                                          // live tail; batches flattened
    ws: WorkspaceId,
    onBatch: (events: IEventEnvelope[], cursor: string) => void | Promise<void>,
    opts?: { fromCursor?: string },
  ): Promise<Unsubscribe>;

  appendSnapshot(ws: WorkspaceId, s: SerializedSnapshot): Promise<void>;
  readLatestSnapshot(ws: WorkspaceId): Promise<SerializedSnapshot | undefined>;
  appendCatalog(e: CatalogEvent): Promise<void>;
  readCatalog(): Promise<CatalogEvent[]>;
  close(): Promise<void>;
}
```

```ts
// The append shape: events serialize to one body, seq = padded expected head.
const pad = (n: number): string => String(n).padStart(20, "0"); // lexicographic == numeric

async append(ws, events, { expectedVersion }) {
  if (events.length === 0) return { headVersion: expectedVersion, cursor: undefined };
  const handle = await this.handleFor(ws);
  const body = JSON.stringify(events);          // whole array => ONE message
  try {
    await handle.append(body, { seq: pad(expectedVersion) }); // strict-greater OCC
  } catch (e) {
    if (isConflict(e)) throw new StaleAppendError();          // 409 => rebase signal
    throw e;
  }
  return { headVersion: expectedVersion + events.length, cursor: undefined };
}

// The bus's commit loop turns that signal into rebase-and-retry:
for (let attempt = 0; attempt < MAX_REBASE_ATTEMPTS; attempt++) {
  const { events: raw, result } = decide(projection.state); // pure; re-runs each try
  const expectedVersion = projection.state.version;          // == stream length
  try {
    await eventLog.append(ws, envelope(raw, expectedVersion), { expectedVersion });
  } catch (e) {
    if (isStaleAppend(e)) { await rebase(projection); continue; } // fold tail, retry
    throw e;
  }
  absorb(projection, /* committed envelopes */);  // fold own events, advance head
  return { result, committedVersion: projection.state.version };
}
throw new ConcurrencyError(/* bounded retries exhausted */);
```

## Components
_No components._

## Dependencies
_No dependencies._

## Code references
- class `EventLog` in `wiki/src/stores/event-log.ts`
- interface `IEventLog` in `wiki/src/core/types.ts`
- function `writeSnapshot` in `wiki/src/core/snapshot.ts`

## Data model
Owns DS stream-handle caches and live-tail sessions; serializes/deserializes `IEventEnvelope[]` array-messages, `SerializedSnapshot`, and `CatalogEvent`s; translates HTTP 409 into `StaleAppendError`.

## Usage
Constructed in `createWiki`; the command bus calls `append` / `read`, the handle calls `subscribe` (live tail) and `read` (open / rehydrate), and snapshotting uses `appendSnapshot` / `readLatestSnapshot`.

## Invariants & constraints
- A POSTed JSON array is stored as exactly ONE message; reads `.flat()` array-messages back into a flat event sequence.
- OCC seq = `pad(expectedVersion)` (20-digit zero-pad so lexicographic == numeric); an equal-or-lower seq is a 409 surfaced as `StaleAppendError`.
- Per-event ordering and dedup come from the monotonic `version`, never the opaque DS offset (the offset is only a coarse resume cursor); workspace streams use infinite retention.

## Synced commit
e357aa7
