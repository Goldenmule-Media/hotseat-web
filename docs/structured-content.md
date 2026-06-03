# Structured Content — pages as typed Sections

> Status: **Draft design spec** · 2026-06-03 · Owner: @benjamin
> Pages are a tree of typed **Sections**, mutated through named, field-kind-aware commands and
> projected deterministically to Markdown. This spec defines the content model, the field-kind
> vocabulary, the write/read-model split, structural contracts, and rendering.

---

## 1. Overview

A page's content is a **tree of typed Sections**, not free text. Each Section has a name, an optional
description, and a set of typed **fields**; every Section and field is **addressable** by a stable
key. Pages therefore behave like **objects**: deterministic tools — outline, indexing, symbol rename
— operate on structure directly, instead of an LLM or regex inferring meaning from prose.

The guiding principle:

> Make the structure explicit enough that tools can derive and transform it deterministically, and
> reserve the LLM for genuinely fuzzy authoring.

This deepens the standing tenet that there is **no free-form rich text** (`wiki/DESIGN.md:88`):
content was already structured and gated, but its shape was implied by each page type's bespoke
render code (the default renderer infers display via `textOf = rec.text ?? rec.name ?? rec.id`,
`wiki/src/render/markdown.ts:256`). Here the structure is **first-class, uniform, and
introspectable**.

The model provides three capabilities:

1. **Addressable typed Sections** — an edit targets a specific `(section, field)`.
2. **Deterministic structural operations**, including AST-backed operations on code (e.g. rename).
3. **Model-declared structural contracts** — a page type may require sections to exist, require
   fields to carry data, and constrain which sections may or must be mutated.

### Projectional framing

The engine is a **projection machine**: events fold to a typed `IWorkspaceState`, and every view is a
deterministic projection of that state. Markdown render, the SQL read model, and AST/symbol indexes
are all **read models** over the same fold. Sections and field-kinds are a richer typed **write
model**; they change what the engine stores and validates, not how projection works.

The schema-agnostic boundary is unchanged. The engine owns the **metaschema** — the vocabulary page
types are written in (`definePageType`, the FSM, field-kinds, Sections) — and **zero schema**:
concrete page types (`feature-brief` and its sections) live in `wiki-models`, loaded at runtime. The
engine owns the **grammar of structure and how it renders**; it never owns the **meaning** of a
section nor any **language machinery**.

## 2. Content model

A page is a tree of Sections. There are **no separate `fields` or `items` containers** — a Section is
the one content container. State shape (illustrative):

```ts
interface IPageNode {
  id: PageId;
  type: string;
  parentId: PageId | null;
  title: string;
  status: string;                  // page-type FSM status
  sections: ISection[];            // ordered; the page's content tree
  createdAt: string; updatedAt: string;
}

interface ISection {
  key: string;                     // stable, model-declared; unique among siblings (addressing)
  id: SectionId;                   // engine-minted stable id (injected newId)
  name: string;
  description?: string;
  order: number;                   // explicit ordering — never object-key order
  parentId: SectionId | null;      // intra-page section tree
  fields: Record<string, IField>;  // keyed by fieldKey
  meta?: Record<string, unknown>;  // typed model-defined auxiliary data (§9.5)
}

type IField =
  | { kind: "scalar";         value: string | number | boolean }
  | { kind: "prose";          value: string }
  | { kind: "code";           lang: string; source: string; hash: string }
  | { kind: "attachment-ref"; ref: string; mime: string; name: string }
  | { kind: "ref";            target: RefTarget }   // typed cross-reference; render-derived label
  | { kind: "blocks";         blocks: IBlock[] }    // document content — closed block/inline vocab (§3.1)
  | { kind: "list";           elementType: string; elements: IItem[] };

type RefTarget =
  | { kind: "section"; id: SectionId }                                    // intra-page section
  | { kind: "page";    id: PageId }                                       // another page, same workspace
  | { kind: "symbol";  section: SectionId; field: string; name: string }  // a symbol in a code field
  | { kind: "block";   section: SectionId; field: string; block: BlockId }; // a block in a blocks field

interface IItem { id: string; status?: string; fields: Record<string, IField>; meta?: Record<string, unknown>; }
```

- **Sections have no lifecycle FSM.** All FSMs live in the model — the page-type status FSM and any
  item FSMs. The engine owns only the FSM *mechanism* (`t()`, the guard).
- **Items live inside `list` fields.** A repeatable sub-entity (e.g. a `question`) is a `list`
  element and may carry a model-declared status FSM (`question: open → resolved`). Because the FSM is
  on the *item*, "Sections have no FSM" holds.
- **Addressing.** A field is addressed by `(sectionKey, fieldKey)`, a list element by
  `(sectionKey, fieldKey, itemId)`. Keys are stable and model-declared; ids are minted from the
  injected `newId()` and never derived from content or position.
- **Auxiliary metadata.** A section or element may carry a typed `meta` bag — structured,
  model-defined data beside the canonical fields, with an optional bounded fold hook (§9.5).
- **Sections are editable structure.** The section tree is mutated through `addSection` /
  `moveSection` / `removeSection` / `renameSection` operations (§9.4), subject to the page type's
  section-set contract (required / prohibited / closed-vs-open, §6). Author-added sections get an
  engine-minted `id`; their `key` is supplied at creation (or slugified from the initial name) and is
  stable thereafter — never recomputed from position. Required sections use their model-declared keys.
- **Sections vs blocks.** A section is the *addressable, contract-bearing, mutation-gated,
  meta-bearing* unit; a **block** (§3.1) is intra-section flowing content with none of that. Use a
  (sub-)section when a unit needs a stable key, a contract (§6), a write-gate, meta (§9.5), or to be a
  command target / appear in the outline (§11); use a block otherwise. Headings that organize the
  outline are sections; a `heading` block is presentational sub-structure inside one section.

Two tree levels coexist: the **workspace tree** of pages (`parentId` on the page) and the
**intra-page section tree** (`parentId` on the section). The section tree lives within one page's
slice of the workspace stream; it introduces no new stream or consistency boundary and inherits the
page's OCC/aggregate guarantees.

The section tree **may nest** (document pages need an addressable heading hierarchy), reusing the
page-tree acyclic/ordering invariants at the intra-page level.

## 3. Field-kinds

Field-kinds are a **closed, engine-owned** vocabulary. Each names how a field's value is shaped,
validated, and rendered. *Which* kinds a page type uses is model data; the *set* is fixed in the
engine so the fold and the render read model can handle any field generically.

| Kind | Canonical value | Default render | Notes |
|---|---|---|---|
| `scalar` | string / number / boolean | inline value | the simple leaf |
| `prose` | string | text block | structured prose; rejects fenced ``` code (use `code`) |
| `code` | `{ lang, source, hash }` | fenced block, verbatim | stores canonical text, not an AST (§4) |
| `attachment-ref` | `{ ref, mime, name }` | link | content-addressed; bytes live in an external store |
| `ref` | a typed target (section / page / symbol) | **render-derived** label (section number, page title, or symbol name) | a first-class cross-reference; integrity checked like a link; the rendered text is a projection, so reorders / renames / renumbers update it automatically |
| `list` | ordered `IItem[]` of one `elementType` | per-element, model-configured | elements are items; may carry a model FSM |
| `blocks` | ordered `IBlock[]` (heterogeneous, §3.1) | a fixed per-kind walk (`as: blocks`) | **document** content — a closed block/inline vocabulary; structured rich text, never an opaque blob |

### 3.1 Blocks (document content)

A `blocks` field is the **document** counterpart to the named-field record — an ordered, heterogeneous
sequence of typed **block** nodes. It is a `list` generalized along one axis: the element is a *closed
union* of block kinds rather than a single `elementType`, so the `list` operations (§9.4) and every
determinism rule (§10) carry over. Each block carries an engine-minted `id` (injected `newId()`, never
positional). The closed v1 block vocabulary:

| Block | Shape | Renders as |
|---|---|---|
| `paragraph` | `{ id, inlines: IInline[] }` | runs concatenated |
| `heading` | `{ id, level: 1–6, inlines }` | `#`×level — intra-section, **not** in the outline |
| `code` | `{ id, lang, source, hash }` | verbatim fence — the **same** payload + machinery as a `code` field (§4/§5/§11) |
| `list` | `{ id, ordered, items: IBlock[][] }` | tight bullets / `1.` |
| `table` | `{ id, align[], header, rows }`, cells = `IInline[]` | GFM pipe table (rectangular; inline-only cells) |
| `quote` | `{ id, variant?, blocks: IBlock[] }` | `> ` — callouts are a `variant`, not a new kind |
| `divider` | `{ id }` | `---` |

```ts
type IBlock =
  | { kind: "paragraph"; id: BlockId; inlines: IInline[] }
  | { kind: "heading";   id: BlockId; level: 1|2|3|4|5|6; inlines: IInline[] }
  | { kind: "code";      id: BlockId; lang: string; source: string; hash: string }
  | { kind: "list";      id: BlockId; ordered: boolean; items: IBlock[][] }
  | { kind: "table";     id: BlockId; align: ("left"|"center"|"right"|null)[]; header: IInline[][]; rows: IInline[][][] }
  | { kind: "quote";     id: BlockId; variant?: string; blocks: IBlock[] }
  | { kind: "divider";   id: BlockId };
```

A `code` block **is** a `code` field with a `blockId` — same `{ lang, source, hash }`, same
`applyTextEdits` (§5), same content-hash precondition, same symbol-index projection (§11) keyed by
`blockId`. There is no second code path, so the rename worked-example (§5) reaches code embedded in
prose with zero new machinery. Block-level `embed` (transclusion of a `ref` target) is **deferred** —
it overlaps `attachment-ref` and inline `ref`; add it only when a page type needs it (ADR-gated, §13).

### 3.2 Inline runs and marks

A prose-bearing block (paragraph, heading, list item, table cell) holds an ordered sequence of
**inline runs**. Inline formatting is carried **ProseMirror-style**: a `text` run carries a
canonical-sorted *set* of **marks**, not nested emphasis nodes — nesting would let `strong(em x)` and
`em(strong x)` fold differently for identical output. Inline nodes and marks are both closed:

```ts
type IInline =
  | { kind: "text"; value: string; marks: Mark[] }   // marks: a canonical-sorted set
  | { kind: "code-span"; value: string }             // verbatim inline code — an atom, not a mark
  | { kind: "ref"; target: RefTarget };              // inline cross-reference — render-derived label

type Mark = "strong" | "emphasis" | { kind: "link"; href: string };
```

The inline **`ref`** is the load-bearing payoff: a reference *inside a sentence* whose displayed text
is the render-derived label of its target (a section number, page title, or symbol name), so reorders
/ renames / renumbers update it automatically and integrity is checked like a link (§7). That is the
thing a document model buys which sub-sectioning never can.

### 3.3 What blocks are not

Blocks are **structured** rich text, not free-form. Every node has a tag from the closed vocabulary
and an `id`; the only string-bearing leaves are `text` runs and `code` source. There is **no** `html`
/ `raw` / `markdown` block, and a `text` run may not contain Markdown syntax (a fence, a backtick,
`*`/`_`, `[..](..)`, a leading `#`) — the engine rejects it at ingestion (§7), forcing the structure
into a `code-span`, a mark, or a `ref`. That rejection is the enforced line between *structured* rich
text and an *opaque* blob (§13). Blocks carry **no contracts, no meta, no FSM** (§6/§9.5): if a unit
needs any of those, it is a section, not a block.

## 4. Write model and read models

The engine holds the **write model**: the canonical content folded from the event log. Everything
else is a **read model** derived from it.

- **Canonical content lives in the write model.** A `code` field stores `{ lang, source, hash }` —
  plain JSON, `structuredClone`-safe (the fold deep-clones every payload, `workspace.ts:190`) and
  `JSON.stringify`-safe (the SQL read model serializes content to jsonb,
  `wiki-mcp/src/readmodel/project.ts:38`).
- **ASTs are read models.** An AST is derived by parsing canonical source in a projection inside the
  host (`wiki-mcp`, or a dedicated `wiki-analysis` sub-layer), exactly as the SQL read model is
  derived. A parser upgrade re-projects; it never rewrites history. The engine never stores or folds
  an AST.
- **Render is a read model** (§8).
- **Language machinery lives in the host, never in `wiki`.** Parsers (tree-sitter / Roslyn / LSP) are
  heavy and version-sensitive; they load through a runtime **`LanguageRegistry`** that mirrors the
  `ModelRegistry` dynamic-import pattern (ADR-M6). The engine stays dep-free and deterministic.

A `code` field's `hash` is a content hash of its canonical source — a read-model optimization
(content-addressed identity, cheap change detection). It does not change what is canonical.

## 5. Mutations, addressing, and code edits

Content changes only through **named, typed, FSM-gated commands** — never a free-text body. A command
targets a specific `(section, field)` (or list element); the page-type FSM gates which commands are
legal in the current status, and a **write-gate** (§6) binds a command to the sections it may touch.

- **Code edits are structured.** A code mutation emits a `TextEdit[]` (range + replacement) carried
  in a single event, with periodic full-source checkpoints to bound fold cost — a smaller log, richer
  audit, and a pure deterministic string replay.
- **Semantic operations are computed in the host.** A language-aware op (rename, extract, …) runs in
  the host where the parser lives; the engine receives the resulting edits and emits one guarded
  event. `produces` stays pure — it never parses.

### Rename, worked

1. The host reads canonical source from the symbol-index projection, parses, and computes the new
   source plus the in-scope edit ranges. All language work happens here.
2. The host issues one guarded command:
   `mutate(pageId, "renameSymbol", { field, symbol, newName, expectedHash })`.
3. The command (pure) checks `expectedHash` against the current field — rejecting an edit computed
   against stale source after an OCC rebase — and emits a single `applyTextEdits(field, edits)`
   section operation (§9.4) carrying the `TextEdit[]`, recorded under the `renameSymbol` command.
   One operation, not N field edits: it upcasts as a single payload and does not couple history to a
   parser's site order.
4. The fold applies the edits; render fences the new source verbatim (byte-identical); `history()`
   audits the refactor. Same-workspace cross-page references ride one atomic multi-page append (the
   `moveItem` precedent); cross-workspace references are reported, not silently touched.

**Guarantee scope.** Sound for in-scope lexical references in supported languages within one
workspace. Closures over dynamic state, reflection / string-keyed access, dynamic dispatch, macros,
and references in prose are best-effort: the command returns the unresolved/ambiguous sites rather
than guessing.

## 6. Structural contracts

A page type may declare structural contracts. Each maps to a distinct check at a distinct point; they
are kept separate because they fail differently.

- **Required section exists** — `requiredSections` on the page type. Like `requiredChildren`
  (`feature-brief.ts:264`) but intra-page: required sections are **auto-materialized empty** at
  `PageCreated` (`workspace.ts:256-269`), keyed by their stable declared keys (no id generation, no
  FSM). Required sections cannot be removed or reordered out.
- **Section-set shape** — the section tree is author-editable by default (§9.4); a page type
  constrains it by declaring the set **open** (the author may add ad-hoc sections) or **closed** (only
  declared sections allowed), and may **prohibit** specific sections or cap cardinality (SHACL
  `closed` / `minCount` / `maxCount`). A `feature-brief` is effectively closed; a design-doc or
  notebook type is open.
- **Field carries required data** — a per-field schema, reusing the `ISchema` seam that command args
  already use (`api.ts:342`). The engine runs a **well-formedness check** during `decide` (so it
  re-runs on every OCC rebase), validating that the resulting state parses. It validates shape, never
  meaning.
- **Only certain sections may be mutated** — a **write-gate** binding each content command to the
  `(section, field)` it may touch, evaluated with the FSM-legality check. This also lets
  `describeMutations` report which section a command edits.
- **A section must be mutated before a transition** — a declarative `preconditions` array on the
  transition, each a pure `(page, related) => true | { unmet }`, evaluated inside the rebase-retried
  `decide` window. This replaces hand-coded gate prologues (`beginImplementation` / `ship`,
  `feature-brief.ts:416-500`) and makes "why is `ship` blocked?" introspectable.

**Exist vs filled.** "Must exist" is always-on and materializes an *empty* section (like
`requiredChildren`); "must be filled" is **transition-scoped** (like `ship`'s open-questions gate).
Filled-ness must be transition-scoped, or a page could never be created and then filled across
multiple commands.

All contract declarations are model data, validated **mechanically** in the `Registry` constructor
(`registry.ts:27-40`) — keys resolve, kinds are known, predicates are callable — and hot-reload via
the `ModelRegistry`.

## 7. Ingestion validation

The engine validates the **field-kind grammar** at write time — pure, deterministic, engine-owned.
For example: a `prose` field rejects fenced ``` code blocks (code must use a `code` field so it stays
addressable and analyzable); a `code` field requires a language tag; a `ref` field's target must
resolve to an existing section, page, or symbol (dangling references are rejected, like link-target
integrity); an unknown field-kind is rejected. These grammar guarantees are what let every downstream
tool trust the structure.

A `blocks` field is held to the same grammar structurally: a block or inline tag outside the closed
vocabulary (§3.1) is rejected; a `text` run carrying Markdown syntax is rejected (it must be reified
as a `code-span`, a mark, or a `ref`); table cells are inline-only and rectangular; and every `ref` /
inline-`ref` target must resolve — the integrity walk and the §11 cross-reference index recurse **into**
block and inline trees, so an inline reference can never dangle undetected.

Models may add their own validation layers on top of the engine-standard grammar (domain rules) — a
later capability, after the engine grammar validators.

## 8. Rendering

Render is a **read model**: the engine ships a configurable **Markdown render read model** that walks
a page's section tree and dispatches on field-kind. Each field-kind ships a default deterministic
render; a page type supplies **render config** (section order, headings/labels, per-kind display,
groupings such as open/resolved) instead of a hand-coded `render` function. The per-type `render`
function is removed.

Determinism is a property of this read model: it is pure over folded state plus the model's *static*
config, so equal state renders byte-identically.

**Open:** the render-config vocabulary must cover today's bespoke layouts (e.g. the feature-brief
open/resolved question split) without becoming "config that is secretly code"; it is to be specified.

## 9. Authoring a page type

`definePageType` declares **structure, legality, and presentation** — never content reducers,
renderers, or bespoke events. The engine supplies one generic section reducer, the Markdown render
read model (§8), and a closed set of **section operations**; a page type contributes only its
**section layout**, its **lifecycle FSM** and **commands**, its **structural contracts** (§6), and
its **render config** (§8). An author no longer writes a content reducer, a `render` function, or
per-type event types — all three are engine-owned. The one sanctioned place to add fold logic is a
**bounded, pure meta-reducer** scoped to a section's typed `meta` bag (§9.5), which can never touch
canonical content.

### 9.1 Shape

```ts
definePageType({
  type: "feature-brief",
  version: 1,
  initialStatus: "draft",
  statusTransitions: [ /* lifecycle only — see 9.4 */ ],
  sections: { /* 9.2 */ },
  elements: { /* 9.3 — element (list-item) types */ },
  commands: { /* 9.4 */ },
  render:   { /* 9.6 */ },
})
```

### 9.2 Sections and fields

A section declares its fields by **field-kind** (§3), whether it is **required**, and the statuses in
which it is **mutable** (its write-gate, §6):

```ts
sections: {
  summary: {
    name: "Summary",
    required: true,
    mutableIn: ["draft", "planning"],
    fields: { body: { kind: "prose", required: true } },
  },
  constraints: {
    name: "Design constraints",
    mutableIn: ["draft", "planning", "building"],
    fields: { items: { kind: "list", element: "constraint", ordered: true } },
  },
  questions: {
    name: "Questions",
    mutableIn: ["draft", "planning", "building", "review"],
    fields: { items: { kind: "list", element: "question" } },
  },
}
```

- `required: true` on a **section** ⇒ a `requiredSection`, materialized empty at `PageCreated`.
- `required: true` on a **field** ⇒ a well-formedness constraint (the field must carry data),
  checked transition-scoped — never at create (§6, exist-vs-filled).
- `mutableIn` is the **write-gate**: the generated edit commands for this section are legal only in
  those statuses. Omit it for a section that is never directly mutated (e.g. a derived section).
- The `sections` block declares only the **known** sections (their fields, `required`, `mutableIn`).
  Whether the author may add *further* sections at runtime is the section-set shape (`open` / `closed`,
  §6); open types grow their tree via the section structural operations (§9.4).

### 9.3 Elements (list-item types)

A `list` field holds elements of one declared **element type** — fields-by-kind plus an optional
**status FSM**. This is the only place a sub-entity carries lifecycle; sections never do (§2):

```ts
elements: {
  constraint: { fields: { text: { kind: "prose", required: true } } },
  question: {
    fields: { text: { kind: "prose", required: true }, answer: { kind: "prose" } },
    status: { initial: "open", transitions: [ t("open", "answer", "resolved") ] },
  },
}
```

### 9.4 Commands and section operations

There are two kinds of command:

- **Generated structural commands.** Declaring a section/field implies the CRUD to edit it — `set` a
  field, `add`/`remove`/`move` a list element, `set` an element field — each gated by the target's
  `mutableIn`. They appear in `describeMutations` with a stable derived name and the `(section,
  field)` they touch. Authors write nothing for these.
- **Declared commands.** Lifecycle transitions and semantic operations. A command is **declarative
  by default**: it names a target, an args→field mapping, the FSM `event` it fires, and any
  `preconditions` (§6) — and needs no `produces`.

```ts
statusTransitions: [
  t("draft", "beginPlanning", "planning"),
  t("planning", "beginImplementation", "building"),
  t("building", "submitForReview", "review"),
  t("review", "ship", "shipped"),
  // lifecycle only; content-edit legality lives in `mutableIn`, not here
],

commands: {
  // semantic: set a field AND drive an element FSM — fully declarative
  answerQuestion: {
    args: z.object({ questionId: z.string(), answer: z.string() }),
    target: { section: "questions", element: { idArg: "questionId" } },
    set: { answer: arg("answer") },
    transition: { level: "element", event: "answer" },
  },
  // lifecycle gate: no effect, just a guarded transition
  ship: {
    args: z.object({}),
    transition: { level: "page", event: "ship" },
    preconditions: [ checklistComplete, allCasesPassed, noOpenQuestions ],
  },
},
```

`produces` is the **escape hatch**, needed only when a command's *effect* is computed (not a direct
args→field copy). It returns a list of **section operations** — the same closed vocabulary the
generated commands and the engine reducer use — never bespoke events:

| Operation | Effect |
|---|---|
| `setField(section, field, value)` | set a scalar / prose / attachment field |
| `applyTextEdits(section, field, edits)` | structured edit of a `code` field — or a `code` block, by `blockId` (§5) |
| `addElement` / `removeElement` / `moveElement` | list mutation |
| `setElementField(section, field, id, elemField, value)` | edit one element field |
| `setMeta(section, path, value)` | set structured section/element metadata (§9.5) |
| `addSection` / `removeSection` / `moveSection` / `renameSection` | edit the section tree, subject to the section-set contract (§6) |
| `addBlock` / `removeBlock` / `moveBlock` / `setBlock` | edit a `blocks` field's block tree (§3.1); `setBlock` replaces a whole block, including a paragraph's inline runs (the host computes the new runs, like §5) |
| `transition(level, target?, event)` | drive a page/element FSM |

The engine folds these through one built-in reducer and records the originating command in event
metadata, so history stays semantic (`answerQuestion`) without per-type events.

### 9.5 Section and element metadata

A section or element may carry a typed **`meta`** bag — structured, model-defined data beside the
canonical fields (counters, flags, review state, derived summaries, cross-reference caches). Meta is
declared with a schema (the `ISchema` seam, §6) and is plain JSON: it is **not** a free-text body and
**not** a home for ASTs or parser output (those stay read models, §4).

Meta is written three ways, chosen by need:

- **Set directly** — the generic `setMeta(section, path, value)` operation (§9.4), validated against
  the declared meta schema. Covers structured meta a command sets explicitly; no custom code.
- **Derived** — a pure `deriveMeta(section) => meta` projector for meta that is a function of the
  section's current content. A read-side projection (§4), recomputed on read, never stored in the log.
- **Accumulated** — a pure, **meta-scoped** `reduceMeta(meta, op) => meta` hook the engine runs during
  the fold, for meta that depends on the *sequence* of operations (e.g. increment a counter on every
  `addElement`). This is the one place a model extends the reducer.

Guardrails keep the extension bounded:

- **Pure and total** — `(meta, op) => meta`, exactly like the engine reducer: no clock, randomness, or
  I/O; any timestamp/id it needs comes from the operation payload (stamped at produce time). It is
  registered in the page type, so the external read-model fold runs it identically.
- **Meta-scoped** — it may read the operation and the section, but may write **only `meta`** — never
  canonical fields, the section tree, or status. Canonical content stays engine-folded and uniformly
  legible to tooling.
- **Plain JSON** — `structuredClone`-safe and jsonb-serializable, like fields.
- **Schema-validated** at the well-formedness check (§6) and **versioned** via `schemaVersion` +
  upcasters (§10), like any field.

**Single writer.** If a section declares `reduceMeta`, that hook is the sole writer of its meta — it
processes every operation (including `setMeta`) and returns the next meta. Otherwise `setMeta` writes
meta directly. This prevents two writers racing on the same bag.

This is the controlled answer to "models need to extend the reducer": a typed bag plus a pure,
sandboxed fold hook — without reintroducing bespoke events or a hand-written reducer over canonical
content, so the structure the tooling depends on stays engine-owned.

### 9.6 Contracts recap

The structural contracts (§6) are declarations here: `required` on a section (`requiredSections`),
the **section-set shape** (`open` / `closed`, prohibited, cardinality), `required`/schema on a field
(well-formedness), `mutableIn` (write-gate), and `preconditions` on a transition. The `Registry`
validates them mechanically at load — keys resolve, field-kinds are known, predicates are callable.

### 9.7 Render config

Render config is **declarative and logic-free** (§8). It lists sections in render order with a
display directive per field and optional grouping; element display is a **template** that substitutes
element fields (`{field}`, or `{field?}` to omit when empty). There are no expressions: **any value
that needs computing is materialized into a field by a command, never computed at render time.**

```ts
render: {
  title: "Feature: {title}",
  sections: [
    { section: "summary",     heading: "Summary",           placeholder: "_No summary._" },
    { section: "constraints", heading: "Design constraints", field: "items", as: "numbered",
      item: "{text}" },
    { section: "questions",   heading: "Questions",          field: "items", groupBy: "status",
      groups: [
        { when: "open",     heading: "Open questions",     item: "**{text}**" },
        { when: "resolved", heading: "Resolved questions", item: "**{text}** → {answer}" },
      ] },
  ],
}
```

Display directives by field-kind: `prose`→block, `scalar`→inline, `code`→fenced (verbatim),
`attachment-ref`→link, `ref`→derived label, `blocks`→self-describing (no per-block config), `list`→`bullets` | `numbered` | `table` | grouped. Each ships a default, so
config is needed only to override labels, order, grouping, or placeholders.

### 9.8 Open questions

- **Generated-command naming** — the derivation scheme for structural command names (and an aliasing
  hook), as surfaced in `describeMutations`.
- **Args mapping DSL** — the `set: { field: arg("…") }` / `arg()` grammar that maps command args to
  fields, on top of the existing `zodSchema`/`ISchema` arg seam (`api.ts:342`).
- **Template grammar** — exact substitution rules (`{field}`, `{field?}`, element-field access) and
  the `table`/column directive shape.
- **Derived sections** — how a `mutableIn`-less computed section is populated (projection-fed and
  read-only vs command-written).

## 10. Determinism rules

- **No AST in the fold or the log.** Canonical text only.
- **Render is identity, never a formatter.** A `code` field renders as a verbatim fenced block.
  Reformatting, if ever, is an explicit command that rewrites canonical text into a new event — never
  a render-time computation.
- **Explicit section/field ordering**, rendered via `stableBy` (`determinism.ts:87`); never
  object-key insertion order.
- **Stable ids from injected `newId()`** — for sections, list elements, and blocks/inline runs alike —
  never derived from content or AST positions.
- **Blocks render in a fixed normal form.** Blocks and inline runs render in explicit array order
  (never object-key order); adjacent `text` runs with equal marks are merged and marks canonical-sorted
  at ingestion; emphasis uses fixed delimiters; a `code` block fences verbatim (as a `code` field);
  GFM tables are rectangular with deterministic cell escaping. No Markdown formatter, wrapper, or
  normalizer ever runs — render is a pure identity projection of the block/inline tree.
- **Attachments are content-addressed references**, never inline bytes — inline blobs bloat the
  append-only stream and break snapshot bounding.
- **Section schemas and field-kinds version through the existing `schemaVersion` + upcasters** — a
  change is a pure payload reshape.

## 11. Static analysis and projections (host)

Deterministic, language-aware tooling lives in the host as read-side projections over canonical
source, fed by the same projection tailer as the SQL read model:

- **outline** — section names/tree, straight from folded state.
- **symbol index / cross-references / call graph / type index** — derived by parsing `code` fields.
- **semantic operations** (rename, extract) — computed here, applied via guarded commands (§5).

Per-language analyzers load through the `LanguageRegistry` and expose a narrow `ILanguageAnalyzer`
(`parse / symbols / references / rename`). Parsers are dependencies of the analyzer plugins, never of
`wiki`.

## 12. Delivery sequence

- **Phase 1 — substrate.** Sections as the sole content container, the closed field-kinds (incl. the
  `blocks` document model §3.1 and its block/inline ops; `spliceInline`, nested-block list items, and
  block `embed` are deferred), the structural contracts (§6), and the Markdown render read model (§8). The `feature` bundle is
  authored directly on sections; golden render tests are rewritten. No data migration (greenfield).
- **Phase 2 — read-only projections.** `outline` + symbol-index projections over canonical source
  behind the `LanguageRegistry`, exposed as MCP read tools. Establishes the analyzer contract and
  token-gating before any write-back.
- **Phase 3 — semantic operations.** `renameSymbol` and related, one language first, round-trip
  enforced, guarantee scoped per §5. Deferred until justified by need; until then a `code` field is
  an opaque canonical blob served by the read-only index.

## 13. Non-goals

- No parser, AST, LSP, or formatter in `wiki`.
- No AST in the event log or folded state — canonical text + content hash only.
- No render-time formatting; render is an identity projection of stored canonical text.
- No general constraint/rule language. Contracts are declarative and decidable (presence,
  cardinality, type, closed/open, simple pure guard predicates) — not Datalog/SHACL-SPARQL/Dhall.
  Richer logic stays in pure `produces`/`apply`.
- No CRDTs. One logical writer per workspace plus OCC stands.
- No inline binary attachments.
- **No *free-form* rich text — but *structured* rich text is the `blocks` model (§3.1).** The line:
  structured rich text is a closed vocabulary of typed, `id`-bearing nodes rendered by identity;
  free-form rich text is an opaque Markdown/HTML string. The former is allowed; the latter is not.
- **No `html` / `raw` / `markdown` blocks, ever**, and no block/inline zoo: callouts beyond a `quote`
  `variant`, columns, toggles, mentions, footnotes, inline math, and block `embed` are out of v1. A
  new block or inline kind requires an ADR proving closed render, stable-id addressability, and no
  opaque leaf.

## 14. Glossary

| Term | Meaning |
|---|---|
| **Projection / projectional editing** | The model is primary; every view (Markdown, code text) is a deterministic projection you edit *through*. The engine's fold→render is one. |
| **Render read model** | Render is a read model, not core write-side logic: a configurable **Markdown render read model** driven by the model's section/field-kind render config. Determinism is a property of this read model (pure over folded state + static config). Sibling of the SQL read model and the AST projection. |
| **Section** | An ordered, stable-id-bearing container of typed fields inside a page; the one content container. The engine owns its shape and render; `wiki-models` declares which sections a type has. |
| **Field-kind** | Closed engine-owned vocabulary (`scalar / prose / code / attachment-ref / ref / blocks / list`) naming how a field's value is shaped, validated, and rendered. `list` holds typed elements (items), which may carry a model-declared FSM; `blocks` holds document content (§3.1). |
| **Reference (`ref`)** | A first-class typed cross-reference to a section, page, code symbol, or block. The target is a stable id; the *displayed* form (section number, page title, symbol name) is a render projection, so reordering / renaming / renumbering updates every reference deterministically. Integrity (target exists) is enforced like link integrity. Exists at both field and inline-run depth. |
| **Blocks (`blocks` field-kind)** | A closed, ordered, heterogeneous sequence of typed `id`-bearing block nodes — the *document* counterpart to the named-field record; a `list` whose element is a closed union (§3.1). Structured rich text, never an opaque blob. |
| **Block / inline run / mark** | A `block` is a typed node in a `blocks` sequence (paragraph/heading/code/list/table/quote/divider). An `inline run` is a typed item inside a prose block (text / code-span / ref). A `mark` is an overlapping inline style carried as a canonical-sorted set on a text run (strong / emphasis / link), ProseMirror-style — not a nesting node. |
| **tree-vs-block rule** | Use a (sub-)section iff a unit needs a stable key, a contract (§6), a write-gate, meta (§9.5), or to be a command target / outline entry; use a block otherwise. Outline-organizing headings are sections; a `heading` block is intra-section presentation. |
| **block normal form** | The canonical representation render assumes — array-ordered blocks/runs, merged adjacent same-mark text, canonical-sorted marks, verbatim code fences, rectangular escaped tables — validated at ingestion (§7) so render is a pure identity projection. |
| **Canonical source / content** | The verbatim value stored in the write model and the event — the durable source of truth. For `code`, the source text; the AST is derived from it, never stored. |
| **AST-as-projection** | The AST is a read model derived from canonical text. (Contrast **AST-as-source** — Unison-style, where structure is canonical and text is a view — which is not used here.) |
| **Content-addressed code / names-as-metadata** (Unison) | Identity = hash of structure; names are metadata, making rename metadata-only. The stored `code` content hash leaves room for this. |
| **Section operation** | The closed, engine-owned vocabulary a command's effect is expressed in: section-tree edits (`addSection` / `removeSection` / `moveSection` / `renameSection`), block-tree edits (`addBlock` / `removeBlock` / `moveBlock` / `setBlock`), field/element edits (`setField` / `addElement` / `removeElement` / `moveElement` / `setElementField` / `applyTextEdits`), `setMeta`, and `transition`. Folded by one built-in reducer, attributed to the originating command in metadata — so history stays semantic without per-type events, reducers, or renderers. |
| **Generated structural command** | The CRUD a section/field declaration implies (set field, add/remove/move element), gated by the target's `mutableIn` and surfaced in `describeMutations`; authored implicitly. |
| **Render config** | The declarative, logic-free presentation declaration the Markdown render read model consumes: section order, per-field-kind display directives, grouping, element templates. Values that need computing are materialized into fields by commands, never computed at render time. |
| **Section meta / `reduceMeta`** | A typed, model-defined `meta` bag on a section or element (plain JSON, beside canonical fields), written directly (`setMeta`), derived (read-side `deriveMeta`), or accumulated by a pure, meta-scoped `reduceMeta(meta, op)` fold hook — the one sanctioned reducer-extension seam; it can never touch canonical content. |
| **Content-hash precondition** | A hash carried by a refactor command so pure `produces` can reject an edit computed against now-stale text (complements stream-level OCC). |
| **requiredSection** | Model-declared section that must exist; auto-materialized empty at `PageCreated` (intra-page sibling of `requiredChildren`). |
| **Write-gate** | Declarative binding from a command to the `(section, field)` it may mutate; surfaced in `describeMutations`. |
| **Transition precondition / obligation** | Pure `(page, related) => true \| { unmet }` that must hold for a transition; the declarative form of a `ship`/`beginImplementation` gate. |
| **Well-formedness check** | A `decide`-stage step that parses the resulting sections against declared schemas before producing events. |
| **Shape / cardinality / closed-open** (SHACL) | Vocabulary for contracts: `minCount`/`maxCount`, closed (no extra sections) vs open. |
| **Content expression** (ProseMirror) | A type's declaration of allowed child blocks + order ("a Summary then 1+ Constraint sections"). |
| **Round-tripping** | `parse(render(structure)) ≡ structure` up to formatting — lets external text tooling coexist with structural editing. |
| **LanguageRegistry / ILanguageAnalyzer** | Runtime per-language plugin loader (mirrors `ModelRegistry`) + its narrow contract (`parse / symbols / references / rename`). Lives in the host. |
| **Declaration mechanism vs meaning** | The schema-agnostic line: the engine validates that declarations are well-formed/consistent; it never learns what a section means. |
