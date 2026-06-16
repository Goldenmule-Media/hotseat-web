# Feature: Model page: show page schema and current-state mutable sections

**Status:** shipped

## Summary
Extend wiki-ui's PageView "Model" view so that, alongside the existing FSM status graph, it renders a read-only content-schema inspector: the page TYPE's sections and each section's fields (with their field-kind — scalar/prose/code/attachment-ref/ref/blocks/list/serial), plus a per-section "mutable in current status" indicator derived from the model-declared `SectionDecl.mutableIn` against the page instance's current status. The schema lives on `IPageType.__def.sections` and is ALREADY in tab memory because `lib/models.ts` statically bundles every wiki-models page type into `pageTypes` (it already reads `__def`). So the feature is purely client-side: a synchronous `defOf(type)` lookup over the bundled `pageTypes`, a pure view-model transformer (mirroring `lib/fsm-graph.ts`), a new read-only `SchemaInspector` component composed beside `FsmGraph`, and CSS. It authors nothing and touches no worker/handshake/engine code.

## Components affected
- wiki-ui/lib/host-client.ts — synchronous `defOf(type): IPageTypeDef | null` accessor over the bundled `pageTypes` (sibling of `fsmOf`); no handshake cache needed since pageTypes is already in tab memory
- wiki-ui/lib/schema-inspector.ts — NEW pure, hook-free, unit-testable view-model `buildSchemaModel(def, currentStatus)` (mirrors lib/fsm-graph.ts) that walks sections + nested subsections, computes per-section mutability, and flattens fields to rows
- wiki-ui/components/SchemaInspector.tsx — NEW read-only React component rendering sections with a mutable/locked badge, descriptions, and field rows (field-kind chip + requiredIn metadata). No buttons, no forms
- wiki-ui/components/PageView.tsx — look up `def` via `defOf(pageType)` next to the existing `fsmOf`, and compose `<SchemaInspector>` alongside `<FsmGraph>` in the `mode === 'model'` branch (gated on def !== null)
- wiki-ui/app/globals.css — schema-inspector styling (section rows, field-kind chips, mutable/locked badges) reusing existing palette vars, alongside the .fsm-graph-layout block

## Design constraints
1. Read-only inspection only: the panel authors nothing, issues no commands, and adds no buttons/forms — pure presentation.
2. Resolve the schema SYNCHRONOUSLY in render from the build-time-bundled `pageTypes` (`__def`) — do NOT add an async RPC, and do NOT change the worker, the handshake (HandshakeResult), or wiki-host-api.ts. (FieldDecl/SectionDecl carry function props + Zod validators that are not structured-clone-safe, so the handshake route is both unnecessary and hazardous.)
3. Mirror the engine's mutability rule EXACTLY (wiki/src/core/wiki.ts:886): a section is mutable in the current status iff `mutableIn === undefined || mutableIn.includes(currentStatus)` — undefined mutableIn means always mutable.
4. Keep the engine schema-agnostic: read section/field/mutableIn detail ONLY from model-side `IPageType.__def` (the engine's public TypeDescriptor deliberately omits sections). Never invent an engine schema API.
5. No changes to wiki, wiki-models, wiki-mcp, or wiki-server. The transformer must be deterministic (no clock/RNG, stable section key order) and unit-tested like lib/fsm-graph.ts. Run typecheck/test/build from INSIDE wiki-ui/ (its own lockfile).
6. v1 scope: top-level sections + nested subsections + their fields, with field-kind chips, the per-section mutability badge, and requiredIn shown as plain metadata; surface a list field's element-type name. Full expansion of element-type (def.elements) field schemas is deferred to a follow-up.

## Open questions
_None._

## Resolved questions
_None._

## References
_None._

## Child pages
- [Implementation plan — Model page: show page schema and current-state mutable sections](implementation-plan:mqfgx7em-004w-fe6hpp)
- [Testing plan — Model page: show page schema and current-state mutable sections](testing-plan:mqfgx7em-004x-m9v6t9)
- [Spec — Model page: show page schema and current-state mutable sections](feature-spec:mqfgx7em-004y-45xvy)

## Commits
- `e0ac17e8bb0616c12ee076ea12f8dddee48bf4e5` feat(wiki-ui): content-schema inspector in the model view
- `1b4a053d3376898f7d3d81400dd44020647a26d7` feat(wiki-ui): explain field data-types in the schema inspector
- `e45b4cc536a0f2bcda168b105ff485e310ac9499` refactor(wiki-ui): render the schema inspector as a type signature
- `3c62a609f529de24a585973d771d84f381164352` fix(wiki-ui): tie the mutable/locked badge to its section block
- `5aa1392019d02e0fa0a940ca7c12c946a4b13335` fix(wiki-ui): real hover tooltips for schema type explanations
