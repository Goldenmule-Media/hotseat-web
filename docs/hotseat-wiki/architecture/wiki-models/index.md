# wiki-models

**Status:** current

## Kind
package

## Summary
The **schema layer** — the only home for concrete page types. Built to standalone ESM and **loaded by reference (dynamic import) at runtime**, never baked into the engine. Ships three bundles today: `feature` (feature-brief / implementation-plan / testing-plan / feature-spec), `toc` (this table of contents), and `architecture` (these nodes).

## Purpose
Keep the engine and stream host **schema-agnostic** by isolating ALL domain page types here. Each page type is authored declaratively via `definePageType` against `wiki/authoring`: typed sections/fields, an element vocabulary, a status FSM (`t(from, event, to)`), Zod-validated commands, optional pure `derived` projections, and a deterministic render config. New domains are added here and hot-loaded — no engine change.

## Design notes
_No design notes._

## Components
- [feature-brief](architecture:mpzoj1j9-0055-wifv4u)
- [feature-spec](architecture:mpzoj2o9-0057-bj2han)
- [implementation-plan](architecture:mpzoj3ml-0059-wso9al)
- [testing-plan](architecture:mpzoj5y7-005d-t14bjq)
- [toc](architecture:mpzoj74l-005f-7o0kh9)
- [architecture](architecture:mpzoj8jj-005h-6e1rml)

## Dependencies
- **depends-on** → [wiki](architecture:mpznj2kb-0009-pvqw9d) — Authored against wiki's public authoring API (`wiki/authoring`); the only package that declares concrete page types.

## Code references
- constant `Architecture` in `wiki-models/src/architecture/architecture.ts`
- constant `Toc` in `wiki-models/src/toc/toc.ts`
- `wiki-models/src/feature/index.ts`
- `wiki-models/src/feature/feature-brief.ts`
- `wiki-models/src/feature/implementation-plan.ts`
- `wiki-models/src/feature/testing-plan.ts`

## Data model
Holds no persistent state — it contributes **type definitions**, not data. Each `IPageType` (from `definePageType`) declares: `sections` (`SectionDecl` with `mutableIn` write-gates + `required`), `elements` (`ElementDecl` field maps), `version` + `upcasters`, `statusTransitions` (the lifecycle FSM), `commands` (`DeclarativeCommandMap` — `set` / `produces` / `transition`, with Zod `args` / `result`), optional `derived` projections, and a `render` config. The `feature` bundle additionally wires cross-page behavior (the cascade-finalize sign-off on the brief's `ship`).

## Usage
Depends ONLY on `wiki` (runtime); never imports wiki-mcp / wiki-server. Consumed as TS source (extensionless relative imports), built to standalone ESM with `tsdown`. Each bundle is a directory `src/<bundle>/` whose `index.ts` exports its page types, surfaced as a subpath export (`wiki-models/feature`, `wiki-models/toc`, `wiki-models/architecture`). The server loads bundles with `--models wiki-models/feature` or `--models-dir ../wiki-models/src` (bundle id = directory name). Editing a page type requires a **wiki-server restart** to take effect — the runtime `/_server/models` reload does not pick up source edits.

## Invariants & constraints
- The ONLY package that declares concrete page types; `wiki` / `wiki-mcp` / `wiki-server` stay schema-agnostic.
- Depends only on `wiki`'s authoring API (`wiki/authoring`); must never import wiki-mcp or wiki-server.
- Loaded by reference at runtime (dynamic import), not compiled into the engine; each bundle is a hot-loadable unit keyed by id (its directory name).
- Source of the dev-only dependency cycle: `wiki` devDepends on `wiki-models`, because the engine's own tests import the real `feature` bundle from `wiki-models/feature`.
- Editing a page type requires a wiki-server restart to take effect; the runtime `/_server/models` reload does not pick up source edits.

## Synced commit
e357aa7
