# Testing plan

**Status:** ready

## Planned
_None._

## Passed
- `proposed --accept--> accepted` is legal; an illegal jump from `proposed` (e.g. `supersede`) is rejected with a structured error naming the legal command set.
- `accepted --supersede-->` is rejected while `supersededBy` is unset — the `namesSuccessor` precondition returns its `unmet` reason rather than transitioning.
- `supersede` with a `supersededBy` pointing at a non-existent page is rejected by link integrity; pointing at a live `decision-record` succeeds and both "Supersedes" / "Superseded by" directions render.
- Two records that would both have been "ADR-M7" coexist with distinct global ids and distinct `legacyId` fields — the historical collision is impossible by construction.
- Determinism: a record re-rendered from identical state is byte-identical (the date is a stored field; consequence/relation ordering is explicit).
- The bundle loads via its default-exported array with zero engine/host changes; `describePageType("decision-record")` reports the four-transition FSM and the full command set.
- Migration: running the script against a scratch workspace produces one record per source ADR with `legacyId`/date/scope preserved and the expected `supersededBy` edges; a second run is idempotent.
- Engine (`kindFor`): a declarative `set: arg(id)` on a `ref`-kind field produces a page-ref `IField` (not prose), and an already-structured ref value passes through unchanged — new `wiki` engine unit test.
- The two-op supersession is atomic: the batch [`setSupersededBy(live-ADR)`, `supersede`] commits the ref-set AND the `accepted→superseded` transition together; if `supersede`'s `namesSuccessor` precondition fails (ref unset, or target not a `decision-record`), the WHOLE batch aborts and the ref-set does not persist.

## Failed
_None._

## References
_None._

## Child pages
_None._
