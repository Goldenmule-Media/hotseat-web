# Structured Content — Phase-1 implementation plan

> Status: **Implementation plan** · 2026-06-03 · Owner: @benjamin
> Executes Phase 1 of [`docs/structured-content.md`](./structured-content.md) §12: sections as the
> sole content container, the closed field-kinds (incl. the `blocks` document model §3.1), the
> structural contracts (§6), and the Markdown render **read model** (§8). The `feature` bundle is
> re-authored directly on sections; golden render tests are rewritten. **Greenfield — no data
> migration, no backward compatibility** (§12, §5 "no fields/items").
>
> This is an **all-or-nothing compile**: replacing the content container (`fields`/`items` → typed
> `sections`) changes the shared `IPageNode`/`PageState` shapes that the workspace reducer, command
> bus, structure handlers, render, the `feature` bundle, *and* the SQL projection all depend on, so
> the tree is red from the first edit until the swap is coherently complete. §6 below gives the order
> that minimizes time-to-green and marks the verification gates.

Section numbers below in the form **§N** refer to `docs/structured-content.md` unless a file path is
attached. Engine source line refs are as of the pre-change tree.

---

## 0. Grounding — what exists today (the shape we are replacing)

The change is load-bearing because the following are wired through the *current* content shape:

- `wiki/src/api.ts` — `IPageNode.fields: unknown` + `items: Record<string, IItemRecord[]>`
  (`api.ts:134-148`), `PageState<F>` mirrors them (`api.ts:168-178`); `IPageTypeDef` carries
  `initialFields`, `items`, author `apply` + author `render` (`api.ts:397-425`); `ICommandDef` carries
  `transition` + author `produces` (`api.ts:383-392`).
- `wiki/src/core/workspace.ts` — `STRUCTURAL_EVENT_TYPES` (`:33-45`) routes structural events directly
  and **routes every content event to `def.apply`** (`applyContent`, `:368-388`); `PageCreated`
  materializes `node.items` per `registry.itemTypesOf` and `deepClone(def.initialFields)`
  (`:251-274`); `upcastPayload` chains `def.upcasters` (`:167-184`).
- `wiki/src/core/command-bus.ts` — `decidePage` validates args, runs the page guard + item guard,
  builds `ICommandContext`, then calls **author `cmd.produces`** (`:163-227`); `schemaVersionFor`
  stamps the page-type version on content events (`:361-370`).
- `wiki/src/core/structure.ts` — page-graph handlers (`createPage` recurses `requiredChildren`,
  `:123-183`), `STRUCTURAL_HANDLERS` map (`:414-426`).
- `wiki/src/core/registry.ts` — builds page/item defs, memoizes FSM guards, `fingerprint()`.
- `wiki/src/render/markdown.ts` — `renderPage` **dispatches to `def.render`** (`:87-103`) with a
  generic fallback; `renderWorkspace`; helpers in `render/determinism.ts`.
- `wiki-models/src/feature/*` — four page types authored as `initialFields` + `items` + hand-written
  `apply` + hand-written `render` + `produces` per command.
- `wiki-mcp/src/readmodel/{schema,project}.ts` — `pages.fields`/`pages.items` jsonb columns;
  `project.ts` re-folds with the engine and serializes `node.fields`/`node.items` to jsonb.

Phase 1 removes author `apply`/`render`/`produces`-by-default and the `items` container, replacing all
of it with engine-owned section operations + one built-in reducer + a render read model.

---

## 1. The new TYPE LAYER (`wiki/src/api.ts`)

All of §1 is **types only** (no runtime) — `api.ts` is the leaf every module imports (`api.ts:1-8`).
Add the following, grouped as new sections in the existing file. Keep the existing CQRS / event-sourcing
/ `IWiki` / `IWorkspaceHandle` / `IPageView` / FSM blocks unchanged except where noted in §1.7.

### 1.1 Branded ids (§2)

```ts
export type SectionId = string & { readonly __brand: "SectionId" };
export type BlockId   = string & { readonly __brand: "BlockId" };
```

`PageId`/`WorkspaceId` already branded (`api.ts:14-15`). Section/block/element ids are minted from the
injected `newId()` (§10) — never positional.

### 1.2 Content tree: `ISection`, `IField`, `RefTarget`, `IItem` (§2, §3)

Mirror the spec's `§2` shapes exactly (the spec block is illustrative; this is the normative TS):

```ts
export interface ISection {
  readonly id: SectionId;
  key: string;                         // stable, model-declared; unique among siblings
  name: string;
  description?: string;
  order: number;                       // explicit; never object-key order (§10)
  parentId: SectionId | null;          // intra-page section tree (§2)
  fields: Record<string, IField>;      // keyed by fieldKey
  meta?: Record<string, unknown>;      // typed model-defined aux bag (§9.5)
}

export type FieldKind =
  | "scalar" | "prose" | "code" | "attachment-ref" | "ref" | "blocks" | "list";

export type IField =
  | { readonly kind: "scalar";         value: string | number | boolean }
  | { readonly kind: "prose";          value: string }
  | { readonly kind: "code";           lang: string; source: string; hash: string }
  | { readonly kind: "attachment-ref"; ref: string; mime: string; name: string }
  | { readonly kind: "ref";            target: RefTarget }
  | { readonly kind: "blocks";         blocks: IBlock[] }
  | { readonly kind: "list";           elementType: string; elements: IItem[] };

export type RefTarget =
  | { readonly kind: "section"; id: SectionId }
  | { readonly kind: "page";    id: PageId }
  | { readonly kind: "symbol";  section: SectionId; field: string; name: string }
  | { readonly kind: "block";   section: SectionId; field: string; block: BlockId };

export interface IItem {
  readonly id: string;
  status?: string;
  fields: Record<string, IField>;
  meta?: Record<string, unknown>;
}
```

**Decision:** `IItem` replaces today's loose `IItemRecord` (`api.ts:127-132`). `IItemRecord` is
**retired**; `moveItem` (§1.7) becomes a list-element move keyed by `(section, field, itemId)`. Keep
`IItemRecord` as a deprecated alias for one commit only if the structure handler diff is otherwise too
wide — but the goal is to delete it (the SQL `ItemsJson`, `wiki-mcp/.../schema.ts:34`, goes with it).

### 1.3 Document model: `IBlock`, `IInline`, `Mark` (§3.1, §3.2)

Mirror the spec's `§3.1`/`§3.2` unions verbatim, branding ids as `BlockId`:

```ts
export type IBlock =
  | { readonly kind: "paragraph"; id: BlockId; inlines: IInline[] }
  | { readonly kind: "heading";   id: BlockId; level: 1|2|3|4|5|6; inlines: IInline[] }
  | { readonly kind: "code";      id: BlockId; lang: string; source: string; hash: string }
  | { readonly kind: "list";      id: BlockId; ordered: boolean; items: IBlock[][] }
  | { readonly kind: "table";     id: BlockId; align: ("left"|"center"|"right"|null)[];
                                   header: IInline[][]; rows: IInline[][][] }
  | { readonly kind: "quote";     id: BlockId; variant?: string; blocks: IBlock[] }
  | { readonly kind: "divider";   id: BlockId };

export type IInline =
  | { readonly kind: "text"; value: string; marks: Mark[] }
  | { readonly kind: "code-span"; value: string }
  | { readonly kind: "ref"; target: RefTarget };

export type Mark = "strong" | "emphasis" | { readonly kind: "link"; href: string };
```

### 1.4 The SECTION-OPERATION union (§9.4) — the closed write vocabulary

This is the engine-owned closed vocabulary every command (generated *and* `produces`) emits and the one
built-in reducer folds (§9.4 table). Each op names its target by **key/id**, never by position:

```ts
export type SectionOp =
  // ── field/element edits ──
  | { readonly op: "setField"; section: string; field: string; value: IField }
  | { readonly op: "applyTextEdits"; section: string; field: string; block?: BlockId; edits: TextEdit[] }
  | { readonly op: "addElement"; section: string; field: string; id: string;
      fields: Record<string, IField>; status?: string; meta?: Record<string, unknown> }
  | { readonly op: "removeElement"; section: string; field: string; id: string }
  | { readonly op: "moveElement"; section: string; field: string; id: string; toIndex: number }
  | { readonly op: "setElementField"; section: string; field: string; id: string;
      elementField: string; value: IField }
  // ── block-tree edits (a `blocks` field) ──
  | { readonly op: "addBlock"; section: string; field: string; block: IBlock; index?: number }
  | { readonly op: "removeBlock"; section: string; field: string; block: BlockId }
  | { readonly op: "moveBlock"; section: string; field: string; block: BlockId; toIndex: number }
  | { readonly op: "setBlock"; section: string; field: string; block: IBlock }
  // ── section-tree edits ──
  | { readonly op: "addSection"; key: string; name: string; description?: string;
      parentSection?: SectionId | null; index?: number }
  | { readonly op: "removeSection"; section: string }
  | { readonly op: "moveSection"; section: string; parentSection: SectionId | null; toIndex: number }
  | { readonly op: "renameSection"; section: string; name: string }
  // ── meta ──
  | { readonly op: "setMeta"; section: string; element?: string; path: (string|number)[]; value: unknown }
  // ── FSM ──
  | { readonly op: "transition"; level: "page" | "element"; section?: string; field?: string;
      element?: string; event: string };

export interface TextEdit { readonly start: number; readonly end: number; readonly replacement: string; }
```

Notes:
- `section` in an op is the **section key** (stable, addressable); the reducer resolves key→`ISection`.
  `addSection` mints a fresh `SectionId`; all other ops address an existing section by key.
- `applyTextEdits` reaches both a `code` field and a `code` block (`block?` present) with the **same**
  payload (§3.1, §5) — one op, not N edits.
- `setBlock` replaces a whole block including a paragraph's inline runs (the host computes new runs,
  §9.4 table). `spliceInline` is **deferred** (§6 deferred list / §12).

### 1.5 Event payloads — one engine content event (§9.4)

There are **no per-type events** (§9.4). Content commits carry one engine event type whose payload is an
ordered `SectionOp[]`, plus the originating command name in metadata (§9.4 "records the originating
command in event metadata"):

```ts
export interface SectionOpsAppliedPayload { readonly ops: SectionOp[]; }
// event type tag: "SectionOpsApplied"; meta.command carries the semantic command name.
```

Extend `IEventMeta` (`api.ts:89-97`) with `readonly command?: string;` so `history()` stays semantic
(`answerQuestion`) without per-type events.

### 1.6 Declarative authoring interfaces (§9) — the new `IPageTypeDef`

Author `apply`, `render`, and the default `produces` are **removed** (§9). The page type now declares
*structure, legality, presentation* only. Replace `api.ts:382-446` with:

```ts
// ── field declarations (the model's view of a field-kind) ──
export type FieldDecl =
  | { readonly kind: "scalar"; required?: boolean; schema?: ISchema }
  | { readonly kind: "prose"; required?: boolean }
  | { readonly kind: "code"; required?: boolean }
  | { readonly kind: "attachment-ref"; required?: boolean }
  | { readonly kind: "ref"; required?: boolean; targetKinds?: RefTarget["kind"][] }
  | { readonly kind: "blocks"; required?: boolean }
  | { readonly kind: "list"; element: string; ordered?: boolean; required?: boolean };

export interface SectionDecl {
  readonly name: string;
  readonly description?: string;
  readonly required?: boolean;                  // requiredSection (§6) — materialized empty at create
  readonly mutableIn?: readonly string[];       // the write-gate (§6/§9.2)
  readonly fields: Readonly<Record<string, FieldDecl>>;
  readonly meta?: ISchema;                       // §9.5 meta-bag schema
  readonly reduceMeta?: (meta: unknown, op: SectionOp) => unknown;  // §9.5 accumulated; pure, meta-scoped
  readonly deriveMeta?: (section: DeepReadonly<ISection>) => unknown; // §9.5 derived; read-side
  readonly sections?: Readonly<Record<string, SectionDecl>>;        // nested subsections (§2 nesting)
}

export interface ElementDecl {
  readonly fields: Readonly<Record<string, FieldDecl>>;
  readonly status?: { readonly initial: string; readonly transitions: readonly ITransition[] };
  readonly meta?: ISchema;
  readonly reduceMeta?: (meta: unknown, op: SectionOp) => unknown;
}

// ── section-set contract (§6) ──
export interface SectionSetContract {
  readonly mode: "open" | "closed";              // closed: only declared sections (§6)
  readonly prohibited?: readonly string[];       // SHACL-style prohibited keys
  readonly cardinality?: Readonly<Record<string, { min?: number; max?: number }>>;
}

// ── declarative commands (§9.4) ──
export type ArgRef = { readonly __arg: string };            // arg("name") sugar (§9.8 open Q resolved minimally)
export type FieldValueSpec = ArgRef | { readonly literal: IField };

export interface DeclarativeCommand {
  readonly args: ISchema;
  readonly result?: ISchema;
  readonly description?: string;
  readonly target?: { section: string; element?: { idArg: string }; field?: string };
  readonly set?: Readonly<Record<string, FieldValueSpec>>;  // args→field mapping
  readonly transition?:
    | { readonly level: "page"; readonly event: string }
    | { readonly level: "element"; readonly event: string };
  readonly preconditions?: readonly Precondition[];          // §6 transition preconditions
  // escape hatch (§9.4): compute the effect; returns the SAME closed op vocabulary.
  readonly produces?: (page: DeepReadonly<PageState>, args: unknown, ctx: ICommandContext) => SectionOp[];
}

export type Precondition =
  (page: DeepReadonly<PageState>, related: IRelatedReader) => true | { readonly unmet: string };

export type DeclarativeCommandMap = Readonly<Record<string, DeclarativeCommand>>;
```

`PageState` (§1.7) now exposes `sections: ISection[]` instead of `fields`/`items`. The new
`IPageTypeDef`:

```ts
export interface IPageTypeDef<Status extends string = string> {
  readonly type: string;
  readonly version: number;
  readonly initialStatus: Status;
  readonly statusTransitions: readonly ITransition<Status, string>[];   // lifecycle ONLY (§9.4)
  readonly sections: Readonly<Record<string, SectionDecl>>;             // §9.2
  readonly elements?: Readonly<Record<string, ElementDecl>>;            // §9.3
  readonly sectionSet?: SectionSetContract;                            // §6
  readonly requiredChildren?: readonly string[];                       // unchanged page-graph contract
  readonly commands: DeclarativeCommandMap;                            // §9.4
  readonly render: RenderConfig;                                       // §9.7 (replaces author render)
  readonly upcasters?: Readonly<Record<number, (payload: unknown) => unknown>>; // §10 — over SectionOp payloads
}
```

`initialFields`, `items`, `apply`, `render`-fn are **gone**. `IPageType` stays the `{ __def }` wrapper
but loses its `State`/`Ev`/`Cmds` reducer-shaped generics (only `Status` remains useful). `IItemTypeDef`
is **removed** — element FSMs live inline in `ElementDecl.status` (§9.3); keep `defineItemType` only as a
thin shim re-expressing a standalone element decl if any consumer needs it, else delete (§3).

### 1.7 Render config types (§9.7)

```ts
export interface RenderConfig {
  readonly title?: string;                       // "Feature: {title}" — {title} is the page title
  readonly sections: readonly SectionRender[];
}

export interface SectionRender {
  readonly section: string;
  readonly heading?: string;
  readonly placeholder?: string;
  readonly field?: string;                        // which field of the section to render as the body
  readonly as?: "block" | "inline" | "fenced" | "link" | "bullets" | "numbered" | "table" | "blocks";
  readonly item?: string;                         // element template, e.g. "{text}" / "{field?}"
  readonly groupBy?: string;                      // e.g. "status"
  readonly groups?: readonly { when: string; heading?: string; item: string }[];
}
```

Render config is **declarative and logic-free** (§9.7): no expressions; `{field}` / `{field?}` only.
Anything that needs computing is materialized into a field by a command, never computed at render time
(§9.7, §10).

### 1.8 `PageState`, `IPageNode`, `IWorkspaceState` (§2)

- `IPageNode` (`api.ts:134-148`): replace `fields: unknown` + `items: Record<string, IItemRecord[]>`
  with `sections: ISection[]`. Keep `id/type/parentId/title/status/pinned/createdAt/updatedAt`.
- `PageState` (`api.ts:168-178`): drop `<F>` generic; replace `fields`/`items` with `sections: ISection[]`.
- `IWorkspaceState` unchanged (the section tree lives *inside* a page node, introduces no new stream or
  consistency boundary, §2).

### 1.9 `IWorkspaceHandle` / `IPageView` surface deltas (§1.7-ish public surface)

- `IWorkspaceHandle.moveItem(...)` (`api.ts:274`) → `moveElement({ from, to, section, field, itemId })`
  (cross-page list-element move; the `moveItem` precedent rides one atomic append, §5). Keep the method
  name `moveItem` if churn matters, but its args become section-addressed.
- `mutate(pageId, command, args)` is unchanged in signature; its *implementation* now goes through the
  declarative command path (§2.4).
- `IPageView.state()` returns `DeepReadonly<PageState>` whose `sections` are now the typed tree.
- `IMutationDescriptor` (`api.ts:301-308`): add `readonly target?: { section: string; field?: string }`
  so `describeMutations` reports which section a command edits (§6 write-gate surfacing).

### 1.10 Public surface (`index.ts` / `authoring.ts` / `registry`)

- `wiki/src/index.ts`: export the new types — `SectionId`, `BlockId`, `ISection`, `IField`,
  `FieldKind`, `RefTarget`, `IItem`, `IBlock`, `IInline`, `Mark`, `SectionOp`, `TextEdit`,
  `SectionDecl`, `FieldDecl`, `ElementDecl`, `SectionSetContract`, `DeclarativeCommand`,
  `DeclarativeCommandMap`, `Precondition`, `RenderConfig`, `SectionRender`, `IPageTypeDef`, `IPageType`.
  **Remove** `IItemRecord`, `CommandMap`, `ICommandDef`, `IItemTypeDef`, `IItemType` from the barrel.
  Keep `foldWorkspace`/`applyWorkspace`/token codec/`ROOT` exports (still public, §8.6).
- `wiki/src/authoring.ts`: continue to re-export `definePageType`/`t`/`zodSchema`/`z`, **drop the
  determinism render helpers re-export** (§9: authors no longer write `render`; the render read model
  owns those helpers internally). Add a small `arg()` helper (`(name) => ({ __arg: name })`) and re-export
  `InvariantViolationError`. Keep `export type * from "./api"`.
- `wiki/registry` subpath (re-exports `Registry`) unchanged in path; its validated declarations grow
  (§2.6).

---

## 2. Engine changes — file by file, in order

Each step lists **what it does** and **what it depends on** (earlier steps). Steps 2.1→2.8 are one
coherent change set; the compile only goes green after the `feature` bundle (§3) and `wiki-mcp`
projection (§4) are converted too — see §6 sequencing.

### 2.1 `wiki/src/core/operations.ts` (NEW) — the built-in reducer over section operations

**Depends on:** §1.2-1.6 types.

The single engine-owned reducer that folds a `SectionOp[]` into a page's `sections` tree. This replaces
every author `apply`. One pure, total function:

```ts
export function applyOps(page: PageState, ops: readonly SectionOp[], ctx: { now: string }): void
```

- Resolves section keys → `ISection` (and element ids, block ids within).
- Implements each op in §1.4: `setField`/`setElementField` (replace the typed `IField`),
  `addElement`/`removeElement`/`moveElement` (splice the `list` field's `elements` by id/index),
  `applyTextEdits` (pure string replay over `code.source`, recompute `hash`, sort edits descending by
  `start` so offsets stay valid; reach a `code` block when `block` is set),
  `addBlock`/`removeBlock`/`moveBlock`/`setBlock` (splice the `blocks` field's array by id/index),
  `addSection`/`removeSection`/`moveSection`/`renameSection` (delegates the tree mechanics to
  `structure.ts` §2.3 helpers so the acyclic/order/unique-key invariants are shared),
  `setMeta` (write into the section/element `meta` bag at `path`; if the owning decl declares
  `reduceMeta`, route **every** op through it as the **single writer**, §9.5), and
  `transition` (page status via the page guard / element status via the element guard — the legality is
  already checked at decide time §2.4; here we just write the resulting status).
- Bumps `page.updatedAt = ctx.now` once per commit.
- **No clock/RNG** — `now` and any ids ride in via the op payload / ctx (stamped at produce time, §10).

A thin `applyMeta(decl, meta, op)` helper enforces the §9.5 guardrails: `reduceMeta` may read the op +
section but write **only** the meta bag; it is pure and total; its result is the next meta. Same code is
re-runnable by the external read-model fold (§4) since it lives behind the public fold.

### 2.2 `wiki/src/core/workspace.ts` — route content events to the built-in reducer

**Depends on:** §2.1.

- `STRUCTURAL_EVENT_TYPES` (`:33-45`): **remove** `ItemAdded`/`ItemRemoved` (list-element moves now ride
  the engine content event, §1.9). Keep the page-graph events.
- Add `"SectionOpsApplied"` as the **single content event type**. `applyContent` (`:368-388`) no longer
  calls `def.apply`; it upcasts the payload (still via `upcastPayload`, now over `SectionOp[]`), then
  calls `applyOps(pageStateView(node), payload.ops, { now: event.meta.occurredAt })`. There is exactly
  **one** content code path; per-type reducers are gone.
- `PageCreated` (`:251-274`): replace item/field materialization. Build `node.sections` by
  **auto-materializing required sections empty** from the page type's `sections` decl where
  `required === true` (§6, keyed by declared keys, no id churn — but each still needs an engine-minted
  `SectionId` from `event.payload`; see §2.4 for how `createPage` pre-mints them so the reducer stays
  id-free). Non-required sections are absent until `addSection`. Element FSMs/initial fields come from
  the decl when an `addElement` runs, not at create.
- `pageStateView`/`writeBack` (`:106-128`): swap `fields`/`items` for `sections`.
- `upcastPayload` (`:167-184`): unchanged mechanism; now the chained upcasters reshape `SectionOp`
  payloads (§10, §2.8).

### 2.3 `wiki/src/core/structure.ts` — section-tree ops + invariants (intra-page)

**Depends on:** §2.1 (called by the reducer) and §1 types.

Add a `section-structure` helper module (either here or a sibling `core/section-structure.ts`) reused by
`applyOps`'s `addSection`/`moveSection`/`removeSection`/`renameSection` and by the well-formedness/
contract checks (§2.4):

- **Invariants (intra-page, mirroring the page-tree rules, §2 "reusing the page-tree acyclic/ordering
  invariants"):** unique sibling `key` (the intra-page analogue of `assertUniqueSiblingTitle`,
  `structure.ts:83-96`), acyclic section tree (analogue of `isSelfOrDescendant`, `:98-112`), explicit
  `order` maintained on insert/move (never object-key order, §10).
- **Contract checks:** required sections cannot be removed or reordered out (§6); section-set mode
  (`open`/`closed`), `prohibited`, and `min/maxCount` cardinality enforced on `addSection`/`removeSection`
  (§6). A closed type rejects an undeclared `addSection` key.
- The page-graph handlers (`createPage`/`reparent`/…) stay; `createPage` (`:123-183`) additionally
  pre-mints `SectionId`s for the required sections so `PageCreated`'s payload carries them (keeps the
  reducer id-free, §10). `moveItem` (`:368-394`) is rewritten as a **cross-page list-element move**:
  it emits one `SectionOpsApplied` on `from` (`removeElement`) and one on `to` (`addElement`) in one
  atomic batch (the existing two-event atomic precedent, `:388-393`).

New typed errors in `core/errors.ts` (mirror the existing hierarchy, `errors.ts:6-16`):
`SectionNotFoundError`, `DuplicateSectionKeyError`, `SectionContractError` (closed-set/cardinality/
prohibited/required-removal), `FieldKindError` (ingestion §2.5), `RefIntegrityError` (§2.5),
`BlockNormalFormError` (§2.5). Export them from `index.ts` alongside the existing errors
(`index.ts:95-112`).

### 2.4 `wiki/src/core/command-bus.ts` — declarative execution, generated commands, gates, well-formedness

**Depends on:** §2.1, §2.2, §2.3, §2.5 (validators), §2.6 (registry).

`decidePage` (`:163-227`) is rewritten around the declarative command model. The new pipeline per
command, all inside the rebase-retried decide window (so every check re-runs on OCC rebase, §6):

1. **Resolve the command** — either a *generated structural command* (from a section/field decl) or a
   *declared command* (§9.4). The registry exposes both (§2.6). Unknown command → `MutationNotAllowed`
   listing the legal set (`:179-186` pattern preserved).
2. **Validate args** via `cmd.args.parse` (unchanged seam, `:189`).
3. **FSM legality** — the page guard `can(status, command)` for page-level; for an element-targeted
   command, resolve the target element and check the **element guard** (the renamed item guard, §2.6),
   mirroring `:202-220`.
4. **Write-gate (`mutableIn`, §6)** — the target section's `mutableIn` must include the current page
   status, else `MutationNotAllowed`. This is the §6 write-gate, evaluated alongside FSM legality.
5. **Build effect** — for a declarative command, synthesize the `SectionOp[]` from `target` + `set`
   (args→field via `arg()`) + `transition`; for the escape hatch, call `cmd.produces(view, args, ctx)`
   → `SectionOp[]` (the same closed vocabulary, §9.4). For a generated command, the op is the obvious
   single `setField`/`addElement`/`removeElement`/`moveElement`/`setElementField`.
6. **Preconditions (§6)** — run each `Precondition(view, related)`; first `{ unmet }` →
   `InvariantViolationError` (or a new `PreconditionUnmetError`) naming the obligation. Replaces the
   hand-coded `beginImplementation`/`ship` prologues (`feature-brief.ts:416-500`).
7. **Well-formedness check (§6, §7)** — *dry-run* `applyOps` against a `structuredClone` of the page,
   then validate the resulting sections: required-field presence (transition-scoped — only when a
   command carries a `transition`, never at create, §6 exist-vs-filled), field-kind grammar + ref
   integrity + block normal form (§2.5). On failure throw before producing events; on success emit one
   `SectionOpsApplied{ ops }` with `meta.command = req.command`.

`buildContext` (`:229-254`) keeps `related`/`newId`/`now`. `schemaVersionFor` (`:361-370`): the single
content event `SectionOpsApplied` is stamped with the owning page type's current `version` (the
upcaster chain reshapes ops, §10); structural events stay `0`.

`describeMutations` data: the bus/registry now enumerate **generated + declared** commands with their
`target` section, surfaced through `IMutationDescriptor.target` (§1.9). `availableMutations` combines
FSM legality (lifecycle commands) with `mutableIn` (content commands) per current status.

### 2.5 `wiki/src/core/ingestion.ts` (NEW) — field-kind grammar, ref integrity, block normal form

**Depends on:** §1.2-1.4 types; called by §2.4 step 7 and reused by the external read-model fold's
well-formedness (best-effort) check.

Pure, deterministic, engine-owned validators (§7). All operate on the *resulting* state, never on
meaning:

- **Field-kind grammar:** `scalar` is string/number/boolean; `prose` is a string that **rejects fenced
  ```` ``` ```` code** (regex for a fence line) — code must use a `code` field (§7); `code` requires a
  non-empty `lang` tag; `attachment-ref` requires `ref`/`mime`/`name`; `ref` target must resolve (§ below);
  `list` elements all match the declared `elementType`; unknown `kind` rejected (`FieldKindError`).
- **The no-markdown-in-text-leaf rule (§3.3, §7):** a `blocks` field's `text` run may **not** contain
  Markdown syntax — reject a fence, a backtick, `*`/`_` emphasis, `[..](..)` link, or a leading `#`
  (`BlockNormalFormError`). The structure must be reified as a `code-span`, a `mark`, or a `ref`. This
  rejection is the enforced line between structured and opaque rich text (§3.3).
- **Block normal form (§10):** block/inline tags within the closed vocabulary; array order is the render
  order; adjacent `text` runs with equal marks **merged**; marks **canonical-sorted** (a fixed total
  order: `emphasis` < `strong` < `link(href)` by href); table cells inline-only and rectangular
  (`header.length === align.length`, every row same width). Normalization happens **at ingestion** so
  render is a pure identity projection (§10) — `applyOps` normalizes on `addBlock`/`setBlock`, the
  validator asserts the invariant.
- **Ref integrity (§7):** the `RefTarget` must resolve in the current workspace state — `section`→an
  existing `SectionId` on the page; `page`→an existing `PageId`; `symbol`/`block`→an existing
  `(section, field, …)`. The integrity walk **recurses into block and inline trees** so an inline `ref`
  can never dangle (`RefIntegrityError`). Same-workspace only (cross-workspace refs are reported, not
  silently created — §5/§7, deferred beyond Phase 1).

`hash` for `code` is computed here/in `applyOps` via a tiny pure content hash (FNV-1a/djb2 over the
source — **dependency-free**, §10/§13; never a crypto import). Deterministic, read-model optimization
only (§4).

### 2.6 `wiki/src/core/registry.ts` — validate declarations + expose generated commands

**Depends on:** §1.6 types.

`Registry` (`:15-98`) gains, validated **mechanically in the constructor** (§6, §9.6 "keys resolve,
kinds are known, predicates are callable"):

- **Section/field decls:** every declared field-kind is known; `list` `element` resolves to a declared
  `ElementDecl`; `required`/`mutableIn` reference valid statuses; nested `sections` recurse; the
  `sectionSet` contract's `prohibited`/`cardinality` keys resolve. Throw `ValidationError` on any miss
  (mirrors the existing constructor build, `:27-40`).
- **Generated structural commands:** derive, per section/field, the CRUD command set (`set<Field>`,
  `add<Element>`/`remove<Element>`/`move<Element>`, `set<Element><Field>`) with a stable derived name
  (§9.8 open Q — pick a deterministic scheme, e.g. `<verb><SectionKey><FieldKey>` camelCased; record it
  for `describeMutations`). Memoize them keyed by page type. The bus (§2.4) looks up declared first,
  then generated.
- **Element guards:** rename `itemGuard`/`item`/`itemTypesOf` to `elementGuard`/`element`/`elementsOf`,
  built from `ElementDecl.status` (§9.3) instead of `IItemTypeDef.statusTransitions`. Page guards from
  `statusTransitions` unchanged (`:54-62`).
- **Required sections:** expose `requiredSectionsOf(type)` (keys + decls) for `PageCreated` (§2.2).
- `fingerprint()` (`:92-97`) unchanged in mechanism (`type@version`), still drives snapshot/read-model
  invalidation — bump every converted type's `version` only if its on-disk op-payload shape changes
  (greenfield: just keep `version: 1`).

`core/define.ts` (`define.ts:22-47`): `definePageType` keeps light shape validation (non-empty `type`),
plus now asserts `sections`/`commands`/`render` are present. `defineItemType` removed or shimmed (§1.6).
`registry`-time validation does the heavy lifting (the existing split, `define.ts:1-9`).

### 2.7 `wiki/src/render/` — the configurable Markdown render READ MODEL (§8)

**Depends on:** §1.2-1.4, §1.7 types; §2.6 registry.

Render becomes a read model driven by static `RenderConfig` (§8). The per-type `render` function is
**retired** (§8).

- **Replace `render/markdown.ts`** with `render/read-model.ts`: `renderPage(state, pageId, registry)`
  reads the page type's `RenderConfig`, walks `node.sections` in **render-config order** (falling back
  to section `order`), and for each `SectionRender` dispatches on the target field's **field-kind** to a
  per-kind default renderer (§9.7 directive table):
  `scalar`→inline, `prose`→block, `code`→fenced verbatim, `attachment-ref`→link, `ref`→**render-derived
  label** (resolve the target and emit its section number / page title / symbol name — §3/§3.2; this is
  the projection that makes reorders/renames update automatically), `list`→`bullets`|`numbered`|`table`|
  grouped (template substitution `{field}`/`{field?}`, §9.7), `blocks`→a **fixed per-kind block/inline
  walk** (`as: blocks`, §3.1) with no per-block config.
- **Block/inline renderer** (`render/blocks.ts`, NEW): the fixed normal-form walk (§10) — paragraphs
  concatenate runs; `heading` block → `#`×level (intra-section, **not** the outline, §3.1); `code`
  block fences verbatim (same machinery as a `code` field); `list`→tight bullets/`1.`; `table`→GFM pipe
  table with deterministic cell escaping; `quote`→`> ` with `variant`; `divider`→`---`. Inline: `text`
  with canonical-sorted marks (fixed delimiters `**`/`_`, links `[..](..)`), `code-span`→`` `..` ``,
  `ref`→render-derived label. Pure identity projection; **no Markdown formatter ever runs** (§10).
- Keep `render/determinism.ts` (`joinBlocks`/`heading`/`section`/`bulletList`/`numbered`/`stableBy`/
  `placeholder`/`statusBadge`) — the read model uses these internally. `stableBy` (`:87`) backs explicit
  ordering (§10). These are now **engine-internal**, no longer re-exported from `authoring` (§1.10).
- `renderWorkspace` (`markdown.ts:206-228`) stays (tree of headings), repointed at the new module.
- The render context (`IRenderCtx`, `markdown.ts:45-74`) survives for cross-page label resolution
  (`titleOf` for a `ref` to a page, links section). Add a section-number resolver to support
  `ref`-derived labels.

`core/wiki.ts` imports (`wiki.ts:39`) repoint `renderPage`/`renderWorkspace` to the new module; the
`renderPageMarkdown`/`toMarkdown` paths (`wiki.ts:471-535`) are otherwise unchanged (render stays a pure
read over the projection, §8).

### 2.8 Schema evolution — upcasters over `SectionOp` payloads (§10)

**Depends on:** §2.2.

The `schemaVersion` + `upcasters` mechanism is **unchanged in shape** (`workspace.ts:167-184`,
`api.ts:411-412`): a content event's `SectionOpsApplied` payload is upcast by chaining the page type's
`upcasters` from `event.schemaVersion` to current. Phase 1 is greenfield so no upcaster is *written*,
but the seam now reshapes **section/field/block payloads** rather than per-type event payloads (§10
"a change is a pure payload reshape"). Document this in `wiki/BUILD_NOTES.md` §8.5 when touched.

---

## 3. `wiki-models` rewrite — the `feature` bundle, declaratively

**Depends on:** §1 (authoring types), §2.6 (registry validation), §2.7 (render config).

All four page types lose `initialFields`/`items`/`apply`/`render`/per-command `produces` and are
re-expressed declaratively. The bundle imports from `wiki/authoring` only (extensionless, source-
consumed — `feature-brief.ts:14-34` style preserved).

### 3.1 `feature-brief.ts`

Sections replace fields+items. The §13.5 golden layout maps to:

```ts
definePageType({
  type: "feature-brief", version: 1, initialStatus: "draft",
  statusTransitions: [
    t("draft","beginPlanning","planning"), t("planning","beginImplementation","building"),
    t("building","reopenPlanning","planning"), t("building","submitForReview","review"),
    t("review","requestChanges","building"), t("review","ship","shipped"),
    t("draft","abandon","abandoned"), /* …abandon from each non-terminal status… */
  ], // lifecycle ONLY (§9.4) — content-edit legality is in `mutableIn`, not here
  sections: {
    summary:     { name: "Summary", required: true, mutableIn: ["draft","planning"],
                   fields: { body: { kind: "prose", required: true } } },
    components:  { name: "Components affected", mutableIn: ["draft","planning","building"],
                   fields: { items: { kind: "list", element: "component" } } },
    constraints: { name: "Design constraints", mutableIn: ["draft","planning","building"],
                   fields: { items: { kind: "list", element: "constraint", ordered: true } } },
    questions:   { name: "Questions", mutableIn: ["draft","planning","building","review"],
                   fields: { items: { kind: "list", element: "question" } } },
    commits:     { name: "Commits", mutableIn: ["building","review"],
                   fields: { items: { kind: "list", element: "commit" } } },
  },
  elements: {
    component:  { fields: { name: { kind: "scalar", required: true } } },
    constraint: { fields: { text: { kind: "prose", required: true } } },
    question:   { fields: { text: { kind: "prose", required: true }, answer: { kind: "prose" } },
                  status: { initial: "open", transitions: [ t("open","answer","resolved") ] } },
    commit:     { fields: { sha: { kind: "scalar", required: true },
                            message: { kind: "scalar", required: true },
                            url: { kind: "scalar" } } },
  },
  sectionSet: { mode: "closed" },                 // a feature-brief is effectively closed (§6)
  requiredChildren: ["implementation-plan","implementation-checklist","testing-plan"],
  commands: {
    // declarative content commands (generated CRUD also exists; these are the named ones)
    setSummary:   { args: z.object({ text: z.string() }),
                    target: { section: "summary", field: "body" }, set: { body: arg("text") } },
    addComponent: { args: z.object({ name: z.string() }), result: z.object({ componentId: z.string() }),
                    target: { section: "components", field: "items" }, set: { name: arg("name") } },
    askQuestion:  { args: z.object({ text: z.string() }), result: z.object({ questionId: z.string() }),
                    target: { section: "questions", field: "items" }, set: { text: arg("text") } },
    answerQuestion: { args: z.object({ questionId: z.string(), answer: z.string() }),
                    target: { section: "questions", field: "items", element: { idArg: "questionId" } },
                    set: { answer: arg("answer") }, transition: { level: "element", event: "answer" } },
    recordCommit: { args: z.object({ sha: z.string(), message: z.string(), url: z.string().optional() }),
                    target: { section: "commits", field: "items" },
                    set: { sha: arg("sha"), message: arg("message"), url: arg("url") } },
    // lifecycle gates — no effect, just guarded transitions + preconditions (§6)
    beginPlanning:       { args: z.object({}), transition: { level: "page", event: "beginPlanning" } },
    beginImplementation: { args: z.object({}), transition: { level: "page", event: "beginImplementation" },
                           preconditions: [ planHasStep, testPlanHasCase ] },
    submitForReview:     { args: z.object({}), transition: { level: "page", event: "submitForReview" } },
    reopenPlanning:      { args: z.object({}), transition: { level: "page", event: "reopenPlanning" } },
    requestChanges:      { args: z.object({}), transition: { level: "page", event: "requestChanges" } },
    ship:                { args: z.object({}), transition: { level: "page", event: "ship" },
                           preconditions: [ checklistComplete, allCasesPassed, noOpenQuestions ] },
    abandon:             { args: z.object({}), transition: { level: "page", event: "abandon" } },
  },
  render: {
    title: "Feature: {title}",
    sections: [
      { section: "summary",     heading: "Summary",            field: "body", as: "block",
        placeholder: "_None._" },
      { section: "components",  heading: "Components affected", field: "items", as: "bullets",
        item: "{name}" },
      { section: "constraints", heading: "Design constraints",  field: "items", as: "numbered",
        item: "{text}" },
      { section: "questions",   heading: "Questions",           field: "items", groupBy: "status",
        groups: [ { when: "open",     heading: "Open questions",     item: "**{text}**" },
                  { when: "resolved", heading: "Resolved questions", item: "**{text}** → {answer}" } ] },
      { section: "commits",     heading: "Commits",             field: "items", as: "bullets",
        item: "`{sha}` {message}" },
    ],
  },
})
```

`planHasStep`/`testPlanHasCase`/`checklistComplete`/`allCasesPassed`/`noOpenQuestions` are pure
`Precondition`s reading siblings via `related` (the §6 declarative form of the old gates,
`feature-brief.ts:416-500`); they return `{ unmet }` instead of throwing. **Note** the render-test
golden has *References* + *Child pages* sections (`render.test.ts:108-115`) that come from links/tree,
not page content — these are emitted by the render read model's workspace context (§2.7), configured (or
defaulted) per type; preserve them so the golden still matches (see §5).

### 3.2 `implementation-plan.ts`, `implementation-checklist.ts`, `testing-plan.ts`

Same transformation: `steps`/`tasks`/`cases`/`questions` become `list` sections with element decls
(`step`, `task` with `todo⇄done`, `case` with `planned→passed/failed`, `question`); the old `apply`/
`render`/`produces` (e.g. `implementation-plan.ts:24-177`) collapse into `sections`/`elements`/declarative
`commands`/`render` config. The `reorderSteps` command becomes a generated `moveElement` (or a small
declarative command emitting `moveElement`). `items.ts` (`items.ts:1-45`) is **deleted** — element types
now live inline in each page type's `elements` (§9.3); the bundle `index.ts` (`index.ts:9`) drops the
`question, task, …` re-exports.

### 3.3 What the new authoring calls look like

- No `apply`, no `render` function, no `produces` for the common case (args→field).
- `arg("name")` maps a command arg to a field value; `target` names the `(section, field[, element])`.
- Element FSMs are inline `status: { initial, transitions: [t(...)] }`.
- Preconditions are pure `(page, related) => true | { unmet }`.
- Render is the static config object — no code.

---

## 4. `wiki-mcp` projection changes

**Depends on:** §1 types, §2.2 (the engine fold the projection reuses).

The read model re-folds with the engine's **public** `foldWorkspace` (`project.ts:16-19,157`), so it
inherits the new section model for free; the only owned mapping is state→rows (`project.ts:1-15`).

### 4.1 SQL schema (`wiki-mcp/src/readmodel/schema.ts`)

- `PagesTable` (`schema.ts:51-64`): **replace** `fields`/`items` jsonb columns with a single
  `sections` jsonb column (`JSONColumnType<JsonObject>`), serialized from `node.sections`. Remove
  `ItemsJson` (`schema.ts:34`). Add a **new migration** `002-sections.ts` alongside
  `migrations/001-initial.ts` that drops `fields`/`items`, adds `sections`, and creates the three index
  tables below (mirror the existing migration/index pattern, `migrations/index.ts`).
- **New projector tables** (read-side projections over the folded sections, §11):
  - `outline(workspace_id, page_id, section_id, parent_section_id, key, name, ord)` — the section
    names/tree straight from folded state (§11 outline). Phase-1 deliverable (no parser needed).
  - `symbol_index(workspace_id, page_id, section_id, field, block_id, lang, source_hash)` — **stub**:
    populated only with the *canonical source location* of every `code` field/block (no parsing); the
    `name/kind/range` columns are nullable and filled in **Phase 3** via the `LanguageRegistry`
    (§11, §12). This establishes the table + projector shape now.
  - `xref_index(workspace_id, from_page, from_section, from_field, target_kind, target_*)` — the
    cross-reference index: every `ref` field and inline `ref` target, harvested by **recursing into
    block/inline trees** (§7), so refs are queryable and integrity is re-checkable read-side.

### 4.2 Projector (`wiki-mcp/src/readmodel/project.ts`)

- `pageRows` (`:42-60`): serialize `node.sections` → the `sections` column; drop `fields`/`items`.
- Add `outlineRows(state)`, `symbolRows(state)`, `xrefRows(state)` builders (pure walks of
  `node.sections`, recursing the section tree and — for xref — into `blocks`/inline runs). Insert them
  in the same per-workspace transaction as `pageRows`/`treeEdgeRows`/`linkRows` (`:168-210`), with the
  same delete-then-insert replace strategy (`:172-174`).
- The applied-version/offset bookkeeping (`:142-213`) is unchanged — the projection still re-folds full
  history and advances `applied_version` atomically.

### 4.3 LanguageRegistry hook (stubbed for Phase 1)

Add a `wiki-mcp/src/models/language-registry.ts` **stub** that mirrors the `ModelRegistry` dynamic-import
pattern (§4, §11, ADR-M6): a registry with `register(id, specifier)` / `get(lang)` returning an
`ILanguageAnalyzer | undefined`, plus the `ILanguageAnalyzer` interface (`parse/symbols/references/
rename`). In Phase 1 it loads **no** analyzers; the symbol-index projector calls
`languageRegistry.get(lang)` and, finding none, records only the canonical source location (§4.1). This
is the seam Phase 2/3 fill (§12). No parser dependency enters `wiki-mcp` in Phase 1.

`wiki-mcp/src/mcp/*` read tools that today surface `fields`/`items` now read `sections`; `outline` and a
read-only `references` tool can be wired off the new tables (Phase-2-facing, optional in Phase 1).

---

## 5. Test rewrite

**Depends on:** §2, §3 complete.

The content-model swap changes the shared `PageState`/event shapes, so **every** `wiki/test/*` that
hand-builds events or asserts golden Markdown changes. Order: get the engine-pure tests green first
(reducer/structure), then the integration goldens.

### 5.1 `wiki/test/reducer.test.ts`

Rewrite the hand-built envelope lists (`reducer.test.ts:47-60`): content events become a single
`SectionOpsApplied` carrying `SectionOp[]` (e.g. `setField` on `summary.body`, `addElement` on
`components.items`). Assert the folded `node.sections` tree (keys, field-kinds, element fields, statuses)
instead of `node.fields`/`node.items`. Keep the contiguity-gap and upcast tests (now over a
`SectionOpsApplied` payload, §2.8).

### 5.2 `wiki/test/structure.test.ts`

Keep the page-graph cases (reparent cycle, duplicate sibling title, link integrity). **Add**
section-tree cases (new file `section-structure.test.ts` or extend this one): unique sibling `key`,
acyclic section tree, closed-set rejection, cardinality min/max, required-section non-removal (§6). The
`moveItem` atomicity case becomes a **cross-page list-element move** (`removeElement`+`addElement` in one
batch, or neither, §2.3).

### 5.3 `wiki/test/reducer`/new `operations.test.ts` (NEW)

Direct unit tests of `applyOps` (§2.1): each op in isolation (setField/add/remove/moveElement/
setElementField/applyTextEdits/add-remove-move-setBlock/setMeta/transition); `applyTextEdits` replay
correctness + `hash` recompute + descending-offset application; `reduceMeta` single-writer behavior
(§9.5). Ingestion validators (§2.5) get `ingestion.test.ts` (NEW): prose-rejects-fence, code-needs-lang,
ref-integrity (incl. dangling **inline** ref deep in a block tree), the no-markdown-in-text-leaf rule,
block normal form (adjacent same-mark text merged, marks canonical-sorted, rectangular tables).

### 5.4 Determinism tests for blocks/refs (NEW `blocks.test.ts`)

Per §10: a `blocks` field renders byte-identically across repeated renders; `strong(em x)` and
`em(strong x)` fold to the **same** canonical-sorted marks and render identically; array-ordered
blocks/runs (never object-key order); a `ref`-derived label updates when its target is renamed/reordered
(the inline-`ref` payoff, §3.2). Golden snapshots for each block kind (paragraph/heading/code/list/
table/quote/divider).

### 5.5 `wiki/test/render.test.ts` — new golden expectations

The §13.5 golden (`render.test.ts:89-120`) is re-derived from the **render read model + render config**
(§2.7, §3.1), not an author `render`. Target the **same bytes** where the layout is unchanged
(Summary / Components affected / Design constraints / Open+Resolved questions / References / Child pages /
Commits) so the conversion is provably faithful; where the new section model legitimately changes a label
(e.g. a "Questions" parent heading vs. the flat Open/Resolved split), update the golden and note why. The
build script (`render.test.ts:25-87`) is rewritten to drive the **new declarative commands** (same names:
`setSummary`/`addComponent`/`askQuestion`/`answerQuestion`/`recordCommit`/`beginPlanning`/…). The
byte-stability and cross-wiki-equality assertions (`:165-193`) are unchanged in intent.

### 5.6 `wiki/test/worked-example.test.ts`, `llm-shape.test.ts`, `consistency.test.ts`, `concurrency.test.ts`, `snapshot.test.ts`, `guard.test.ts`

- **worked-example**: same end-to-end script, new declarative commands; the `beginImplementation`/`ship`
  gates now fail via **preconditions** (§6) — assert the typed precondition/invariant error
  (`worked-example.test.ts:1-26` intent preserved). The cross-page move is the new `moveElement`.
- **llm-shape**: `availableMutations`/`describeMutations` now include **generated** structural commands
  plus declared ones, with `target` (§1.9); update `OFFERED_BY_STATUS`
  (`llm-shape.test.ts:24+`) to the new combined set per status (FSM lifecycle ∪ `mutableIn` content
  commands). `ALL_BRIEF_COMMANDS` reads `FeatureBrief.__def.commands` plus generated names.
- **guard.test.ts**: page-FSM tests unchanged; **element**-FSM tests repoint from item guards to element
  guards (§2.6 rename).
- **consistency/concurrency/snapshot**: largely mechanical — they exercise tokens/OCC/snapshots, not
  content shape; touch only where they construct page content or assert `fields`/`items`.

### 5.7 `wiki-models` has no tests

`vitest run --passWithNoTests` stays (per CLAUDE.md). `wiki-mcp` tests that assert `pages.fields`/
`pages.items` rows repoint to `sections` + the new `outline`/`xref` tables (§4).

---

## 6. Sequencing + verification

**This is an all-or-nothing compile.** `IPageNode.fields`/`items` → `sections` changes the shared
`PageState` every layer imports, so `tsc` is red from the first edit in `api.ts` until §1-§4 are
coherently complete. `npm run typecheck` is the **hard gate** (CLAUDE.md: "no linter/formatter —
`typecheck` (strict `tsc`) is the gate"); `npm run test` is the behavioral gate.

### 6.1 Order that minimizes time-to-green

1. **Types first (`wiki/src/api.ts`, §1)** — land the full new type layer in one commit. Red everywhere,
   but it's the contract every later step compiles against. Update `index.ts`/`authoring.ts` exports
   (§1.10) in the same commit so downstream imports resolve.
2. **Engine reducer + structure (`core/operations.ts` §2.1, `core/section-structure` §2.3,
   `core/errors.ts` new errors)** — pure, leaf-most engine logic; unit-testable in isolation (§5.3) even
   while the rest is red.
3. **Ingestion validators (`core/ingestion.ts`, §2.5)** — pure, leaf-most; unit-testable (§5.3).
4. **Workspace router (`core/workspace.ts`, §2.2)** — wire the single content event + `PageCreated`
   section materialization to §2.1.
5. **Registry (`core/registry.ts`, §2.6)** — declaration validation + generated commands + element
   guards; `define.ts` shape checks.
6. **Command bus (`core/command-bus.ts`, §2.4)** — declarative execution, gates, well-formedness; depends
   on 2-5.
7. **Render read model (`render/read-model.ts`, `render/blocks.ts`, §2.7)** — repoint `core/wiki.ts`.
8. **`wiki-models` bundle (§3)** — re-author all four types declaratively; now `wiki` package compiles
   end-to-end (the engine devDepends on `wiki-models/feature` for its own tests, CLAUDE.md gotcha).
9. **`wiki-mcp` projection (§4)** — schema migration, projector, LanguageRegistry stub.
10. **Tests (§5)** — engine-pure (reducer/structure/operations/ingestion/blocks) first, then render
    goldens, then integration (worked-example/llm-shape), then `wiki-mcp`.

### 6.2 Verification gates

- After step 8: `npm run typecheck` must pass for **all** packages (the swap is coherent). This is the
  first point the tree can be green.
- After step 8: `npm run typecheck -w wiki` and `npm run test -w wiki` — engine + bundle behavior.
- After step 9: `npm run typecheck -w wiki-mcp` (+ `wiki-server` transitively — it must not import `wiki`
  directly, CLAUDE.md layering).
- After step 10: `npm run test` (all packages) green. Spot-check the render goldens byte-for-byte
  (`render.test.ts` is the determinism anchor, §10).
- Final: `npm run build` (wiki via `tsc`; wiki-models/wiki-mcp/wiki-server via `tsdown`) — confirm the
  `deps.alwaysBundle` regex `/^wiki(\/|$)/` still bundles `wiki/authoring`/`wiki/registry` (CLAUDE.md
  gotcha; an `ERR_MODULE_NOT_FOUND` here means a bare-string specifier slipped in).

### 6.3 Explicitly DEFERRED (not Phase 1)

Per §12/§13 and the task brief — call these out so they are not implemented now:

- **`spliceInline`** — partial inline-run edits within a paragraph (use `setBlock` for whole-block
  replacement in Phase 1). (§9.4 note / §12)
- **Nested-block list items** beyond the `IBlock[][]` shape already typed — no deep list editing ops.
  (§12)
- **Block-level `embed`** (transclusion of a `ref` target) — ADR-gated, overlaps `attachment-ref`/inline
  `ref`. (§3.1, §13)
- **AST / semantic ops** — `renameSymbol`/extract and any parsing. `code` is an opaque canonical blob
  served by the read-only index; the `symbol_index` columns for `name/kind/range` stay null. **Phase 3.**
  (§5, §11, §12)
- **The `LanguageRegistry` analyzers** — the registry seam is stubbed (§4.3) but loads no analyzer; the
  `outline` projector is the only Phase-1 read-side projection that is fully populated. (§11, §12 Phase 2)
- **Model-supplied validation layers** — domain rules on top of the engine-standard field-kind grammar.
  Only the engine grammar validators (§2.5) ship in Phase 1. (§7 "a later capability")
- **`reduceMeta`/`deriveMeta` beyond the seam** — the hooks are declared/typed and the single-writer fold
  is implemented (§2.1), but no `feature` section uses them in Phase 1; they exist for the contract.

---

## 7. Net file inventory

**New:** `wiki/src/core/operations.ts`, `wiki/src/core/ingestion.ts`,
`wiki/src/core/section-structure.ts` (or merged into `structure.ts`), `wiki/src/render/read-model.ts`,
`wiki/src/render/blocks.ts`, `wiki-mcp/src/readmodel/migrations/002-sections.ts`,
`wiki-mcp/src/models/language-registry.ts`, and tests `wiki/test/operations.test.ts`,
`wiki/test/ingestion.test.ts`, `wiki/test/blocks.test.ts`, `wiki/test/section-structure.test.ts`.

**Heavily rewritten:** `wiki/src/api.ts`, `wiki/src/core/workspace.ts`, `wiki/src/core/command-bus.ts`,
`wiki/src/core/registry.ts`, `wiki/src/core/structure.ts`, `wiki/src/render/markdown.ts` (→ read-model),
`wiki/src/index.ts`, `wiki/src/authoring.ts`, `wiki/src/core/define.ts`, `wiki/src/core/errors.ts`;
all of `wiki-models/src/feature/*` (and delete `items.ts`); `wiki-mcp/src/readmodel/{schema,project}.ts`;
`wiki/test/{reducer,render,worked-example,llm-shape,guard,structure}.test.ts`.

**Deleted:** `wiki-models/src/feature/items.ts`; `IItemRecord`/`ICommandDef`/`IItemTypeDef`/`CommandMap`
from `api.ts` + barrel; per-type `apply`/`render`/`produces` everywhere.

**Untouched (mechanism only):** `core/guard.ts`, `core/readmodel.ts` (token codec), `core/types.ts`
(event-log port), `stores/event-log.ts`, `schema/zod-adapter.ts`, `render/determinism.ts` (now engine-
internal), `testing.ts`, `wiki-server/*` (thin wiring — recompiles against the new wiki-mcp).
