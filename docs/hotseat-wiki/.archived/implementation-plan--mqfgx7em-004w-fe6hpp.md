# Implementation plan — Model page: show page schema and current-state mutable sections

**Status:** ready

## Steps
- [x] Add a synchronous `defOf(type: string | undefined): IPageTypeDef | null` to wiki-ui/lib/host-client.ts (sibling of fsmOf): import { pageTypes } from './models' and return `pageTypes.find(p => p.__def.type === type)?.__def ?? null`. No handshake cache — pageTypes is already statically bundled in tab memory.
- [x] Create wiki-ui/lib/schema-inspector.ts: a pure, hook-free `buildSchemaModel(def, currentStatus): SchemaModel` mirroring lib/fsm-graph.ts. Walk def.sections (and nested SectionDecl.sections recursively), compute per-section `mutableNow = mutableIn === undefined || mutableIn.includes(currentStatus)` (with mutableIn:null when unconstrained), and flatten each field to a row {key, kind, required, requiredInCurrent, plus list.element/ordered and ref.targetKinds}. Types-only import from 'wiki'.
- [x] Create wiki-ui/components/SchemaInspector.tsx: a read-only `"use client"` component taking { def, currentStatus }, calling buildSchemaModel, rendering each (sub)section as a row group with a mutable/locked badge, optional description, and its fields as rows (field key + field-kind chip + required/requiredIn markers). No buttons/forms; recurses for subsections.
- [x] Wire into wiki-ui/components/PageView.tsx: add `const def = useMemo(() => defOf(pageType), [pageType])` next to the existing fsmOf call (~line 90); in the `mode === 'model'` branch, wrap FsmGraph and `<SchemaInspector def={def} currentStatus={currentStatus} />` in a container so both render, gating the inspector on def !== null.
- [x] Add CSS to wiki-ui/app/globals.css alongside the .fsm-graph-layout block: a .schema-inspector container, section rows, a field-kind chip, and mutable-vs-locked badges using existing palette vars; stack the schema panel below the FSM graph and keep the existing 820px responsive behavior.
- [x] Add wiki-ui/lib/schema-inspector.test.ts (vitest, mirroring lib/fsm-graph.test.ts) covering the buildSchemaModel cases. Run `npm run typecheck`, `npm run test`, and `npm run build` from INSIDE wiki-ui/.
- [x] Enrich the inspector so the data types are legible: add a FIELD_KIND_HINT map (plain-language description per field-kind) surfaced on each field row + as a glossary, and resolve a `list` field's element type against def.elements to show the item's real fields (and lifecycle states), depth-guarded against self-referential element types. (kindsInModel drives the glossary.)
- [x] Reshape the presentation as a type signature: render each section (and each resolved list element type) as a `{ }` block of `name: type` lines, list fields as the generic `list<element>` and ref fields as `ref<targets>`, with the field-kind's plain-language meaning shown on HOVER (title) rather than inline; drop the inline hint text and the glossary (and the kindsInModel helper).

## Data models & interfaces
```typescript
// Source shapes (wiki/src/api.ts) — already tab-side via lib/models.ts pageTypes.
// SectionDecl: { name; description?; required?; mutableIn?: readonly string[];
//                fields: Record<string, FieldDecl>; sections?: Record<string, SectionDecl> }
// FieldDecl kinds: scalar | prose | code | attachment-ref | ref | blocks | list | serial
//   (list carries element/ordered; ref carries targetKinds; each carries required?/requiredIn?)

// NEW wiki-ui/lib/schema-inspector.ts (pure view-model, like lib/fsm-graph.ts)
export interface SchemaFieldRow {
  readonly key: string;
  readonly kind: "scalar"|"prose"|"code"|"attachment-ref"|"ref"|"blocks"|"list"|"serial";
  readonly required: boolean;
  readonly requiredInCurrent: boolean;        // requiredIn?.includes(currentStatus)
  readonly elementType?: string;              // list.element
  readonly ordered?: boolean;                 // list.ordered
  readonly targetKinds?: readonly string[];   // ref.targetKinds
}
export interface SchemaSectionRow {
  readonly key: string;
  readonly name: string;
  readonly description?: string;
  readonly required: boolean;
  readonly mutableNow: boolean;               // mutableIn===undefined || includes(currentStatus)
  readonly mutableIn: readonly string[] | null; // null when unconstrained (always mutable)
  readonly fields: readonly SchemaFieldRow[];
  readonly subsections: readonly SchemaSectionRow[];
}
export interface SchemaModel {
  readonly type: string;
  readonly currentStatus: string;
  readonly sections: readonly SchemaSectionRow[];
}
export function buildSchemaModel(def: IPageTypeDef, currentStatus: string): SchemaModel;

// NEW wiki-ui/lib/host-client.ts accessor (sibling of fsmOf)
export function defOf(type: string | undefined): IPageTypeDef | null;
```

## Open questions
_None._

## Resolved questions
_None._

## References
_None._

## Child pages
_None._
