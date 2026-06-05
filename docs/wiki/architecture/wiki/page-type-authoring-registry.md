# Page-type authoring & registry

**Status:** current

## Kind
subsystem

## Summary
The declarative authoring API (`definePageType`, `t`, `arg`) and the `Registry` that consumes it. A page type declares sections + field-kinds, element types + FSMs, commands (declarative `set` / `transition` + a `produces` escape hatch), structural contracts, and render config — and declares NO reducer or renderer.

## Purpose
The schema seam: page types are data, validated mechanically at load, so the engine stays schema-agnostic. The Registry memoizes FSM guards, derives the generated structural-command set, and produces a snapshot-invalidating `fingerprint()`.

## Components
_No components._

## Dependencies
- **depends-on** → [FSM guard](architecture:mpzoir7n-004n-5uignj) — Memoizes one `makeGuard` per page / element type.

## Code references
- class `Registry` in `wiki/src/core/registry.ts`
- function `definePageType` in `wiki/src/core/define.ts`
- interface `IPageTypeDef` in `wiki/src/api.ts`

## Data model
Owns maps of `IPageTypeDef` by type, element decls, memoized `Guard`s, and `GeneratedCommand` sets; declarations are `SectionDecl` / `FieldDecl` / `ElementDecl` / `DeclarativeCommand` / `RenderConfig`.

## Usage
`createWiki` builds one `Registry` from `config.pageTypes`; the bus, reducer, render read model, and `IPageView` all query it (`page`, `pageGuard`, `elementGuard`, `generatedCommands`, `requiredSectionsOf`, `fieldDeclOf`). Exported via the `wiki/registry` subpath for external read models.

## Invariants & constraints
- Declarations are validated at construction (`validateDef`): field-kinds known, `list` elements declared, `mutableIn` statuses exist, `sectionSet.cardinality` keys resolve — else `ValidationError`.
- Static reachability lints catch silent deadlocks: a `mutableIn` status unreachable from `initialStatus`, a `required` section frozen in every status (`mutableIn: []`), or an unreachable element-FSM state are rejected.
- `fingerprint()` is `type@version` sorted/joined — a schema bump invalidates older snapshots; an unregistered type throws `UnknownPageTypeError`.

## Synced commit
e357aa7
