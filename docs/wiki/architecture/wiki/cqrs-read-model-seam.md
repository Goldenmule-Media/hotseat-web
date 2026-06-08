# CQRS read-model seam

**Status:** current

## Kind
subsystem

## Summary
The consistency-token codec plus the default `InMemoryReadModel` implementing `IReadModel` (`appliedToken` / `waitFor`). A `ConsistencyToken` is an opaque, lexicographically-comparable string encoding `{ workspaceId, version }`; every write returns `Committed<T>` carrying the committed-head token.

## Purpose
Makes the engine strict-CQRS-correct standalone: the write side appends and the read side trails, and a caller converts "eventually consistent" into read-your-writes on demand by threading a write's token into a read's `consistentWith`.

## Design notes
_None._

## Components
_No components._

## Dependencies
_No dependencies._

## Code references
- class `InMemoryReadModel` in `wiki/src/core/readmodel.ts`
- function `encodeToken` in `wiki/src/core/readmodel.ts`
- interface `IReadModel` in `wiki/src/api.ts`

## Data model
`InMemoryReadModel` holds only the highest applied `version` per workspace plus a set of parked `Waiter`s — no projection of its own (the handle owns the single in-process fold).

## Usage
`WorkspaceHandle.commit` mints a token from the committed version and calls `notifyApplied`; the live tail also notifies; reads call `awaitConsistency` → `waitFor(token)` before serving. The codec (`encodeToken` / `decodeToken` / `ZERO_VERSION`) and `IReadModel` are exported so an external SQL projection plugs into the same seam.

## Invariants & constraints
- Tokens are comparable WITHIN a single workspace only; version is zero-padded to width 20 so string compare matches numeric.
- `waitFor` resolves immediately if already applied; else parks until `notifyApplied` crosses the threshold or `timeoutMs` elapses → `ConsistencyTimeoutError` (default 5000 ms).
- `notifyApplied` is monotonic (keeps the max) and tolerant of out-of-order / duplicate notifications; writes never block on the read model.

## Synced commit
e357aa7
