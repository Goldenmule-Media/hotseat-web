# Implementation plan

**Status:** ready

## Steps
- [x] wiki-ui — pure schema→form transform. Add lib/schema-form.ts with schemaToFields(argsSchema): map the JSON-Schema object zod-to-json-schema emits (type:"object", properties, required[]) to ordered FormField specs {key, label, kind, required, enumValues?, description?}, where kind ∈ text|number|integer|boolean|enum|array|json; resolve a top-level $ref into $defs/definitions defensively; an unrecognized property shape → kind "json". Add coerceValues(fields, raw): convert inputs to typed values (number/integer→Number, boolean→checkbox, array/json→JSON.parse), drop empty optionals, and return {args, errors} with a per-field message on a parse failure or a missing required field. No React. Unit-test against real schemas: z.object({}) → [] (confirm-only); a {sha, message, url?} schema → three text fields, url optional; number/integer/enum/array kinds; an opaque shape → json.
- [x] wiki-ui — write path. In lib/live.tsx add usePageMutator(workspaceId, pageId) returning { run(command, args), pending, error, reset }. run() grabs sessionFor(workspaceId).handle() and calls h.mutate(pageId, command, args); on success it sets pending false and returns true (the existing subscribe tail handles the repaint, so the hook touches no view state); on throw it classifies the WikiError via the existing classify()/errMsg() helpers into a readable message and returns false. Export the hook and a PageMutator type. This is the first WRITE path in wiki-ui — keep it the only place the handle's mutate is called.
- [x] wiki-ui — TransitionForm + Modal components. Add components/Modal.tsx: a backdrop + centered panel rendered via a portal, closing on Escape and backdrop click, focusing its first focusable child on open. Add components/TransitionForm.tsx: take a TransitionTarget {descriptor, from, to, available, unmet?}; render schemaToFields(descriptor.argsSchema) as controlled inputs (text/number/checkbox/select/array/json), show the from→to transition and command name in the header; when there are no fields show a confirm-and-run body; when !available render fields read-only/disabled and show the unmet reason with the run button disabled; on submit call coerceValues, surface any field errors, else call the usePageMutator run() and — on true — close the modal, else show the returned engine error. Style both in globals.css to match the dark theme.
- [x] wiki-ui — wire clicks into the graph + thread props. In components/FsmGraph.tsx, widen the prop from overlay: TransitionAvailability[] to descriptors: IMutationDescriptor[] (already passed at runtime) and accept workspaceId + pageId from PageView; carry {event, from, to, cls} on each React Flow edge's data; add onEdgeClick that, for an edge whose from === currentStatus (cls available or blocked), finds the descriptor by name === event and opens the Modal with a TransitionForm for it; ignore inert edges. Add a pointer-cursor / hover affordance on interactive edges. Hold the open-target in component state and clear it on close or successful run. Verify: npm run typecheck clean workspace-wide and npm run test -w wiki-ui green; defer the live-transition browser smoke-check to the user.

## Data models & interfaces
```typescript
// ── wiki-ui: pure schema→form transform (lib/schema-form.ts) — unit-tested, no React ──
// argsSchema is the JSON Schema zod-to-json-schema emits: { type:"object", properties, required? }.
export type FieldKind = "text" | "number" | "integer" | "boolean" | "enum" | "array" | "json";

export interface FormField {
  readonly key: string;
  readonly label: string;            // titleCase(key)
  readonly kind: FieldKind;
  readonly required: boolean;        // key ∈ schema.required
  readonly description?: string;     // schema.properties[key].description
  readonly enumValues?: readonly string[]; // when kind === "enum"
}

// Map the object schema to ordered field specs. Empty object → [] (confirm-only form).
// Resolves a top-level $ref into $defs/definitions; an unrecognized property shape → "json".
export function schemaToFields(argsSchema: JsonSchema): readonly FormField[];

// Coerce raw string/boolean inputs to typed args: number/integer→Number, array/json→JSON.parse,
// drop empty optionals; collect per-field messages for missing-required and parse failures.
export function coerceValues(
  fields: readonly FormField[],
  raw: Record<string, string | boolean>,
): { args: Record<string, unknown>; errors: Record<string, string> };

// ── wiki-ui: write path (lib/live.tsx) — the only place IWorkspaceHandle.mutate is called ──
export interface PageMutator {
  run(command: string, args: Record<string, unknown>): Promise<boolean>; // true on commit
  readonly pending: boolean;
  readonly error: string | null;     // engine ValidationError / precondition message, formatted
  reset(): void;
}
export function usePageMutator(workspaceId: WorkspaceId, pageId: PageId): PageMutator;

// ── wiki-ui: the clicked-edge context handed to <TransitionForm> ──
export interface TransitionTarget {
  readonly descriptor: IMutationDescriptor; // descriptor.name === FsmTransition.event; carries argsSchema
  readonly from: string;
  readonly to: string;
  readonly available: boolean;       // from the describeMutations overlay (runnable now)
  readonly unmet?: string;           // blocked edge: the first failed precondition's reason
}

// ── Engine surface REUSED unchanged (wiki) — no new types, listed for reference ──
// interface IMutationDescriptor { name; argsSchema: JsonSchema; available; unmet?; ... }
// interface IWorkspaceHandle { mutate(pageId, command, args): Promise<Committed<...>>; ... }
// IPageView.describeMutations(): Promise<readonly IMutationDescriptor[]>  // already returns argsSchema
```

## Open questions
_None._

## Resolved questions
_None._

## References
_None._

## Child pages
_None._
