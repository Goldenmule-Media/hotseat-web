# wiki-models — Design Document

> Status: **Draft / living document** · Last updated: 2026-06-03 · Owner: @benjamin
>
> The **schema layer** for the wiki engine: versioned **page-type bundles**, authored against the
> engine's **declarative** page-type API and **loaded by reference at runtime** so they can be
> **hot-reloaded** without restarting the server. The core packages stay schema-agnostic — `wiki`
> (engine), `wiki-mcp` (read model / engine host), and `wiki-server` (stream + MCP host) ship **no
> concrete page types**; all of them live here. A model is built to JS, addressed by a module
> specifier, and `import()`-ed by `wiki-mcp`'s live model registry
> ([wiki-mcp/DESIGN.md ADR-M6](../wiki-mcp/DESIGN.md)).
>
> A page type is now a **declaration**, not a program: it declares a tree of typed **Sections**, the
> engine-owned **field-kinds** they hold, **element** (list-item) types with their FSMs, structural
> **contracts**, and a static **render config**. The engine owns the one built-in reducer, the
> closed **section-operation** vocabulary, and the Markdown render read model — so a model writes **no
> `apply` reducer, no `render` function, and no per-type events** ([docs/structured-content.md §9](../docs/structured-content.md)).

---

## Table of contents

1. [Motivation & scope](#1-motivation--scope)
2. [What a model bundle is](#2-what-a-model-bundle-is)
3. [Declarative authoring — what a page type declares](#3-declarative-authoring--what-a-page-type-declares)
4. [Field-kinds available to models](#4-field-kinds-available-to-models)
5. [Versioning & the `vN/` layout](#5-versioning--the-vn-layout)
6. [The retention invariant & authoring rules](#6-the-retention-invariant--authoring-rules)
7. [Loading by reference & the reload lifecycle](#7-loading-by-reference--the-reload-lifecycle)
8. [The `featurePageTypes` move, re-expressed on Sections](#8-the-featurepagetypes-move-re-expressed-on-sections)
9. [Non-goals & future work](#9-non-goals--future-work)
10. [Appendix A: Decision records](#appendix-a-decision-records)

---

## 1. Motivation & scope

Page types are not configuration — they declare the **structure and legality** the engine folds and
gates, so they are part of the engine's consistency contract, not a runtime flag. The engine treats
them as **plugins**: `createWiki({ pageTypes })` takes a fixed set, and every write is validated and
folded against the owning type's declaration ([wiki/DESIGN.md §7.3](../wiki/DESIGN.md)). `wiki-models/`
is where those plugins live, so that:

- **The core stays schema-agnostic.** No concrete page type is baked into `wiki`/`wiki-mcp`/`wiki-server`.
  A deployment chooses its schema by pointing the runtime at one or more model bundles. The engine owns
  the **metaschema** — `definePageType`, the FSM, the field-kinds, the Sections — and **zero schema**
  ([docs/structured-content.md §1](../docs/structured-content.md)).
- **Schema is swappable at runtime.** A model can be rebuilt and **reloaded into a running server** — the
  intended loop is *edit a model → build → reload*, driven from a build pipeline, not by an agent.

Critically, what a model *declares* changed. It no longer carries a hand-written reducer, renderer, or
bespoke event types: content mutates only through the engine's **closed section-operation vocabulary**,
folded by **one built-in reducer**, and renders through the engine's **configurable Markdown render read
model** ([docs/structured-content.md §8–§9](../docs/structured-content.md)). A model contributes only
its **section layout**, **field-kinds**, **element types + FSMs**, **structural contracts**, and **render
config**. This is the central change this revision records (§3, ADR-M7).

**In scope:** the bundle shape, what a declarative page type declares (§3), the field-kinds a model may
use (§4), the per-page-type `vN/` version layout, the retention invariant that keeps old events
foldable, and the authoring contract the runtime relies on. **Out of scope (owned elsewhere):** the one
built-in reducer, the section-operation vocabulary, the render read model, the well-formedness check
([docs/structured-content.md §4–§9](../docs/structured-content.md)); and the live registry, the
cache-busted `import()`, reprojection, and the control endpoint — those are `wiki-mcp`'s concern
([ADR-M6](../wiki-mcp/DESIGN.md)). This doc states the *authoring contract*; `wiki` owns the *fold and
render mechanism*, `wiki-mcp` owns the *load mechanism*.

## 2. What a model bundle is

A **model bundle** is the unit of load, reload, and unregister: a built ESM module, addressed by a
module specifier (e.g. `wiki-models/feature` or a path), whose default export is an **array of
declarative page-type definitions** — exactly the shape `createWiki`/`createWikiMcp` already accept as
`pageTypes`.

```
wiki-models/
├─ package.json            # name "wiki-models"; depends on `wiki` (the page-type authoring API only)
├─ DESIGN.md               # ← this document
└─ src/
   └─ feature/             # the "feature" bundle
      ├─ index.ts          # default export: [FeatureBrief, ImplementationPlan, ImplementationChecklist, TestingPlan]
      ├─ elements.ts       # element (list-item) types + their status FSMs (question, task, case, …)
      ├─ feature-brief/
      │   ├─ index.ts      # composes ONE declarative page type:
      │   │                #   { type, version: N, initialStatus, statusTransitions,
      │   │                #     sections, elements, sectionSet, commands, render, upcasters }
      │   ├─ v1/           # version 1 of this type's content-schema payloads
      │   │   ├─ schema.ts     # section/field-kind/element shapes at v1
      │   │   └─ upcast.ts     # (v1 section payload) => v2 section payload
      │   ├─ v2/
      │   │   ├─ schema.ts
      │   │   └─ upcast.ts     # (v2 payload) => v3 payload
      │   └─ v3/               # CURRENT version: the section/field shapes the live declaration targets (no upcast — head)
      │       └─ schema.ts
      └─ … (one folder per page type)
```

> The `vN/` foldering is the layout this package **introduces** for **content-schema evolution** —
> reshaping a section's fields, an element's fields, or a `meta` bag (§5). It is **not** a per-type-event
> layout: there are no per-type events to version. The worked-example types are all at `version: 1`
> today, so each begins life with a single `v1/` and no upcasters.

`wiki-models` depends only on the engine's **authoring** surface (the `definePageType` / `defineElementType`
/ `t` API, [wiki/DESIGN.md §7.3](../wiki/DESIGN.md)) — never on `wiki-mcp` or `wiki-server`. It contains
**no runtime**; it is **declaration** that a host imports. A second schema lives as a sibling bundle (or
its own package, `wiki-models-acme/`) with no change to any core package.

## 3. Declarative authoring — what a page type declares

A page type is declared, not programmed. `definePageType` declares **structure, legality, and
presentation**; the engine supplies the rest ([docs/structured-content.md §9](../docs/structured-content.md)).
The shape:

```ts
definePageType({
  type: "feature-brief",
  version: 1,
  initialStatus: "draft",
  statusTransitions: [ /* lifecycle FSM only — §9.4 */ ],
  sections:   { /* §9.2 — keyed sections, each declaring its fields by field-kind */ },
  elements:   { /* §9.3 — list-item types: fields-by-kind + optional status FSM */ },
  sectionSet: { /* §6 — open | closed, prohibited, cardinality */ },
  commands:   { /* §9.4 — declarative transitions + semantic ops; `produces` is the escape hatch */ },
  render:     { /* §9.7 — static, logic-free render config */ },
  upcasters:  { /* §5 — content-schema reshapes; usually empty at v1 */ },
})
```

What a model **declares** (and the engine **supplies**):

| A model declares | The engine supplies (engine-owned) |
|---|---|
| `sections` — keys, names, field-kinds, `required`, `mutableIn` write-gate (§9.2) | The one built-in **section reducer** that folds every operation |
| `elements` — list-item types with fields-by-kind + status FSM (§9.3) | The closed **section-operation** vocabulary (`setField`, `addSection`/…/`renameSection`, `addBlock`/…/`setBlock`, `addElement`/…/`setElementField`, `applyTextEdits`, `setMeta`, `transition`) |
| `sectionSet` + `requiredSections` + per-field `required`/schema (§6) | The well-formedness check run inside `decide` (re-runs on every OCC rebase) |
| `mutableIn` write-gates; transition `preconditions` (§6) | The FSM legality guard and the precondition evaluation window |
| `render` config — section order, headings, per-kind display, grouping, element templates (§9.7) | The configurable **Markdown render read model** (a read-model sibling of the SQL read model + AST projections) |
| Commands — declarative `target` + args→field `set` + `transition` + `preconditions` (§9.4) | Command attribution: the originating command is recorded in **event metadata**, so history stays semantic without per-type events |
| `reduceMeta` — *the only* fold-extension: a bounded, pure, meta-scoped hook (§9.5) | Everything else folds through the built-in reducer |

So a model writes **no imperative `apply`, no `render` function, and no per-type event types** — all
three are engine-owned ([docs/structured-content.md §9](../docs/structured-content.md)). The single
sanctioned place to add fold logic is a **pure, meta-scoped `reduceMeta(meta, op) => meta`** on a
section's typed `meta` bag, which can read the operation and the section but may write **only `meta`** —
never canonical content, the section tree, or status ([docs/structured-content.md §9.5](../docs/structured-content.md)).

**Commands are declarative by default.** A command names a `target` (`section` / `element` / page), an
args→field `set` mapping, the FSM `event` it fires, and any `preconditions` — and needs no `produces`.
`produces` is the **escape hatch**, used only when a command's *effect* is computed (not a direct
args→field copy); it returns a list of **section operations** — the same closed vocabulary the generated
commands and the engine reducer use — never bespoke events
([docs/structured-content.md §9.4](../docs/structured-content.md)). Declaring a section/field also
**implies its CRUD** (the *generated structural commands* — set a field, add/remove/move an element),
each gated by the target's `mutableIn`; the author writes nothing for those.

All of these declarations are validated **mechanically** in the `Registry` constructor at load (and on
hot-reload): keys resolve, field-kinds are known, predicates are callable, FSM transitions are
consistent ([docs/structured-content.md §6, §9.6](../docs/structured-content.md)).

## 4. Field-kinds available to models

A section declares its fields by **field-kind** — a **closed, engine-owned** vocabulary. *Which* kinds a
type uses is model data; the *set* is fixed in the engine so the fold and the render read model handle
any field generically ([docs/structured-content.md §3](../docs/structured-content.md)). The kinds a model
may use:

| Kind | Use it for | Default render |
|---|---|---|
| `scalar` | a simple leaf (string / number / boolean) | inline value |
| `prose` | structured prose (rejects fenced ``` code — use `code`) | text block |
| `code` | canonical source `{ lang, source, hash }`, edited via `applyTextEdits` | verbatim fence |
| `attachment-ref` | a content-addressed external blob | link |
| `ref` | a **typed cross-reference** to a section / page / code symbol / block; the displayed label is **render-derived**, so reorders / renames / renumbers update it automatically, and integrity is checked like a link | derived label |
| `list` | a homogeneous, ordered list of one **element type** (§9.3); elements may carry a model FSM | per-element template / grouping |
| `blocks` | the **document** field-kind: an ordered, heterogeneous sequence of typed block nodes (paragraph / heading / code / list / table / quote / divider) with inline runs (text+marks / code-span / `ref`) | a fixed per-block walk |

Two field-kinds are the new authoring payoff for `wiki-models`:

- **`blocks` — document-style pages.** When a section's content is a flowing document rather than a set
  of named form fields, give it a `blocks` body. Blocks are **structured** rich text, not an opaque blob:
  a closed vocabulary of typed, `id`-bearing nodes rendered by identity, with inline runs carrying marks
  ProseMirror-style (a `text` run holds a canonical-sorted *set* of marks, never nested emphasis nodes)
  ([docs/structured-content.md §3.1–§3.3](../docs/structured-content.md)). A model never gets an
  `html`/`raw`/`markdown` block, and a `text` run may not carry Markdown syntax — that line is what keeps
  the document analyzable.
- **`ref` — cross-references.** A first-class typed reference whose displayed form is a projection of its
  target (a section number, a page title, a code symbol name), at both field depth and *inline* depth
  inside a `blocks` body. This is the thing a document model buys that sub-sectioning never can: a
  reference *inside a sentence* that re-labels itself on reorder/rename and can never dangle
  ([docs/structured-content.md §3.2](../docs/structured-content.md)).

**A section may be a record, a document, or both.** A section is the one content container: it may hold
**named form fields** (a *record* — e.g. `summary: prose`, `priority: scalar`), a **`blocks` body** (a
*document*), or both at once ([docs/structured-content.md §2–§3.1](../docs/structured-content.md)). Use a
**section** (vs a `blocks` `heading`) when a unit needs a stable key, a contract, a write-gate, `meta`,
or to be a command target / outline entry; use a block otherwise
([docs/structured-content.md §2 "Sections vs blocks"](../docs/structured-content.md)).

**Sections have no FSM; elements may.** All lifecycle lives in the model — the page-type status FSM and
any **element** FSM. A repeatable sub-entity (e.g. a `question`) is a `list` element and may carry a
model-declared status FSM (`question: open → resolved`); because the FSM is on the *item*, "Sections have
no FSM" holds ([docs/structured-content.md §2, §9.3](../docs/structured-content.md)).

## 5. Versioning & the `vN/` layout

The contract this rides on already exists in the engine — **upcast-to-latest**
([ADR-W1](../docs/wiki/decision-records/upcast-to-latest-with-self-contained-version-history.md)). Each page type
declares a single **current** `version: number` and a sparse `upcasters: { [v]: (payload) => nextPayload }`
map. What changed under the declarative model is **what a payload is**: there are no per-type events, so
upcasters reshape the **content-schema payloads** of the closed section operations — a section's fields,
an element's fields, or a `meta` bag — not bespoke event payloads
([docs/structured-content.md §10 "Section schemas and field-kinds version through the existing
schemaVersion + upcasters"](../docs/structured-content.md)).

- On **write**, the engine stamps each committed operation with the def's *current* `version`
  (an unregistered type falls back to `schemaVersion` 0).
- On **fold**, the engine reads `schemaVersion` and **chains the upcasters forward** from that version up
  to `def.version`, then folds the upcasted payload through the **one built-in reducer**. A missing step
  is a no-op pass-through; `schemaVersion > def.version` (an event *newer* than the registered def) is a
  **hard error** → the workspace's projection halts.
- `fingerprint()` is `"type@version,…"`; bumping any type's `version` changes the per-workspace
  fingerprint and triggers a refold.

So **versions are per page type**, and the `vN/` folders are an *authoring layout* that composes into
that existing contract — they do **not** become N separate reducers (there is only ever the one
engine-owned reducer). Each `vN/` owns the **content-schema shape at version N** (section/field/element
shapes) plus the **upcaster from N to N+1**; the head version owns only its schema shape, which the live
declaration targets. The folders form a typed chain:

```
v1.schema ─(v1/upcast)→ v2.schema ─(v2/upcast)→ v3.schema ─→ (declaration targets head schema)
```

The page type's `index.ts` assembles one declaration: `version` = the head number, `upcasters` wired
from each `vN/upcast.ts`, and `sections`/`elements`/`render` written against the **head** schema only.
(The `v1 → v2 → v3` chain is illustrative — the worked-example types are all at `version: 1` today, so
each begins life with a single `v1/` and no upcasters.) A pure render-config change does **not** need a
version bump (render is a read model over folded state, not stored payload, §9.7); only a change to the
**stored shape** of a field / element / `meta` does.

## 6. The retention invariant & authoring rules

Because the engine upcasts to the head and folds with a single reducer, a bundle must be **self-contained
across its whole history**. The invariant:

> **A bundle must retain the complete upcaster chain for every content-schema version it has ever
> written.** Any operation in any stream was stamped with some historical `version`; folding it climbs
> the chain to the head. Drop an intermediate `vN/upcast.ts` and that step silently passes the payload
> through unchanged (likely wrong); reshape a section's fields without a matching upcaster and you corrupt
> or halt.

Authoring rules that keep that true:

- **Versions are append-only and monotonic.** To change a section/field/element/`meta` shape, add
  `v(N+1)/` with a `vN/upcast.ts` step and bump the type's `version` — **never edit a shipped
  `vN/schema.ts`**. A shipped version is immutable history.
- **The declaration targets only the head shape.** All backward compatibility is expressed as upcasters,
  not as branches anywhere — and there is nowhere to branch: the reducer is engine-owned, and a model
  writes no `apply`.
- **Render is not versioned content.** Render config is static presentation over folded head state; a
  bespoke renderer no longer exists, so there is no renderer to keep version-compatible. Reshaping a
  field changes both the upcaster chain *and* (if labels/order moved) the render config; rewording a
  heading changes only render config.
- **Lowering a version is a halt, by design.** If a reload ships a def whose `version` is *below*
  operations already in a stream (a rollback), those are `schemaVersion > version` → the workspace halts
  loudly. Locally this is the desired signal ("you rolled back past live data"); fix forward and reload.
- **A bundle is the reload unit.** Reload replaces the whole bundle atomically; a partial set is never
  registered.

## 7. Loading by reference & the reload lifecycle

`wiki-models` is **declaration**; the runtime is `wiki-mcp`'s live model registry
([ADR-M6](../wiki-mcp/DESIGN.md)). The contract this package satisfies:

- **Built artifact.** A bundle ships as built ESM resolvable on disk at runtime (it cannot be pre-bundled
  into the server image — see ADR-M6). The build pipeline produces it, then asks the server to (re)load
  it.
- **Addressed by specifier.** Load/reload/unregister name a bundle by module specifier/path; the server
  `import()`s it. `wiki-server` only proxies the request and never learns the page-type declaration, so
  it stays schema-agnostic.
- **Lifecycle.** *Load* registers a bundle (its types become creatable; halted workspaces whose events
  that bundle now covers reproject and clear). *Reload* is a **hard replace** — re-import the rebuilt
  bundle and swap it. *Unregister* hard-removes it; any workspace with live events of a removed type halts
  (a **local escape hatch**, not a production operation). In practice the common op is *reload* ≈ replace,
  since a self-contained bundle (§6) keeps every prior content-schema version, so a replace never loses
  the ability to fold old operations.

The reprojection, hot-handle eviction, cache-busting, and the `/_server/models` control endpoint are all
specified in [wiki-mcp ADR-M6](../wiki-mcp/DESIGN.md). The render read model and any AST/symbol
projections are likewise host read models keyed off the same registry — a render-config change reprojects
render exactly as a model reload reprojects the SQL read model
([docs/structured-content.md §8, §11](../docs/structured-content.md)).

## 8. The `featurePageTypes` move, re-expressed on Sections

The `feature` bundle is the worked example. Under the declarative model it is re-authored **directly on
sections** — greenfield, with **no `fields`/`items` containers, no per-type events, no `apply`, no
`render` function**, and no migration ([docs/structured-content.md §9, §12 "greenfield"](../docs/structured-content.md)).
The four page types stay: **feature-brief / implementation-plan / implementation-checklist /
testing-plan**, with the same lifecycle FSMs, the same element types, and the same two cross-page gates
— but every gate, item, and renderer is now a **declaration**.

What maps to what:

| Old (imperative) | New (declarative) |
|---|---|
| Scalar field `summary` + bespoke `SummarySet` event | `summary` **section** with a `body: prose` field; edited by the generated `setField` command |
| `page.items.component / constraint / question / commit` | `list` fields holding **element** types `component` / `constraint` / `question` / `commit` (§9.3) |
| `question` item FSM (`open → resolved`) in `items.ts` | `question` **element** with `status: { initial: "open", transitions: [t("open","answer","resolved")] }` |
| `answerQuestion` `produces` emitting `QuestionAnswered` | declarative command: `target` the `question` element, `set: { answer: arg("answer") }`, `transition: { level: "element", event: "answer" }` |
| `beginImplementation` hand-coded gate (plan ≥1 step ∧ testing-plan ≥1 case) | declarative `transition.preconditions` on the `building` transition (§6) |
| `ship` hand-coded gate (checklist 100% ∧ all cases passed ∧ no open questions) | declarative `transition.preconditions` on the `shipped` transition |
| `renderBrief` / `renderChecklist` … bespoke renderers | static `render` config: section order, headings, the open/resolved question split as a `groupBy: "status"` grouping |
| `requiredChildren: [plan, checklist, testing-plan]` | unchanged page-tree contract (workspace tree, not the new intra-page section tree) |

### 8.1 `feature-brief`, concretely

Status FSM unchanged (`draft → planning → building → review → shipped`, plus `abandoned`). The summary
becomes a `prose` section; components / constraints / questions / commits become `list` sections;
`question` carries its FSM as an element; the two cross-page gates become declarative preconditions; and
the open/resolved question split becomes render config.

```ts
// elements.ts — list-item types + their FSMs (shared by the bundle)
export const constraint = defineElementType({
  fields: { text: { kind: "prose", required: true } },
});
export const component = defineElementType({
  fields: { name: { kind: "scalar", required: true } },
});
export const question = defineElementType({
  fields: { text: { kind: "prose", required: true }, answer: { kind: "prose" } },
  status: { initial: "open", transitions: [t("open", "answer", "resolved")] },
});
export const commit = defineElementType({
  fields: {
    sha: { kind: "scalar", required: true },
    message: { kind: "prose", required: true },
    url: { kind: "scalar" },
  },
});

// feature-brief/index.ts
export const FeatureBrief = definePageType({
  type: "feature-brief",
  version: 1,
  initialStatus: "draft",
  requiredChildren: ["implementation-plan", "implementation-checklist", "testing-plan"],

  // ── lifecycle FSM (page level) — content-edit legality lives in `mutableIn`, not here ──
  statusTransitions: [
    t("draft", "beginPlanning", "planning"),
    t("planning", "beginImplementation", "building"),
    t("building", "reopenPlanning", "planning"),
    t("building", "submitForReview", "review"),
    t("review", "requestChanges", "building"),
    t("review", "ship", "shipped"),
    t("draft", "abandon", "abandoned"),
    t("planning", "abandon", "abandoned"),
    t("building", "abandon", "abandoned"),
    t("review", "abandon", "abandoned"),
  ],

  // ── section layout: a record section (summary) + four list sections ──
  sections: {
    summary: {
      name: "Summary",
      required: true,
      mutableIn: ["draft", "planning"],
      fields: { body: { kind: "prose", required: true } },
    },
    components: {
      name: "Components affected",
      mutableIn: ["draft"],
      fields: { items: { kind: "list", element: "component" } },
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
    commits: {
      name: "Commits",
      mutableIn: ["building", "review"],
      fields: { items: { kind: "list", element: "commit" } },
    },
  },

  elements: { component, constraint, question, commit },

  // closed section-set: only the declared sections; the author may not add ad-hoc sections (§6)
  sectionSet: { closed: true },

  commands: {
    // semantic: set a field AND drive the element FSM — fully declarative (no `produces`)
    answerQuestion: {
      args: z.object({ questionId: z.string(), answer: z.string() }),
      target: { section: "questions", field: "items", element: { idArg: "questionId" } },
      set: { answer: arg("answer") },
      transition: { level: "element", event: "answer" },
    },

    // cross-page gate: a guarded page transition with declarative preconditions (§6)
    beginImplementation: {
      args: z.object({}),
      transition: {
        level: "page",
        event: "beginImplementation",
        preconditions: [
          childHasAtLeast("implementation-plan", "steps", 1, "≥1 implementation-plan step"),
          childHasAtLeast("testing-plan", "cases", 1, "≥1 testing-plan case"),
        ],
      },
    },

    ship: {
      args: z.object({}),
      transition: {
        level: "page",
        event: "ship",
        preconditions: [
          checklistComplete,      // ≥1 task AND all tasks done
          allCasesPassed,         // ≥1 case AND all cases passed
          noOpenQuestions,        // zero `open` questions on this brief
        ],
      },
    },
  },

  // ── render config replaces renderBrief; the open/resolved split is a grouping (§9.7) ──
  render: {
    title: "Feature: {title}",
    sections: [
      { section: "summary",     heading: "Summary",            field: "body", placeholder: "_No summary._" },
      { section: "components",  heading: "Components affected", field: "items", as: "bullets", item: "{name}",
        placeholder: "_None._" },
      { section: "constraints", heading: "Design constraints",  field: "items", as: "numbered", item: "{text}",
        placeholder: "_None._" },
      { section: "questions",   heading: "Questions",           field: "items", groupBy: "status",
        groups: [
          { when: "open",     heading: "Open questions",     item: "**{text}**" },
          { when: "resolved", heading: "Resolved questions", item: "**{text}** → {answer}" },
        ] },
      { section: "commits",     heading: "Commits",             field: "items", as: "bullets",
        item: "`{sha}` {message}", placeholder: "_None._" },
    ],
  },
});
```

Notes that anchor this to the spec:

- **No reducer, no renderer, no events.** `applyBrief`, `renderBrief`, and the `SummarySet` /
  `ComponentAdded` / `QuestionAnswered` / … event types are gone. Content flows through the generated
  structural commands (`setField`, `addElement`, …) and the few declared commands above, all folded by
  the engine's one reducer; history stays semantic because the originating command is recorded in event
  metadata ([docs/structured-content.md §9, §9.4](../docs/structured-content.md)).
- **The two gates are declarative preconditions.** Each is a pure `(page, related) => true | { unmet }`
  evaluated inside the rebase-retried `decide` window, replacing the hand-coded gate prologues — and
  makes "why is `ship` blocked?" introspectable ([docs/structured-content.md §6](../docs/structured-content.md)).
  The cross-page reads (`related.childrenOf` → plan steps / checklist tasks / testing-plan cases) are the
  same reads the old `produces` did, now expressed as reusable predicate helpers.
- **`mutableIn` is the write-gate.** The old `t("draft","addConstraint","draft")` self-transitions that
  existed only to make a content command legal in a status are gone; legality of editing the
  `constraints` section is exactly `mutableIn: ["draft","planning","building"]`. The `statusTransitions`
  list now carries **lifecycle only** ([docs/structured-content.md §6, §9.2, §9.4](../docs/structured-content.md)).
- **The open/resolved split is render config**, not renderer logic — a `groupBy: "status"` with two
  groups and element templates. There are no expressions in render; the `q.answer` interpolation is a
  template substitution `{answer}`, and any value that needed computing would be materialized into a
  field by a command, never computed at render time ([docs/structured-content.md §8, §9.7](../docs/structured-content.md)).

### 8.2 The other three, in brief

- **implementation-plan** (`draft → ready`): a `steps` `list` section (element `step`, `ordered: true`,
  no FSM), reordered via the generated `moveElement`; a `questions` `list` section reusing the `question`
  element. The old `StepsReordered` event becomes `moveElement` operations.
- **implementation-checklist** (`building → complete`): a `tasks` `list` section, element `task` with FSM
  `todo ⇄ done` (`check`/`uncheck`). The checkbox render (`[x]`/`[ ]`) is a render template keyed off the
  element status; `checklistComplete` (used by `feature-brief`'s `ship`) reads this section.
- **testing-plan** (`draft → ready`): a `cases` `list` section, element `case` with FSM
  `planned → passed | failed`, `failed → passed`; `allCasesPassed` reads it.

All three lose their bespoke `apply`/`render` and per-type events the same way; each is a section layout +
element FSMs + render config + (where applicable) a precondition helper exported for the brief's gates.

### 8.3 The engine's test dependency

The engine's own test suite leans on the `feature` bundle (`wiki/test/*`). Two options, to settle when
the move lands: (a) the engine tests import the `feature` bundle from `wiki-models` as a **dev
dependency**, or (b) the engine keeps a **tiny throwaway fixture** page type for its tests. (a) keeps one
canonical schema; (b) keeps the engine's test graph free of a downstream dependency. Leaning (b) for the
engine's unit tests, (a) for any integration test that wants the real bundle. (Engine golden render
tests are rewritten against the render read model, not the retired per-type renderer,
[docs/structured-content.md §12 Phase 1](../docs/structured-content.md).)

### 8.4 The `adr` bundle — decisions as first-class records

A second bundle, `adr` (`src/adr/`), authored on the same surface, ships one page type:
**`decision-record`** (human label **ADR**). It exists to dissolve a real wart: this project's own
architecture decisions lived as flat ADR appendices at the bottom of five separate `DESIGN.md` files —
no status, no lifecycle, no edge from a decision to the one that revises it, and identity that was only
*per-file* (so `wiki-mcp` and `wiki-models` each shipped a different **ADR-M7**, a collision a single
namespace makes impossible). The `decision-record` type makes each decision a typed, FSM-governed,
globally-identified wiki page instead.

- **Shape** — Michael Nygard's template plus the metadata a lossless migration needs: a `meta` section
  (`date` — a **stored** ISO string, never `new Date()`; `scope` — the package/area, for filtering;
  `legacyId` — the original label, kept for traceability, *not* identity; and a `deciders` list),
  `context` (`prose`), `decision` and `consequences` (`blocks`, so a decision can carry a code/interface
  snippet), and a `relations` section holding a single `supersededBy` `ref`. `sectionSet: { mode: "closed" }`.
- **Lifecycle** — `proposed → accept → accepted`, `proposed → reject → rejected`; an accepted record is
  later `supersede`d → `superseded` or `deprecate`d → `deprecated`. The last three are terminal.
- **Supersession is an integrity-checked edge, not prose.** The `accepted → superseded` transition is
  gated by a `namesSuccessor` `Precondition`: a record may enter `superseded` only once its `supersededBy`
  ref resolves to a *live, other* `decision-record`. Because a precondition runs *before* its own
  command's ops and receives no args, superseding is **two ops in one atomic batch** — `setSupersededBy(id)`
  (the engine's ref-integrity rejects a dangling target at set time) then `supersede()` (the gate reads the
  now-committed ref) — landed via `mutateMany`. The reverse "Supersedes" view is a render projection over
  *incoming* refs, so there is no second source of truth to rot. (This needed exactly **one** generic,
  schema-agnostic engine change: a `ref` case in `kindFor` so the declarative `set:` sugar builds a
  page-ref from a string id — refs are now first-class in `set:` for every model. Everything else —
  `setField` carrying a ref, ingestion ref-integrity — already existed, proven by `architecture`'s
  dependency ref.)
- **Render** — title `ADR: {title}`; a derived metadata block; Context → Decision → Consequences; then a
  derived `Relations` block showing both `Superseded by` (the outgoing ref) and `Supersedes` (the incoming
  ones). Deterministic and stable-ordered, so a future `docs/adr/` Markdown snapshot is churn-free.
- **Migration** — `scripts/migrate-adrs.ts` (engine-as-library) parses the five `DESIGN.md` ADR
  appendices into a **"Decision Records"** TOC inside this repository's own **wiki** workspace —
  a sibling of its Architecture and Feature Specs TOCs, since a workspace maps to a repo/product and is
  the single consistency aggregate (one ADR graph, cross-package supersession, not one workspace per
  package). It preserves each `legacyId`/`date`/`scope`, wires the supersedes edge the prose already
  states (`wiki-server/ADR-S1` → `ADR-S3`), and writes a wiki-native **meta-ADR** ("design decisions live
  in the wiki") as the first record — the one record with no `legacyId`, because it was born here, not
  migrated. It is re-runnable: it archives a prior Decision Records subtree first (renaming the old TOC out
  of the way, since the unique-sibling-title rule counts archived siblings and there is no hard delete).
  The `DESIGN.md` appendices are retired only once the separate Markdown-to-disk projection lands, so there
  is never a window with two sources of truth — nor one with none.

## 9. Non-goals & future work

- **Not a production hot-swap story.** Runtime reload targets the local *edit → build → reload* loop and
  pipeline-driven deploys; multi-replica coordinated reload is out of scope here.
- **No author-written reducers, renderers, or events — ever.** The reducer, the section-operation
  vocabulary, and the render read model are engine-owned (§3, ADR-M7). The only model fold-extension is
  the bounded, pure, meta-scoped `reduceMeta` ([docs/structured-content.md §9.5](../docs/structured-content.md));
  it can never touch canonical content. A model that "needs to extend the reducer" uses a typed `meta` bag
  + `reduceMeta`, not a hand-written `apply`.
- **No general constraint/rule language.** Contracts a model declares are decidable (presence,
  cardinality, type, closed/open, simple pure guard predicates) — not Datalog/SHACL-SPARQL/Dhall. Richer
  logic stays in a pure `produces` returning section operations
  ([docs/structured-content.md §13](../docs/structured-content.md)).
- **No language machinery in a model.** Parsers/ASTs/symbol indexes are **host** read models behind the
  `LanguageRegistry` (mirroring the `ModelRegistry`), never declared in a `wiki-models` bundle
  ([docs/structured-content.md §4, §11](../docs/structured-content.md)). A model declares only that a
  field is `code`; the host derives the AST.
- **No per-namespace model selection yet.** Which bundles a namespace uses (and persisting that choice)
  maps onto the engine's catalog config, *reserved, not yet designed*
  ([wiki/DESIGN.md §8](../wiki/DESIGN.md)).
- **No model signing / trust.** Loading a bundle is arbitrary code execution; first-party bundles are
  trusted. Any future "third-party model" path needs a trust boundary.
- **Version-routed reducers** were considered and rejected in favor of upcast-to-latest
  ([ADR-W1](../docs/wiki/decision-records/upcast-to-latest-with-self-contained-version-history.md)).
- **Open authoring questions** tracked upstream ([docs/structured-content.md §9.8](../docs/structured-content.md)):
  the generated-structural-command naming scheme, the `arg()` args-mapping DSL, the render-template
  grammar (`{field}` / `{field?}` / column directives), and how a derived (`mutableIn`-less) section is
  populated. These firm up the declarative authoring surface this package consumes.

---

## Appendix A: Decision records

These architecture decisions are now first-class, FSM-governed pages in the wiki, rendered to
[`docs/wiki/decision-records/`](../docs/wiki/decision-records/) (the engine's own Markdown
projection — see the [index](../docs/wiki/decision-records/index.md)). They are no longer
maintained inline here; the legacy IDs map to their pages:

| Legacy ID | Decision |
|---|---|
| ADR-W1 | [Upcast-to-latest with self-contained version history](../docs/wiki/decision-records/upcast-to-latest-with-self-contained-version-history.md) |
| ADR-M7 | [Declarative page types: the engine owns the reducer, render, and events; models declare structure + render config + contracts](../docs/wiki/decision-records/declarative-page-types-the-engine-owns-the-reducer-render-and-events-models-declare-structure-render-config-contracts.md) |
