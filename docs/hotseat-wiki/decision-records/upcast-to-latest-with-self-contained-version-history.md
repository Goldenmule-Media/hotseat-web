# ADR-23: Upcast-to-latest with self-contained version history

**Status:** accepted

## Metadata
- **Date:** 2026-06-02
- **Scope:** wiki-models

## Context
Schema must change at runtime, and an event stream contains events written under older page-type
versions. Two models handle that: **upcast-to-latest** (transform old payloads forward to the head shape,
fold with one current reducer) or **version-routed reducers** (keep every version's reducer and fold each
event with its own). The engine already implements the former: `IPageType.version` + sparse `upcasters`,
`upcastPayload` on the fold path (`wiki/src/core/workspace.ts:163`), version-stamped writes
(`command-bus.ts:369`), and a `type@version` fingerprint (`registry.ts:89`).

## Decision
Adopt upcast-to-latest, and express a model's history as per-page-type vN/ folders that
compose into the engine's existing version + upcasters contract. A bundle must retain its complete
upcaster chain (§6) so any historical event can climb to the head.

Why. It is the engine's existing contract, so no engine change is needed and wiki stays
schema-agnostic and unchanged. It sidesteps version-routed reducers' state-coherence problem (a single
page's state assembled by N different reducers across mixed-version events). One reducer reads one shape;
all backward-compat is isolated in pure upcasters.

## Consequences
Shipped versions are immutable; evolving a type means append a version + an upcaster,
never editing a prior vN/. A reload that lowers a type's version below live events halts those workspaces
loudly (desired locally). The runtime that loads/reloads bundles is specified in
wiki-mcp ADR-M6. (Under ADR-M7 the upcasted payloads are content-schema
shapes — section/field/element/meta — not per-type events, but the chain mechanism is unchanged.)

## Relations
_None._
