# Section-operation reducer & fold

**Status:** current

## Kind
subsystem

## Summary
The single engine-owned reducer. `applyOps` folds an ordered `SectionOp[]` (the closed vocabulary: `setField` / `applyTextEdits` / `add|remove|move|setElementField` / `add|remove|move|renameSection` / block ops + `setMeta` / `transition`) into a page's section tree; `foldWorkspace` / `applyWorkspace` rebuild `IWorkspaceState` from events, upcasting content payloads to the page type's current schema version first.

## Purpose
Replaces all per-type, author-written reducers with one total, pure fold over a closed operation vocabulary — a single audit/replay path, one upcasting target per op kind, and a reducer the engine (not the model) owns.

## Design notes
Every event in a workspace's history is one self-describing envelope. It carries an eventId, the streamId of the owning workspace, an optional pageId (present only for events that target a page), a 0-based per-workspace version that defines both fold order and the optimistic-concurrency boundary, a type tag, the schemaVersion the payload was written under, the payload itself, and a meta record. The meta carries occurredAt (an ISO timestamp drawn from the injected clock, never read at fold time), the originating actor and commandId for idempotency, and a command field naming the semantic command that produced the event (for example answerQuestion) so the audit log reads in the model's own vocabulary even though no per-type event types exist. Because time and ids live entirely inside the envelope, the fold is a pure, total replay: the same envelope sequence always reconstructs byte-identical state.

```ts
export interface IEventEnvelope<T extends string = string, P = unknown> {
  readonly eventId: string;
  readonly streamId: WorkspaceId;       // the aggregate == the workspace
  readonly pageId?: PageId;             // absent for pure structural events
  readonly version: number;            // 0-based per-workspace seq; fold order + OCC
  readonly type: T;
  readonly schemaVersion: number;       // schema the payload was written under
  readonly payload: P;
  readonly meta: IEventMeta;            // occurredAt, actor, commandId, command, ...
}
```

The fold splits the event vocabulary into exactly two families, and applyWorkspace routes on the type tag. Structural events shape the workspace graph itself and are handled inline by the engine: WorkspaceCreated, PageCreated, PageReparented, ChildrenReordered, PageTitleSet, PageArchived, PageUnarchived, LinkAdded, LinkRemoved, and the workspace-level Archived and Unarchived pair. These mutate the page registry, the parent-to-children index, and the link list directly; they never touch a page's content tree. Everything else is content, and there is precisely one content event type, SectionOpsApplied, whose payload is an ordered list of section operations. A content event must name a pageId and must be that single type; anything else is rejected as unroutable. This two-family split keeps the workspace's shape and a page's body on cleanly separate codepaths while leaving one funnel for all content change.

Content events are generic. There are no author-written reducers and no per-page-type event types; instead a content event is an ordered SectionOp list folded by one built-in reducer, applyOps. The operation vocabulary is closed and engine-owned: setField and applyTextEdits for field values, add/remove/move/setElementField for list elements, add/remove/move/setBlock for block-tree fields, add/remove/move/renameSection for the section tree, setMeta for the bounded meta channel, and transition for FSM moves at page or element level. applyOps mutates a PageState view that aliases the live node's section tree, so the fold writes straight through to the node, and it bumps updatedAt exactly once at the end. The only seam an author owns is reduceMeta, a single-writer hook that lets a section or element project an op into its own meta object; every other effect of every op is the engine's. This is what lets one reducer serve every page type with one audit path and one replay path.

```ts
// The closed, engine-owned content-operation vocabulary (abridged).
export type SectionOp =
  // field / element edits
  | { op: "setField"; section: string; field: string; value: IField }
  | { op: "applyTextEdits"; section: string; field: string; block?: BlockId; edits: TextEdit[]; expectedHash?: string }
  | { op: "addElement"; section: string; field: string; id: string; fields: Record<string, IField>; status?: string; index?: number }
  | { op: "removeElement"; section: string; field: string; id: string }
  | { op: "moveElement"; section: string; field: string; id: string; toIndex: number }
  | { op: "setElementField"; section: string; field: string; id: string; elementField: string; value: IField }
  // block-tree edits (a blocks field)
  | { op: "addBlock"; section: string; field: string; block: IBlock; index?: number }
  | { op: "removeBlock"; section: string; field: string; block: BlockId }
  | { op: "moveBlock"; section: string; field: string; block: BlockId; toIndex: number }
  | { op: "setBlock"; section: string; field: string; block: IBlock }
  // section-tree edits
  | { op: "addSection"; key: string; name: string; parentSection?: SectionId | null; index?: number; id?: SectionId }
  | { op: "removeSection"; section: string }
  | { op: "moveSection"; section: string; parentSection: SectionId | null; toIndex: number }
  | { op: "renameSection"; section: string; name: string }
  // meta + FSM
  | { op: "setMeta"; section: string; element?: string; path: (string | number)[]; value: unknown }
  | { op: "transition"; level: "page" | "element"; section?: string; field?: string; element?: string; event: string };

export interface SectionOpsAppliedPayload { readonly ops: SectionOp[]; }
```

foldWorkspace is the entry point that walks an envelope sequence into state. With no snapshot, the first event must be WorkspaceCreated, which seeds an empty active workspace; the fold then requires strict version contiguity, throwing if any consumed event's version is not exactly one past the last so a gap in history fails fast rather than silently corrupting state. It also accepts an optional snapshot plus the version that snapshot already covers and skips every event at or below that version, which makes a coarse-cursor read idempotent: replaying a window that overlaps the snapshot reproduces the same state. After each applied event the workspace version is advanced to that event's version plus one, keeping version a faithful 0-based count of events consumed.

Schema evolution is handled by upcast-to-latest at fold time, transparently to the reducer. Because each envelope records the schemaVersion its payload was written under, a content event whose page type has since advanced is brought current before it is applied: the fold composes that type's registered upcasters, one per from-version, chaining from the event's schemaVersion up to the type's current version, and only then runs the single head reducer on the result. The reducer therefore always sees payloads in one shape, today's, so there is exactly one apply per content event and exactly one upcasting target per operation kind, no matter how old the event is. An event whose schemaVersion is greater than the registered current version is impossible to upcast and is treated as a hard unknown-type error, which guards against folding history written by a newer, unloaded schema.

## Components
_No components._

## Dependencies
- **depends-on** → [Page-type authoring & registry](architecture:mpzoithh-004r-hd8cmg) — Resolves field-kinds, element decls, upcasters, and FSM `next`.

## Code references
- function `applyOps` in `wiki/src/core/operations.ts`
- function `foldWorkspace` in `wiki/src/core/workspace.ts`
- type `SectionOp` in `wiki/src/api.ts`

## Data model
Operates over `IWorkspaceState` (pages / children / links / version) and, per content event, a `PageState` view aliasing an `IPageNode`'s `sections` (`ISection` → `IField` → `IItem` / `IBlock`); the one author fold-seam is a bounded, meta-scoped `reduceMeta`.

## Usage
`applyWorkspace` is called by the bus (absorb, rebase, dry-run via `applyOps`), by the handle's live tail, and by external read models; `foldWorkspace` backs `openWorkspace` and is exported publicly (`wiki/registry`) for external projections.

## Invariants & constraints
- Total and pure — no clock/RNG; `now` and any ids ride in via the op payload / `ApplyOpsCtx`; equal events fold to equal state.
- `foldWorkspace` asserts `version` contiguity (throws on a gap) but skips events with `version <= fromVersion`, so a coarse-cursor snapshot read stays idempotent.
- Upcasting composes registered `upcasters` from `event.schemaVersion` up to the type's current `version` before the reducer runs; a `schemaVersion` beyond the registered version is a hard `UnknownPageTypeError`.

## Synced commit
e357aa7
