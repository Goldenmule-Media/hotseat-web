# Content model

**Status:** current

## Kind
subsystem

## Summary
A page's content is not free text but a tree of typed Sections, each holding fields of a closed, engine-owned vocabulary of kinds. The engine is a projection machine: events fold to one typed workspace state, and Markdown, the SQL read model, full-text search, and AST/symbol indexes are all read models over that single fold. Sections and field-kinds make the WRITE model richer and explicitly typed so deterministic tools — outline, indexing, symbol rename, cross-reference integrity — operate directly on structure instead of inferring meaning from prose.

## Purpose
The content model exists to make a page's structure explicit enough that tools can derive and transform it deterministically, reserving the LLM only for genuinely fuzzy authoring. The engine owns the metaschema (the vocabulary page types are written in: sections, field-kinds, the FSM mechanism, the closed section-operation vocabulary) and the grammar of structure and how it renders. It never owns the MEANING of any section, nor any language machinery: parsers, ASTs, and analyzers live in the host, behind a runtime registry, so the engine stays dependency-free and deterministic.

## Design notes
A page's content is a tree of typed sections; the section is the one and only content container — there are no separate fields or items containers. A section has a stable, model-declared key (unique among its siblings), an engine-minted id, a name, an explicit order, an optional intra-page parent, a record of typed fields keyed by field key, and an optional typed meta bag. Content is addressed structurally: a field by the pair of section key and field key, a list element by section key, field key, and element id. Keys are stable and declared by the model; ids are minted and never derived from content or position, so addressing survives reorders and renames. Sections themselves have no lifecycle FSM — every FSM lives in the model, either the page-type status FSM or the status FSM of a list element. Two tree levels coexist: the workspace tree of pages and the intra-page tree of sections; the section tree lives inside one page's slice of the workspace stream and inherits that workspace's optimistic-concurrency and aggregate guarantees, introducing no new consistency boundary.

```ts
export type SectionId = string & { readonly __brand: "SectionId" };
export type BlockId   = string & { readonly __brand: "BlockId" };

export interface IPageNode {
  readonly id: PageId;
  readonly type: string;
  parentId: PageId | null;
  title: string;
  status: string;          // page-type FSM status
  sections: ISection[];    // the page's content tree, ordered
  pinned?: boolean;
  archived?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ISection {
  readonly id: SectionId;
  key: string;             // stable, model-declared; unique among siblings
  name: string;
  description?: string;
  order: number;           // explicit ordering — never object-key order
  parentId: SectionId | null;          // intra-page section tree
  fields: Record<string, IField>;
  meta?: Record<string, unknown>;
}

export type IField =
  | { readonly kind: "scalar";         value: string | number | boolean }
  | { readonly kind: "prose";          value: string }
  | { readonly kind: "code";           lang: string; source: string; hash: string }
  | { readonly kind: "attachment-ref"; ref: string; mime: string; name: string }
  | { readonly kind: "ref";            target: RefTarget }
  | { readonly kind: "blocks";         blocks: IBlock[] }
  | { readonly kind: "list";           elementType: string; elements: IItem[] };

export type RefTarget =
  | { readonly kind: "section"; page?: PageId; id: SectionId }
  | { readonly kind: "page";    id: PageId }
  | { readonly kind: "symbol";  page?: PageId; section: SectionId; field: string; name: string }
  | { readonly kind: "block";   page?: PageId; section: SectionId; field: string; block: BlockId }
  | { readonly kind: "element"; page?: PageId; section: SectionId; field: string; element: string; labelField?: string };

export interface IItem {
  readonly id: string;
  status?: string;                     // optional model-declared element FSM status
  fields: Record<string, IField>;
  meta?: Record<string, unknown>;
}
```

Field-kinds are a closed, engine-owned vocabulary; which kinds a page type uses is model data, but the set is fixed in the engine so the fold and the render read model handle any field generically. There are seven. A scalar holds a string, number, or boolean leaf. A prose field holds structured text and rejects fenced code. A code field stores canonical source plus a language tag and a content hash, never an AST. An attachment-ref holds a content-addressed pointer to bytes in an external store. A ref is a first-class, typed cross-reference whose displayed label is render-derived, so reorders, renames, and renumbers update it automatically, and whose target integrity is checked like a link. A list holds an ordered sequence of items of one declared element type, and each item may carry a model-declared status FSM. A blocks field holds document content: an ordered, heterogeneous sequence of typed block nodes, a closed block and inline vocabulary — structured rich text, never an opaque blob. The rule for whether a unit should be a sub-section or a block: make it a sub-section when it needs a stable key, a structural contract, a write-gate, a meta bag, or to be a command target or an outline entry; make it a block otherwise. An outline-organizing heading is a section; a heading block is presentational sub-structure inside one section.

```ts
export type IBlock =
  | { readonly kind: "paragraph"; id: BlockId; inlines: IInline[] }
  | { readonly kind: "heading";   id: BlockId; level: 1 | 2 | 3 | 4 | 5 | 6; inlines: IInline[] }
  | { readonly kind: "code";      id: BlockId; lang: string; source: string; hash: string }
  | { readonly kind: "list";      id: BlockId; ordered: boolean; items: IBlock[][] }
  | { readonly kind: "table";     id: BlockId;
      align: ("left" | "center" | "right" | null)[];
      header: IInline[][];
      rows: IInline[][][] }
  | { readonly kind: "quote";     id: BlockId; variant?: string; blocks: IBlock[] }
  | { readonly kind: "divider";   id: BlockId };

export type IInline =
  | { readonly kind: "text";      value: string; marks: Mark[] }   // marks: a canonical-sorted set
  | { readonly kind: "code-span"; value: string }                  // verbatim inline code — an atom
  | { readonly kind: "ref";       target: RefTarget };             // inline cross-reference — render-derived label

export type Mark = "strong" | "emphasis" | { readonly kind: "link"; href: string };
```

The engine holds the write model — the canonical content folded from the event log — and everything else is a read model derived from it. Canonical content is plain JSON: structuredClone-safe (the fold deep-clones every payload) and serializable to jsonb (the SQL read model persists content directly). A code field stores its source verbatim; its content hash is a read-model optimization that gives content-addressed identity and cheap change detection without changing what is canonical. ASTs, symbol indexes, the outline, full-text search, and the Markdown render are all read models projected from canonical content in the host: a parser or analyzer upgrade simply re-projects and never rewrites history. This split is what lets a single fold serve many views while the engine stays dependency-free and deterministic.

Content changes only through named, typed, FSM-gated commands targeting a specific section and field (or list element) — never a free-text body. The page-type status FSM gates which commands are legal in the current status, and a write-gate binds each command to the sections it may touch. Code edits are structured: a code mutation emits an array of text edits, each a range and a replacement, carried in one event, with periodic full-source checkpoints to bound fold cost — a smaller log, a richer audit, and a pure deterministic string replay. A semantic, language-aware operation such as rename runs in the host where the parser lives; the host reads canonical source from the symbol-index projection, computes the new source and edit ranges, and issues one guarded command. That command, pure, checks an expected content hash against the current field to reject an edit computed against now-stale source after a concurrency rebase, then emits a single applyTextEdits operation recorded under the semantic command name. One operation, not N field edits: it upcasts as one payload and does not couple history to a parser's site order.

A page type may declare structural contracts, each a distinct check at a distinct point because they fail differently. A required section must exist and is auto-materialized empty at page creation, keyed by its declared key, with no id generation and no FSM; it cannot be removed or reordered out. The section-set shape declares the tree open (the author may add ad-hoc sections) or closed (only declared sections allowed), and may prohibit specific sections or cap their cardinality with min and max counts. A per-field well-formedness check runs during the decide stage, so it re-runs on every concurrency rebase, validating that the resulting state's shape is well-formed — shape, never meaning. A write-gate binds each content command to the section and field it may touch, evaluated alongside FSM legality, and also lets the describe-mutations surface report which section a command edits. A transition precondition is a declarative, pure predicate that must hold before a status transition fires, evaluated inside the same rebase-retried decide window, making a blocked transition introspectable rather than failing in hand-coded gate prologues. The key distinction: must-exist is always-on and materializes an empty section, while must-be-filled is transition-scoped, because otherwise a page could never be created and then filled across several commands.

The engine validates the field-kind grammar at write time — pure, deterministic, engine-owned — and these guarantees are what let every downstream tool trust the structure. A prose field rejects fenced code, so code stays addressable and analyzable in its own field. A code field requires a language tag. A ref field's target must resolve to an existing section, page, symbol, block, or element; a dangling reference is rejected just like a dangling link. An unknown field-kind is rejected. A blocks field is held to the same grammar structurally: a block or inline tag outside the closed vocabulary is rejected, a text run carrying Markdown syntax is rejected (it must be reified as a code-span, a mark, or a ref), table cells are inline-only and rectangular, and the integrity walk recurses into block and inline trees so an inline reference can never dangle undetected.

Render is a read model: a configurable Markdown renderer walks a page's section tree in declared order and dispatches on each field's kind. Every field-kind ships a default deterministic render; a page type supplies declarative, logic-free render config — section order, headings and labels, a per-kind display directive, element templates, and groupings such as an open/resolved split — instead of a hand-coded render function. Render is pure over folded state plus the model's static config, so equal state always renders byte-identically. Any value that needs computing is materialized into a field by a command, never computed at render time.

Authoring a page type with definePageType declares structure, legality, and presentation — never content reducers, renderers, or bespoke events. The author contributes a section layout (fields by kind, which sections are required, the statuses each is mutable in), element types for list items (with optional status FSMs), a lifecycle status FSM and commands, structural contracts, and render config. The engine supplies one generic section reducer, the Markdown render read model, and a closed set of section operations. Commands are declarative by default — a target, an args-to-field mapping, the FSM event they fire, and any preconditions; a produces escape hatch is needed only when a command's effect is computed, and even then it returns the same closed section-operation vocabulary, never bespoke events. The one sanctioned place to add fold logic is a bounded, pure meta-reducer scoped to a section's typed meta bag: it may read the operation and the section but write only meta, never canonical content, the section tree, or status — so the structure tooling depends on stays engine-owned.

```ts
export type SectionOp =
  // field / element edits
  | { readonly op: "setField";         section: string; field: string; value: IField }
  | { readonly op: "applyTextEdits";   section: string; field: string; block?: BlockId;
      edits: TextEdit[]; expectedHash?: string }   // content-hash precondition rejects stale edits
  | { readonly op: "addElement";       section: string; field: string; id: string;
      fields: Record<string, IField>; status?: string; meta?: Record<string, unknown>; index?: number }
  | { readonly op: "removeElement";    section: string; field: string; id: string }
  | { readonly op: "moveElement";      section: string; field: string; id: string; toIndex: number }
  | { readonly op: "setElementField";  section: string; field: string; id: string; elementField: string; value: IField }
  // block-tree edits (a blocks field)
  | { readonly op: "addBlock";         section: string; field: string; block: IBlock; index?: number }
  | { readonly op: "removeBlock";      section: string; field: string; block: BlockId }
  | { readonly op: "moveBlock";        section: string; field: string; block: BlockId; toIndex: number }
  | { readonly op: "setBlock";         section: string; field: string; block: IBlock }
  // section-tree edits
  | { readonly op: "addSection";       key: string; name: string; description?: string;
      parentSection?: SectionId | null; index?: number; id?: SectionId }
  | { readonly op: "removeSection";    section: string }
  | { readonly op: "moveSection";      section: string; parentSection: SectionId | null; toIndex: number }
  | { readonly op: "renameSection";    section: string; name: string }
  // meta
  | { readonly op: "setMeta";          section: string; element?: string; path: (string | number)[]; value: unknown }
  // FSM
  | { readonly op: "transition";       level: "page" | "element"; section?: string; field?: string; element?: string; event: string };
```

Deterministic, language-aware tooling lives in the host as read-side projections over canonical source, fed by the same projection tailer as the SQL read model. The outline comes straight from folded section names and tree. Symbol indexes, cross-references, call graphs, and type indexes are derived by parsing code fields. Semantic operations such as rename and extract are computed here and applied back through guarded commands. Per-language analyzers load through a runtime language-analyzer registry that mirrors the model registry's dynamic-import pattern and expose a narrow analyzer contract — parse, symbols, references, rename. Parsers are dependencies of the analyzer plugins, never of the engine, which stays free of language machinery.

The content model shipped greenfield. There was no data migration: page types are authored directly on sections, and golden render tests assert the deterministic Markdown projection of structured state. The richer write model and its read-side projections were built in sequence — sections and field-kinds as the substrate and the Markdown render read model first, then read-only outline and symbol-index projections behind the language registry, then semantic write-back operations once justified by need.

## Components
_No components._

## Dependencies
- **implements** → [Section-operation reducer & fold](architecture:mpzoiq0g-004l-dunnzt) — Section operations are folded by the one built-in engine reducer; the originating command name is recorded in event metadata so history stays semantic without per-type events.
- **implements** → [Deterministic render](architecture:mpzoivv2-004v-6mp3ve) — The configurable Markdown render read model walks the section tree and dispatches on field-kind; render is a read model, not write-side logic.
- **depends-on** → [Page-type authoring & registry](architecture:mpzoithh-004r-hd8cmg) — definePageType declares sections, field-kinds, the lifecycle FSM, structural contracts, and render config — never reducers, renderers, or bespoke events.
- **exposes** → [SQL read model](architecture:mpzoix0f-004x-dlxbrw) — Canonical content (plain, JSON-serializable, structuredClone-safe) is projected into the durable SQL read model as jsonb over the same fold.
- **exposes** → [Projection tailer](architecture:mpzoiy4k-004z-xrbx5a) — Outline, symbol-index, and cross-reference projections — and the SQL read model — are all fed by the same projection tailer over the canonical fold.

## Code references
_No code references._

## Data model
The write-model shape is a tree of pages, each an IPageNode carrying an ordered array of ISection; every section holds a record of IField keyed by field key, where each field is one of the closed field-kinds (scalar, prose, code, attachment-ref, ref, blocks, list); list fields hold IItem elements, and blocks fields hold an ordered IBlock sequence of inline runs. A field is addressed by (sectionKey, fieldKey), a list element by (sectionKey, fieldKey, itemId). The verbatim type definitions are in the first code note below; they live in wiki/src/api.ts.

## Usage
_None._

## Invariants & constraints
- No AST in the fold or the event log — canonical text plus a content hash only; an AST is always a derived read model, never stored history.
- Render is identity, never a formatter — a code field fences its source verbatim; reformatting, if ever, is an explicit command that rewrites canonical text into a new event, never a render-time computation.
- Ordering is explicit via a stable order field rendered with stableBy — never JavaScript object-key insertion order, for sections, fields, list elements, blocks, and inline runs alike.
- Ids are stable and minted from the injected newId() — for sections, items, and blocks — never derived from content or array/AST positions.
- Attachments are content-addressed references (ref, mime, name) — never inline bytes, which would bloat the append-only stream and break snapshot bounding.
- The only rich text is the structured blocks model: a closed vocabulary of typed, id-bearing block and inline nodes; ingestion rejects Markdown syntax inside a text run, forcing it into a code-span, a mark, or a ref.
- No parser, AST, LSP, or formatter lives in the engine — all language machinery is host-side behind a runtime registry.
- A new block or inline kind requires a written decision record proving closed render, stable-id addressability, and no opaque leaf — the closed vocabulary does not grow casually.
- A FieldDecl carries two orthogonal contract knobs: required (the field must be PRESENT in the materialized set — required sections materialize fields EMPTY at create, so presence is not content) and requiredIn (the statuses in which the field must be AUTHORED — the dual of mutableIn). The engine enforces requiredIn on the write-side dry-run post-state across every write path, rejects entering or blanking-while-in a listed status, surfaces the gate predictively in describeMutations (unmet names the section.field paths), and lints unknown/unreachable/initial statuses and element fields at registration. Authored-ness per kind: scalar, prose, code non-empty; blocks, list non-empty; ref set; serial, attachment-ref always.

## Synced commit
c6668d1
