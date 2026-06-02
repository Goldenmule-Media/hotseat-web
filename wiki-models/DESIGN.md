# wiki-models — Design Document

> Status: **Draft / living document** · Last updated: 2026-06-02 · Owner: @benjamin
>
> The **schema layer** for the wiki engine: versioned **page-type bundles**, authored against the
> engine's page-type API and **loaded by reference at runtime** so they can be **hot-reloaded** without
> restarting the server. The core packages stay schema-agnostic — `wiki` (engine), `wiki-mcp`
> (read model / engine host), and `wiki-server` (stream + MCP host) ship **no concrete page types**;
> all of them live here. A model is built to JS, addressed by a module specifier, and `import()`-ed by
> `wiki-mcp`'s live model registry ([wiki-mcp/DESIGN.md ADR-M6](../wiki-mcp/DESIGN.md)).

---

## Table of contents

1. [Motivation & scope](#1-motivation--scope)
2. [What a model bundle is](#2-what-a-model-bundle-is)
3. [Versioning & the `vN/` layout](#3-versioning--the-vn-layout)
4. [The retention invariant & authoring rules](#4-the-retention-invariant--authoring-rules)
5. [Loading by reference & the reload lifecycle](#5-loading-by-reference--the-reload-lifecycle)
6. [The `featurePageTypes` move](#6-the-featurepagetypes-move)
7. [Non-goals & future work](#7-non-goals--future-work)
8. [Appendix A: Decision records](#appendix-a-decision-records)

---

## 1. Motivation & scope

Page types are not configuration — they carry the **reducer** that folds events into page state, so they
are part of the engine's consistency contract, not a runtime flag. The engine already treats them as
**plugins**: `createWiki({ pageTypes })` takes a fixed set, and the fold routes each content event through
the owning type's `apply` ([wiki/DESIGN.md §7.3](../wiki/DESIGN.md)). `wiki-models/` is where those plugins
live, so that:

- **The core stays schema-agnostic.** No concrete page type is baked into `wiki`/`wiki-mcp`/`wiki-server`.
  A deployment chooses its schema by pointing the runtime at one or more model bundles.
- **Schema is swappable at runtime.** A model can be rebuilt and **reloaded into a running server** — the
  intended loop is *edit a model → build → reload*, driven from a build pipeline, not by an agent.

**In scope:** the bundle shape, the per-page-type `vN/` version layout, the retention invariant that keeps
old events foldable, and the authoring contract the runtime relies on. **Out of scope (owned elsewhere):**
the live registry, the cache-busted `import()`, reprojection, and the control endpoint — those are
`wiki-mcp`'s concern ([ADR-M6](../wiki-mcp/DESIGN.md)). This doc states the *contract*; `wiki-mcp` owns the
*mechanism*.

## 2. What a model bundle is

A **model bundle** is the unit of load, reload, and unregister: a built ESM module, addressed by a module
specifier (e.g. `wiki-models/feature` or a path), whose default export is an **array of composed page-type
definitions** — exactly the shape `createWiki`/`createWikiMcp` already accept as `pageTypes`.

```
wiki-models/
├─ package.json            # name "wiki-models"; depends on `wiki` (the page-type authoring API only)
├─ DESIGN.md               # ← this document
└─ src/
   └─ feature/             # the "feature" bundle (was wiki/src/pages/feature)
      ├─ index.ts          # default export: [FeatureBrief, ImplementationPlan, ImplementationChecklist, TestingPlan]
      ├─ feature-brief/
      │   ├─ index.ts      # composes ONE IPageType: { type, version: N, fields, status, commands, apply, renderer, upcasters }
      │   ├─ v1/           # version 1 of feature-brief's event payloads
      │   │   ├─ payloads.ts   # the content-event payload shapes at v1
      │   │   └─ upcast.ts     # (v1 payload) => v2 payload
      │   ├─ v2/
      │   │   ├─ payloads.ts
      │   │   └─ upcast.ts     # (v2 payload) => v3 payload
      │   └─ v3/               # CURRENT version: payload shapes the live `apply` reads (no upcast — it is the head)
      │       └─ payloads.ts
      └─ … (one folder per page type)
```

> The `vN/` foldering is the layout this package **introduces**. Today's worked example is flat
> single-file defs (`wiki/src/pages/feature/feature-brief.ts`, …), each at `version: 1`; the move (§6)
> refactors them into this shape.

`wiki-models` depends only on the engine's **authoring** surface (the `define`/`t` API and `IPageType`,
[wiki/DESIGN.md §7.3](../wiki/DESIGN.md)) — never on `wiki-mcp` or `wiki-server`. It contains **no runtime**;
it is content that a host imports. A second schema lives as a sibling bundle (or its own package,
`wiki-models-acme/`) with no change to any core package.

## 3. Versioning & the `vN/` layout

The doc this rides on already exists in the engine — **upcast-to-latest** ([ADR-W1](#adr-w1--upcast-to-latest-with-self-contained-version-history-2026-06-02)). Each page type declares a
single **current** `version: number` and a sparse `upcasters: { [v]: (payload) => nextPayload }` map:

- On **write**, the engine stamps a content event with the def's *current* `version`
  (`command-bus.ts:369` → `registry.page(type).version`; an unregistered type falls back to `schemaVersion` 0).
- On **fold**, `upcastPayload` (`wiki/src/core/workspace.ts:163`) reads `event.schemaVersion` and **chains
  the upcasters forward** from that version up to `def.version`, then runs the **one** current `apply` on
  the upcasted payload. A missing step is a no-op pass-through; `schemaVersion > def.version` (an event
  *newer* than the registered def) is a **hard error** → the workspace's projection halts.
- `fingerprint()` is `"type@version,…"` (`wiki/src/core/registry.ts:89`); bumping any type's `version`
  changes the per-workspace fingerprint and triggers a refold.

So **versions are per page type**, and the `vN/` folders are an *authoring layout* that composes into that
existing contract — they do **not** become N separate reducers the fold routes between. Each `vN/` owns the
**event payload shape at version N** plus the **upcaster from N to N+1**; the head version owns only its
payload shape (the live `apply` reads it). The folders form a typed chain:

```
v1.payload ─(v1/upcast)→ v2.payload ─(v2/upcast)→ v3.payload ─→ apply   (current reducer)
```

The page type's `index.ts` assembles one `IPageType`: `version` = the head number, `upcasters` wired from
each `vN/upcast.ts`, and `apply`/`fields`/`status`/`renderer` written against the **head** payloads only.
(The `v1 → v2 → v3` chain above is illustrative — the worked-example types are all at `version: 1` today,
so each begins life with a single `v1/` and no upcasters.)

## 4. The retention invariant & authoring rules

Because the engine upcasts to the head and runs a single reducer, a bundle must be **self-contained across
its whole history**. The invariant:

> **A bundle must retain the complete upcaster chain for every version it has ever written.**
> Any event in any stream was stamped with some historical `version`; folding it climbs the chain to the
> head. Drop an intermediate `vN/upcast.ts` and that step silently passes the payload through unchanged
> (likely wrong); ship a head reducer that can't read an upcasted old payload and you corrupt or halt.

Authoring rules that keep that true:

- **Versions are append-only and monotonic.** To change a payload shape, add `v(N+1)/` with an
  `vN/upcast.ts` step and bump the type's `version` — **never edit a shipped `vN/payloads.ts`**. A shipped
  version is immutable history.
- **The head reducer reads only the head shape.** All backward compatibility is expressed as upcasters, not
  as branches inside `apply`.
- **Lowering a version is a halt, by design.** If a reload ships a def whose `version` is *below* events
  already in a stream (a rollback), those events are `schemaVersion > version` → the workspace halts loudly.
  Locally this is the desired signal ("you rolled back past live data"); fix forward and reload again.
- **A bundle is the reload unit.** Reload replaces the whole bundle atomically; a partial set is never
  registered.

## 5. Loading by reference & the reload lifecycle

`wiki-models` is **content**; the runtime is `wiki-mcp`'s live model registry ([ADR-M6](../wiki-mcp/DESIGN.md)).
The contract this package satisfies:

- **Built artifact.** A bundle ships as built ESM resolvable on disk at runtime (it cannot be pre-bundled
  into the server image — see ADR-M6). The build pipeline produces it, then asks the server to (re)load it.
- **Addressed by specifier.** Load/reload/unregister name a bundle by module specifier/path; the server
  `import()`s it. `wiki-server` only proxies the request and never learns the page-type code, so it stays
  schema-agnostic.
- **Lifecycle.** *Load* registers a bundle (its types become creatable; halted workspaces whose events that
  bundle now covers reproject and clear). *Reload* is a **hard replace** — re-import the rebuilt bundle and
  swap it. *Unregister* hard-removes it; any workspace with live events of a removed type halts (a **local
  escape hatch**, not a production operation). In practice the common op is *reload* ≈ replace, since a
  self-contained bundle (§4) keeps every prior version, so a replace never loses the ability to fold old
  events.

The reprojection, hot-handle eviction, cache-busting, and the `/_server/models` control endpoint are all
specified in [wiki-mcp ADR-M6](../wiki-mcp/DESIGN.md).

## 6. The `featurePageTypes` move

`featurePageTypes` is today a **worked example** inside the engine (`wiki/src/pages/feature`,
[wiki/DESIGN.md §13](../wiki/DESIGN.md)). It moves here as the `feature` bundle, refactored into the `vN/`
layout (its types are at `version: 1` today, so each starts with a single `v1/`). After the move, `wiki`
ships the engine + `Registry` and **zero concrete page types** — completing its schema-agnosticism.

The engine's own test suite leans on `featurePageTypes` heavily (`wiki/test/*`). Two acceptable options,
to settle when the move lands: (a) the engine tests import the `feature` bundle from `wiki-models` as a
**dev dependency**, or (b) the engine keeps a **tiny throwaway fixture** page type for its tests and
`wiki-models` owns the real `feature` bundle. (a) keeps one canonical schema; (b) keeps the engine's test
graph free of a downstream dependency. Leaning (b) for the engine's unit tests, (a) for any integration
test that wants the real bundle.

## 7. Non-goals & future work

- **Not a production hot-swap story.** Runtime reload targets the local *edit → build → reload* loop and
  pipeline-driven deploys; multi-replica coordinated reload is out of scope here.
- **No per-namespace model selection yet.** Which bundles a namespace uses (and persisting that choice) maps
  onto the engine's catalog config, which is *reserved, not yet designed* ([wiki/DESIGN.md §8](../wiki/DESIGN.md)).
- **No model signing / trust.** Loading a bundle is arbitrary code execution; first-party bundles are
  trusted. Any future "third-party model" path needs a trust boundary.
- **Version-routed reducers** (folding each event with its own version's reducer) were considered and
  rejected in favor of upcast-to-latest ([ADR-W1](#adr-w1--upcast-to-latest-with-self-contained-version-history-2026-06-02)).

---

## Appendix A: Decision records

### ADR-W1 — Upcast-to-latest with self-contained version history (2026-06-02)

**Context.** Schema must change at runtime, and an event stream contains events written under older page-type
versions. Two models handle that: **upcast-to-latest** (transform old payloads forward to the head shape,
fold with one current reducer) or **version-routed reducers** (keep every version's reducer and fold each
event with its own). The engine already implements the former: `IPageType.version` + sparse `upcasters`,
`upcastPayload` on the fold path (`wiki/src/core/workspace.ts:163`), version-stamped writes
(`command-bus.ts:369`), and a `type@version` fingerprint (`registry.ts:89`).

**Decision.** Adopt **upcast-to-latest**, and express a model's history as per-page-type `vN/` folders that
compose into the engine's existing `version` + `upcasters` contract. A bundle must retain its **complete
upcaster chain** (§4) so any historical event can climb to the head.

**Why.** It is the engine's existing contract, so **no engine change** is needed and `wiki` stays
schema-agnostic and unchanged. It sidesteps version-routed reducers' **state-coherence** problem (a single
page's `fields` assembled by N different reducers across mixed-version events). One reducer reads one shape;
all backward-compat is isolated in pure upcasters.

**Consequences.** Shipped versions are immutable; evolving a type means *append a version + an upcaster*,
never editing a prior `vN/`. A reload that lowers a type's version below live events halts those workspaces
loudly (desired locally). The runtime that loads/reloads bundles is specified in
[wiki-mcp ADR-M6](../wiki-mcp/DESIGN.md).
