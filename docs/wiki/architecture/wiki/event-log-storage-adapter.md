# Event log & storage adapter

**Status:** current

## Kind
subsystem

## Summary
The single module that imports `@durable-streams/client`. `EventLog` maps the engine's event model onto Durable Streams: one stream per workspace, a command's events stored as ONE array-message (a "commit"), flattened back to a flat event list on read, plus sibling snapshot and namespace-catalog streams.

## Purpose
Isolates all storage I/O behind the `IEventLog` port so the rest of the engine never touches the DS client, and realizes the two DS guarantees the design leans on: per-stream atomic multi-event append and native `Stream-Seq` optimistic concurrency.

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
