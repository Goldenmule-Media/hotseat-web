# wiki

**Status:** current

## Kind
package

## Summary
The transport-free, event-sourced **engine**. Exposes ONLY a TypeScript API (`createWiki` → `IWiki` → `IWorkspaceHandle` / `IPageView`) — no HTTP, no CLI. Ships **zero concrete page types**: it is schema-agnostic and receives them at runtime. Persists to a Durable Streams server over HTTP via `@durable-streams/client`; durability (in-memory / file / ACID) is the stream host's setting, not an engine concern.

## Purpose
Make every page a typed document that changes only through **named, FSM-gated, Zod-validated commands** — never free text — so an LLM agent (and a few humans) can author safely and reproducibly. A page type (`definePageType`) declares typed sections/fields, an item/element vocabulary, a status **FSM**, declarative commands, and a deterministic render config; the engine supplies the single closed section-operation reducer and the deterministic Markdown renderer. Realizes goals G1–G8: transport-free API, statically- + runtime-typed mutations, FSM-gated lifecycle, workspace-as-aggregate, atomic structural/cross-page ops, single-tail subscription, deterministic render, and LLM-native ergonomics (discoverable command catalog, JSON-Schema export, only-legal-actions-offered, structured errors).

## Components
- [Command bus](architecture:mpzoincb-004h-c5129i)
- [Event log & storage adapter](architecture:mpzoioif-004j-c1rzal)
- [Section-operation reducer & fold](architecture:mpzoiq0g-004l-dunnzt)
- [FSM guard](architecture:mpzoir7n-004n-5uignj)
- [Structure & invariants](architecture:mpzoisan-004p-kwfmy3)
- [Page-type authoring & registry](architecture:mpzoithh-004r-hd8cmg)
- [CQRS read-model seam](architecture:mpzoiul5-004t-1l21pa)
- [Deterministic render](architecture:mpzoivv2-004v-6mp3ve)

## Dependencies
- **depends-on** → [wiki-models](architecture:mpznj3vk-000b-mqwd0h) — DEV/test-only devDependency — the engine's own tests import the real `feature` bundle. Not a runtime edge (this is the deliberate dev-only cycle).

## Code references
- function `createWiki` in `wiki/src/core/wiki.ts`
- interface `IWorkspaceHandle` in `wiki/src/api.ts`
- function `definePageType` in `wiki/src/core/define.ts`
- function `makeGuard` in `wiki/src/core/guard.ts`
- `wiki/src/core/command-bus.ts`
- `wiki/src/core/operations.ts`
- `wiki/src/stores/event-log.ts`
- `wiki/src/render/read-model.ts`
- function `foldWorkspace` in `wiki/src/core/workspace.ts`

## Data model
The aggregate is the **workspace** (`IWorkspaceState`): a `Map` of pages by id, an ordered `children` map (the tree, keyed by parent id or the `@root` sentinel), `links` (graph edges beyond the tree), and `version` == the per-workspace event count. A page (`PageState` / `IPageNode`) is a tree of typed **sections** (`ISection`), each holding typed **fields** (`IField`; the closed `FieldKind` set: `scalar` / `prose` / `code` / `attachment-ref` / `ref` / `blocks` / `list`); a `list` field holds **items** (`IItem`) with their own id / status / fields. All content writes are the single event `SectionOpsApplied`, carrying an ordered list from the closed `SectionOp` vocabulary (`setField`, `addElement`, `moveElement`, `transition`, `addSection`, …). A command's events are one atomic array-message; reads flatten array-messages back to a flat event list, folded in `version` order.

## Usage
Consumed as **TypeScript source** (`moduleResolution: "Bundler"`; extensionless relative imports). Entry point `createWiki(config: IWikiConfig)` takes the stream config, the `pageTypes` array, and injected `clock` / `ids` for determinism. The public surface is the barrel `wiki/src/index.ts` plus three subpaths:

- **`wiki/authoring`** — `definePageType`, `arg`, `t`, `zodSchema` / `z` (what `wiki-models` builds on);
- **`wiki/registry`** — the `Registry` + the public `foldWorkspace`, so an external read model can fold history itself;
- **`wiki/testing`** — `createTestWiki`, `startTestServer`, `wikiOn` (an in-process Durable Streams test server).

Every write returns `Committed<T>` (value + opaque consistency token); reads are async and token-gated — pass `consistentWith` a write's token for read-your-writes, or omit it for eventually-consistent state.

## Invariants & constraints
- Transport-free (G1): exposes only a TypeScript API — no HTTP, no CLI. It consumes a Durable Streams server over HTTP for storage but surfaces none of that network detail.
- Schema-agnostic: ships zero concrete page types. Page types arrive at runtime via `IWikiConfig.pageTypes`; an unknown `type` is rejected at `createPage`.
- Determinism (hard rule): no `Date.now()`, `Math.random()`, or `new Date()` in `apply` / `produces` / `render`; time and ids are injected via `clock` / `ids`. Equal state must render byte-identical Markdown.
- A workspace = one Durable Stream = the unit of atomic consistency. A command's events are written as ONE atomic array-message (a "commit"); there is no cross-workspace atomicity.
- A mutation is legal iff the FSM declares the transition from the current status (self-transitions included). Structural invariants — acyclic tree, unique sibling title, link target exists — are checked in handlers.
- OCC via `Stream-Seq` (strict-greater): a stale append → HTTP 409 → rebase-and-retry. `version` is the 0-based per-workspace event count and drives fold order.
- Schema evolution is upcast-to-latest: events carry `schemaVersion`; the fold chains a type's `upcasters` up to its current `version`, then one head `apply` runs. Field-level schemas and required fields are enforced on every command path (incl. auto-generated structural commands).

## Synced commit
e357aa7
