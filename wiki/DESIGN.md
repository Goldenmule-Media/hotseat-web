# Structured Wiki Service — Design Document

> Status: **Draft / living document** · Last updated: 2026-06-01 · Owner: @benjamin
>
> A TypeScript-only, embeddable wiki engine. Pages are **structured, LLM-first documents**
> that change only through **named, typed mutations**, gated by a **finite state machine**.
> Pages live in a **workspace** — a graph of pages that is the unit of atomic consistency and
> maps to a single **Durable Stream** ([event-sourced](https://durablestreams.com/concepts)).
> Everything renders **deterministically** to Markdown.

---

## Table of contents

1. [Motivation & goals](#1-motivation--goals)
2. [Non-goals](#2-non-goals)
3. [Background research](#3-background-research)
4. [Core concepts & vocabulary](#4-core-concepts--vocabulary)
5. [Architecture overview](#5-architecture-overview)
6. [Domain model: the workspace aggregate & its entities](#6-domain-model-the-workspace-aggregate--its-entities)
7. [The guarded-mutation model (FSM)](#7-the-guarded-mutation-model-fsm)
8. [Event sourcing & CQRS](#8-event-sourcing--cqrs)
9. [Persistence with Durable Streams](#9-persistence-with-durable-streams)
10. [Public TypeScript API](#10-public-typescript-api)
11. [Deterministic Markdown rendering](#11-deterministic-markdown-rendering)
12. [Designed for LLMs](#12-designed-for-llms)
13. [Worked example: an LLM plans and ships a feature](#13-worked-example-an-llm-plans-and-ships-a-feature)
14. [Errors & validation](#14-errors--validation)
15. [Concurrency, idempotency & ordering](#15-concurrency-idempotency--ordering)
16. [Structure: folders, files, and module boundaries](#16-structure-folders-files-and-module-boundaries)
17. [Testing strategy](#17-testing-strategy)
18. [Future work](#18-future-work)
19. [References](#19-references)
- [Appendix A: Decision records](#appendix-a-decision-records)

---

## 1. Motivation & goals

We want a wiki that an LLM agent (and a handful of collaborating humans) can author and evolve
**safely and reproducibly**. Free-text wikis are a poor fit for autonomous agents: anything
can be overwritten, contradictions creep in, and meaning drifts. Instead:

- **The shape of every page is known.** Pages are typed documents (a "Feature brief", an
  "Implementation plan", a "Testing plan"), not blobs of prose.
- **Pages change only through named operations** with **typed arguments and return values** —
  `addConstraint({ text })`, `answerQuestion({ questionId, answer })` — never a
  `setBody(markdown)`.
- **Lifecycle is enforced, not suggested.** Each page and certain sub-entities have a
  **status** governed by an explicit **finite state machine**; a mutation is legal only where
  the FSM declares a transition. Once a question is `resolved`, nothing answers it again.
- **Pages form a graph inside a workspace**, and structural changes (reparenting, reordering,
  linking) — *plus cross-page content moves* — are **atomic**, because a workspace is a single
  event-sourced aggregate.
- **History is the source of truth** (event sourcing): audit, time-travel, replay, and a
  natural fit for agent loops.
- **Rendering is deterministic:** equal state always renders to byte-identical Markdown.

### Goals

- **G1 — Transport-free public API.** `wiki/` exposes *only* a TypeScript interface — no HTTP,
  no CLI (those are downstream packages). It *consumes* a Durable Streams server over HTTP for
  storage ([§9](#9-persistence-with-durable-streams)) but surfaces none of that.
- **G2 — Structured mutations with static + runtime types.** Every mutation has a compile-time
  signature *and* a runtime schema (LLM-generated arguments are validated).
- **G3 — FSM-gated lifecycle.** A status mutation is permitted **iff** the FSM declares a
  transition from the current status (self-transitions included).
- **G4 — Workspace = one event-sourced Durable Stream.** The workspace (a graph of pages) is
  the aggregate and the unit of atomic consistency. Storage durability (in-memory / file /
  ACID) is a *Durable Streams server* setting, not a wiki concern.
- **G5 — Atomic structural & cross-page operations.** Reparent, reorder, link, and cross-page
  content moves are all-or-nothing within a workspace.
- **G6 — One tail, all updates.** A reader subscribes to a single workspace stream and sees
  every page + structure change, in order.
- **G7 — Deterministic Markdown rendering** of any page or the whole workspace tree.
- **G8 — LLM-native ergonomics:** discoverable command catalog, JSON-Schema export for
  tool/function-calling, "only legal actions are offered," structured/actionable errors.

---

## 2. Non-goals

- **No HTTP / network interface *exposed* by `wiki/`.** It *uses* the Durable Streams client to
  reach storage but exposes no network surface. The durable host it *connects to* is a separate
  package, `wiki-server/` — a stream host, **not** an API over the engine (`wiki-server/DESIGN.md`).
- **No CLI in `wiki/`.** (See `wiki-cli/` future package.)
- **No free-form rich text.** Content is structured fields and typed items; prose lives inside
  *typed* fields (e.g. a `summary` string), never an opaque body.
- **No cross-*workspace* atomicity.** Consistency is per-workspace (one stream). Moving a page
  between workspaces is a non-atomic export/import (a saga), accepted as rare. *Within* a
  workspace, everything is atomic.
- **No general-purpose query language** in v1. Reads are "open a workspace," "load a page,"
  "walk the tree." Richer cross-workspace projections are [future work](#18-future-work).
- **Not a CRDT / not offline-merge.** We assume one logical writer per workspace at a time and
  resolve the occasional concurrent write with optimistic concurrency
  ([§15](#15-concurrency-idempotency--ordering)).

---

## 3. Background research

### 3.1 `typescript-fsm` (design reference — **not** a dependency)

Source: <https://github.com/WebLegions/typescript-fsm> (`src/stateMachine.ts`). A tiny,
dependency-free FSM. Relevant surface:

```ts
export interface ITransition<STATE, EVENT, CALLBACK> { fromState: STATE; event: EVENT; toState: STATE; cb: CALLBACK; }
export function t<STATE, EVENT, CALLBACK>(fromState, event, toState, cb?): ITransition;

export class StateMachine<STATE, EVENT, CALLBACK> {
  constructor(init: STATE, transitions?: ITransition[], logger?: ILogger);
  getState(): STATE;
  can(event: EVENT): boolean;                  // is a transition defined from current state?
  getNextState(event: EVENT): STATE | undefined;
  isFinal(): boolean;
  addTransitions(transitions: ITransition[]): void;
  dispatch<E extends EVENT>(event: E, ...args): Promise<void>;  // async, runs cb
  toMermaid(title?: string): string;
}
```

**Reference only — we do not depend on it.** We borrow two ideas — the declarative
transition-table shape (`t(fromState, event, toState)` / `ITransition`) and the pure
`can` / `getNextState` lookups — and reimplement them in ~20 lines
([§7.2](#72-our-own-guard-a-tiny-transition-table)). Taking the dependency would mean importing
a stateful, enum-oriented, single-machine-instance library only to call its trivial pure
methods, while shunning its headline API, `dispatch()` — which is a footgun here: it mutates
`_current` *before* running the callback and does **not** roll back on async failure (only
`SyncStateMachine` reverts), firing via `setTimeout(…,0)`. Owning the code is cleaner and lets
us model multiple FSM levels (workspace/page/item), self-transitions, per-transition metadata
for the LLM tool catalog, and a tailored `toMermaid()`. The event log — not any FSM's
`_current` — is our source of truth for status.

### 3.2 Durable Streams (the persistence substrate)

Concepts: <https://durablestreams.com/concepts> · Client: `@durable-streams/client` (npm
~v0.2.x) · Server: `@durable-streams/server` · By ElectricSQL, Dec 2025. Tagline: **"the data
primitive for the agent loop."**

- A **stream** is an *append-only, durable, strictly-ordered* sequence at its own URL. In
  **JSON mode** each POST stores one message; **POSTing an array stores each element as its own
  message**, and a GET returns a JSON array for the requested range.
- **Offsets** are *opaque, lexicographically-sortable string tokens*; reads resume from a saved
  offset. **Live tailing** via long-poll or SSE.
- **Storage is a *server* setting:** in-memory (default), file-backed (log files + LMDB), or
  ACID (redb). `@durable-streams/server`'s `DurableStreamTestServer` is built for "development,
  testing, CI, and embedding in a Node.js application"; production via a Caddy plugin or
  Electric Cloud.

Three findings that directly shape this design ([details + sources](#19-references)):

1. **Atomicity is per-stream, and a multi-event append is atomic.** Servers "SHOULD commit
   producer state updates and log appends atomically," and a writer can "atomically append a
   final message and close in a single operation." There is **no cross-stream transaction.**
   → *To change multiple pages atomically, they must be in the same stream.* A command's events
   are written as **one atomic POST of a JSON array.**
2. **Conditional append / optimistic concurrency is native.** StreamFS reports "stale-write
   detection via `PreconditionFailedError`," and the producer model carries epoch/sequence
   preconditions. → We get `expectedVersion` enforcement for free.
3. **StreamFS precedent (the hybrid we did *not* pick).** StreamFS — "a reactive agent
   filesystem in a stream" — keeps the **tree/structure in one metadata stream** and **file
   content in per-file streams** (`/_metadata` + `/_content/{id}`), so `move`/`rename` is atomic
   (structure-only). We instead put the *whole workspace* (structure **and** content) in one
   stream, because we need atomic **cross-page content** moves and a single tail for all
   updates — see [ADR-002](#adr-002--workspace-as-the-aggregate-one-stream-2026-06-01).

**The client (illustrative; the `EventLog` mapping lives in [§9.1](#91-one-stream-per-workspace)):**

```ts
import { DurableStream, IdempotentProducer, stream } from "@durable-streams/client";

const handle = await DurableStream.create({ url, contentType: "application/json", ttlSeconds });
const res = await stream<MyEvent>({ url, offset, live: false });   // live: true|false|"sse"|"long-poll"
const items = await res.json();
const unsub = res.subscribeJson(async (batch) => { /* batch.items; save batch offset to resume */ });
const producer = new IdempotentProducer(handle, "producer-id", { autoClaim: true, onError });
producer.append(event); await producer.flush(); await producer.close();
```

---

## 4. Core concepts & vocabulary

| Term | Meaning |
|---|---|
| **Workspace** | A graph of pages and **the aggregate** — the unit of atomic consistency. Maps to **one Durable Stream**. |
| **Page** | A typed wiki document, modeled as an **entity inside a workspace** (not its own stream). Has a status FSM, typed fields, and items. |
| **Tree** | The primary hierarchy: each page has one `parentId` (or none = top-level) and an ordered list of children. |
| **Link** | A typed, non-hierarchical cross-reference between two pages in the workspace (`from`, `to`, `role`), forming the graph beyond the tree. |
| **Page type** | A reusable definition (e.g. `feature-brief`): fields, item types, status FSM, commands, reducer, renderer. |
| **Status** | A page's (or item's, or the workspace's) current FSM state. |
| **Item** | A typed sub-entity inside a page (e.g. a `component`, `constraint`, `question`), optionally with its own status FSM. |
| **Mutation / Command** | A named, typed operation. **Structural** (workspace-scoped: createPage, reparent, reorder, link, moveItem…) or **content/status** (page-scoped, FSM-gated). |
| **Event** | An immutable fact appended to the workspace stream; folded to derive state. Carries the `pageId` it affects (if any). |
| **Reducer / `apply`** | Pure `(workspaceState, event) => workspaceState`. |
| **EventLog** | The single module that talks to Durable Streams (events↔messages, version↔offset, OCC). |

**Unifying principle (G3):** *every status mutation is an FSM transition* — including
self-transitions for content edits that don't change status (`draft —addConstraint→ draft`).
**Structural/relational rules** (acyclic tree, parent exists, unique sibling title, link target
exists) are **invariants** checked in command handlers, not status transitions.

---

## 5. Architecture overview

```
┌──────────────────────────────────────────────────────────────────────┐
│ Consumers:   wiki-cli (commander)      LLM agent                       │
└───────────────────────────────▲────────────────────────────────────────┘
                                 │  typed TS interface: createWiki(), IWorkspaceHandle, IPageView
┌────────────────────────────────┴───────────────────────────────────────┐
│ wiki/  (core library — exposes only a TypeScript interface)              │
│                                                                          │
│   ┌───────────────┐   ┌────────────────────────────┐  ┌──────────────┐  │
│   │  Page Types   │   │        Command Bus          │  │  Read Model  │  │
│   │ schema + FSM  │─▶ │ validate → guard (FSM /     │  │ (IReadModel) │  │
│   │ + reducer +   │   │ invariants) → decide →      │  │ token-gated  │  │
│   │ renderer      │   │ atomic append → fold → result│ └──────────────┘  │
│   └───────────────┘   └───────────────┬─────────────┘                    │
│   Write side: decide-aggregate (fold) ⟂ Read model: live-tail-fed (§8.6) │
│                          ┌─────────────▼──────────────┐                  │
│                          │ EventLog (thin wrapper):    │                  │
│                          │ events↔messages,            │                  │
│                          │ version↔offset, OCC + snap  │                  │
│                          └─────────────┬───────────────┘                 │
└─────────────────────────────────────────┼────────────────────────────────┘
                                           │ @durable-streams/client (fetch-based)
                                ┌──────────▼──────────────────┐
                                │ Durable Streams server       │
                                │ one stream per WORKSPACE      │
                                │ storage (server): mem·file·ACID
                                └──────────────────────────────┘
```

*Strict CQRS: the **Command Bus** drives the write-side **decide-aggregate** (fold → `Committed<T>`);
a **separate Read Model** (default in-memory `IReadModel`, fed by the live tail, token-gated —
[§8.4](#84-live-projection)/[§8.6](#86-consistency-tokens-read-models--cqrs)) serves all reads and
the Markdown renderer.*

**Command lifecycle (the hot path):**

1. **Resolve** the write-side decide-aggregate (from snapshot + folded tail, or a live-maintained
   cache); reads instead come from the read model ([§8.6](#86-consistency-tokens-read-models--cqrs)).
2. **Validate** the command's arguments against its schema (runtime).
3. **Guard:** status commands → ask the target entity's FSM `can(status, command)`; structural
   commands → check invariants (parent exists, no cycle, link target exists, …). Failure →
   `MutationNotAllowedError` / a typed structural error.
4. **Decide:** run the pure `produces(state, args, ctx)` → one or more **events** + a typed
   **result**.
5. **Append** the events as **one atomic POST** with `expectedVersion = foldedHead`. On
   `PreconditionFailedError` → **rebase-and-retry** ([§15](#15-concurrency-idempotency--ordering)).
6. **Fold** the events into the write-side decide-aggregate, update the cache, and **return
   `Committed<T>` — the result *plus* a `ConsistencyToken`** for the committed head `version`
   (after the append **and** any OCC rebase-retry; an idempotent/zero-event write returns the
   current head). Every write returns `Committed<T>` — including the structural commands that
   were `void` ([§6.2](#62-workspace--the-aggregate-stream-root), [§10.3](#103-the-iworkspacehandle-interface-one-workspace--the-aggregate)).

Steps 2–4 are pure; only step 5 touches the outside world. The fold above maintains the **write
side** (FSM/invariants/OCC); **reads are served from a separate, token-gated read model** fed by
the live tail ([§8.6](#86-consistency-tokens-read-models--cqrs)), not from this fold — strict
CQRS, eventual consistency. A read may carry the returned token to wait for read-your-writes.

---

## 6. Domain model: the workspace aggregate & its entities

### 6.1 One consistency aggregate, several modeled types

In event-sourcing terms there is exactly **one consistency aggregate — the Workspace** —
because a single stream's append is the only atomic unit Durable Streams offers
([§3.2](#32-durable-streams-the-persistence-substrate), [ADR-002](#adr-002--workspace-as-the-aggregate-one-stream-2026-06-01)),
and the operations that must be atomic span multiple pages:

- **Structural:** reparent a page, reorder siblings, add/remove a link — must keep the tree
  acyclic and referentially intact.
- **Cross-page content:** e.g. *move an open question from one page to another* — two pages change
  together.

Both require the affected pages to live in the **same stream**, so the **Workspace is the
aggregate (one stream)** and **Pages and Items are entities within it**. (Bonus: one stream =
one tail for all updates — G6.)

Sharing a stream does **not** mean modeling them vaguely: each type is specified like a
self-contained unit — its own **identity, lifecycle FSM, commands, events, reducer**, and (for
pages) renderer. The full catalog:

| Type | Role | Own stream? | Identity | Lifecycle FSM | Mutated by |
|---|---|---|---|---|---|
| **Workspace** | the aggregate / stream root | **yes** — 1 per workspace | `WorkspaceId` | `active → archived` | structural commands ([§6.2](#62-workspace--the-aggregate-stream-root)) |
| **Page** (per page type) | entity in the workspace | no (shares the stream) | `PageId`, type-prefixed | per page type ([§6.3](#63-page--an-entity-one-spec-per-page-type)) | page-scoped commands |
| **Item** (per item type) | entity inside a page | no | item id, scoped to its page | per item type ([§6.4](#64-item--an-entity-inside-a-page-one-spec-per-item-type)) | item-scoped commands |

> **Terminology.** We reserve **aggregate** for the consistency/stream boundary (the Workspace).
> Pages and Items are **entities**. If you think of them as "the Page aggregate" / "the Question
> aggregate," read that as *the entity's self-contained spec* (same commands/events/FSM/reducer)
> — it simply shares the workspace's stream rather than owning one. Promoting any of them to its
> own stream would reopen [ADR-002](#adr-002--workspace-as-the-aggregate-one-stream-2026-06-01)
> and forfeit atomic cross-page operations.

### 6.2 Workspace — the aggregate (stream root)

**Identity** `WorkspaceId` · **Stream** `{baseUrl}/{namespace}/workspace/{id}` · **Status FSM**
`active → archived` (archival blocks further mutations).

**State (the fold target):**

```ts
type WorkspaceId = string & { readonly __brand: "WorkspaceId" };
type PageId      = string & { readonly __brand: "PageId" };

interface IWorkspaceState {
  id: WorkspaceId;
  name: string;
  status: "active" | "archived";                 // workspace-lifecycle FSM
  pages: Map<PageId, IPageNode>;                   // every page by id
  children: Map<PageId | "@root", PageId[]>;      // ordered children → the tree
  links: { from: PageId; to: PageId; role: string }[];  // graph edges beyond the tree
  version: number;                                // per-workspace, == stream length
}

interface IPageNode {
  id: PageId;
  type: string;                  // "feature-brief"
  parentId: PageId | null;       // null = top-level (child of @root)
  title: string;                 // denormalized into the node (sibling-uniqueness + nav)
  status: string;                // page-type FSM status
  fields: unknown;               // typed per page type
  items: Record<string, IItemRecord[]>;  // e.g. { component: [...], question: [...], commit: [...] }
  createdAt: string; updatedAt: string;
}

interface IItemRecord { id: string; status?: string; /* + typed fields per item type */ }
```

**Structural commands** (workspace-scoped; guarded by invariants + "workspace active?" +
"target page not archived?"). **Every command also yields a `ConsistencyToken`** for the
committed head: the `Result` column below is the `value` carried inside `Committed<value>`, and
the `—` rows return `Committed<void>` (the token still names where the events landed, so an agent
can read the mutated graph back — [§8.6](#86-consistency-tokens-read-models--cqrs)):

| Command | Args | Events (one atomic append) | Result |
|---|---|---|---|
| `createPage` | `{ type, title, parentId }` | `PageCreated` (+ the page type's create event) | `PageId` |
| `reparent` | `{ pageId, newParentId, position? }` | `PageReparented`, `ChildrenReordered` | — |
| `reorder` | `{ parentId, orderedChildIds }` | `ChildrenReordered` | — |
| `setPageTitle` | `{ pageId, title }` | `PageTitleSet` | — |
| `archivePage` | `{ pageId }` | `PageArchived` | — |
| `link` / `unlink` | `{ from, to, role }` | `LinkAdded` / `LinkRemoved` | — |
| `moveItem` | `{ from, to, itemType, itemId }` | `<Item>Removed` + `<Item>Added` (e.g. `QuestionRemoved`+`QuestionAdded`) | — |
| `archiveWorkspace` *(handle: `archive()`)* | `{}` | `WorkspaceArchived` | — |

Every stream's first event is `WorkspaceCreated { name }`.

**Invariants enforced atomically (the payoff):**

- **Acyclic tree** — `reparent(p, newParent)` rejects if `newParent` is `p` or a descendant
  (`CycleError`).
- **Parent / page exists** (`ParentNotFoundError`, `PageNotFoundError`).
- **Unique title among siblings** (optional per workspace; `DuplicateTitleError`).
- **Link integrity** — both endpoints exist (`LinkTargetNotFoundError`).
- **Atomic cross-page edits** — `moveItem` is all-or-nothing (both events in one append, never
  half-moved).

### 6.3 Page — an entity (one spec per page type)

A page is an `IPageNode`; its content and status change only via the **page type's** own commands.
`definePageType(...)` is the full entity spec:

- **Identity** `PageId`, type-prefixed (e.g. `feature-brief:01J…`).
- **Status FSM** — the page lifecycle, with self-transitions for content edits that don't change
  status.
- **Commands** — page-scoped, FSM-gated; invoked `ws.mutate(pageId, command, args)`.
- **Events** — carry `pageId`; folded by the page type's `apply` into the node's `fields`/`items`.
- **Reducer** `apply(node, event) → node` and **Renderer** `render(node, ctx) → markdown`
  (deterministic).
- **Required children** (optional) — page types in `requiredChildren` are auto-created
  *atomically* with the page and pinned (can't be reparented out or archived alone); e.g.
  `feature-brief` mandates an implementation plan, checklist, and testing plan
  ([§13](#13-worked-example-an-llm-plans-and-ships-a-feature)).

**Registered page types (v1):**

| Page type | Status FSM | Items owned | Full spec |
|---|---|---|---|
| `feature-brief` *(top-level; mandates 3 child pages)* | `draft → planning → building → review → shipped` (+ `abandoned`) | `component`, `constraint`, `question`, `commit` | [§13](#13-worked-example-an-llm-plans-and-ships-a-feature) |
| `implementation-plan` | `draft → ready` | `step`, `question` | [§13](#13-worked-example-an-llm-plans-and-ships-a-feature) |
| `implementation-checklist` | `building → complete` | `task` | [§13](#13-worked-example-an-llm-plans-and-ships-a-feature) |
| `testing-plan` | `draft → ready` | `case` | [§13](#13-worked-example-an-llm-plans-and-ships-a-feature) |
| *(future)* `adr`, `spec`, `risk`, `experiment`, … | per type | per type | [§18](#18-future-work) |

### 6.4 Item — an entity inside a page (one spec per item type)

Items are typed sub-entities held in `IPageNode.items[itemType]`. `defineItemType(...)` specifies:

- **Identity** — an id unique within the owning page.
- **Status FSM** (optional) — e.g. Question `open → resolved`; the missing transition out of
  `resolved` is what makes "can't answer twice" *unrepresentable*.
- **Commands** — item-scoped, addressed by `{ pageId, itemId }`; a page command (e.g.
  `answerQuestion`) delegates to the item transition.
- **Events** — carry `pageId` + the item id.

**Registered item types (v1):**

| Item type | Status FSM | Owning page types | Commands |
|---|---|---|---|
| `question` | `open → resolved` | feature-brief, implementation-plan | `askQuestion`, `answerQuestion` |
| `component` | _(none)_ | feature-brief | `addComponent`, `removeComponent` |
| `constraint` | _(none)_ | feature-brief | `addConstraint`, `removeConstraint` |
| `commit` | _(none)_ | feature-brief | `recordCommit` |
| `step` | _(none; ordered)_ | implementation-plan | `addStep`, `removeStep`, `reorderSteps` |
| `task` | `todo ⇄ done` | implementation-checklist | `addTask`, `checkTask`, `uncheckTask`, `removeTask` |
| `case` | `planned → passed`/`failed` | testing-plan | `addCase`, `markCasePassed`, `markCaseFailed` |

### 6.5 Composition & identity

```
Workspace  (aggregate · 1 stream)                         WorkspaceId
├─ children: Map<parent → ordered PageId[]>   ← the tree
├─ links:    { from, to, role }[]             ← graph edges beyond the tree
└─ pages: Map<PageId, IPageNode>
   └─ Page  (entity · per page type)                      PageId   "feature-brief:01J…"
      ├─ fields   (typed per page type)
      └─ items: Record<itemType, IItemRecord[]>
         └─ Item (entity · per item type)                 itemId scoped to page  "q:01J…"
```

Containment is strict: an item belongs to exactly one page, a page to exactly one workspace. The
**tree** gives each page one parent; **links** add non-hierarchical edges. All of it folds from
the single workspace stream.

### 6.6 Sizing & the escape hatch

A workspace ≈ a *project*, not "all docs ever." Target scale: tens–hundreds of pages and a
**handful (~5) of gentle concurrent writers, mostly on different pages**. [Snapshots](#83-snapshots)
keep rehydration bounded as the stream grows. If a workspace ever becomes genuinely write-hot,
the escape hatch is to route its writes to one epoch-fenced owner, split it, or adopt the
StreamFS hybrid (per-page content streams) — none needed at the target scale.

---

## 7. The guarded-mutation model (FSM)

### 7.1 What has an FSM, and what has invariants

| Concern | Mechanism | Examples |
|---|---|---|
| Workspace lifecycle | workspace-status FSM | `active → archived` (then most mutations are blocked) |
| Page lifecycle | page-type status FSM | feature-brief: `draft → planning → building → review → shipped` |
| Item lifecycle | item-type FSM | Question: `open → resolved` (no transition answers it twice) |
| Tree / links | **invariants in handlers** | acyclic, parent-exists, unique sibling title, link-target-exists |

Status mutations are gated by the relevant **entity's** FSM (the guard reads the target page's
or item's current status out of `IWorkspaceState`). Structural mutations are gated by invariants
(+ "is the workspace active?" and "is the target page non-archived?").

### 7.2 Our own guard (a tiny transition table)

**No FSM dependency.** The guard is a pure function over a transition array (~20 lines);
`t()` keeps transitions declarative. We add an optional per-transition `meta` (e.g. a
description) that the LLM tool catalog can surface — something the upstream library doesn't
model. `typescript-fsm` ([§3.1](#31-typescript-fsm-design-reference--not-a-dependency)) is the
shape we copied, nothing we import.

```ts
// core/guard.ts — in-house; typescript-fsm-inspired, zero dependency.
export interface ITransition<S extends string, C extends string> {
  fromState: S; event: C; toState: S;
  meta?: { description?: string };   // optional; surfaced in describeMutations()
}
export const t = <S extends string, C extends string>(
  fromState: S, event: C, toState: S, meta?: ITransition<S, C>["meta"],
): ITransition<S, C> => ({ fromState, event, toState, meta });

export function makeGuard<S extends string, C extends string>(transitions: ITransition<S, C>[]) {
  return {
    /** Is `command` permitted from `status`? */
    can:  (status: S, command: C) => transitions.some((x) => x.fromState === status && x.event === command),
    /** Resulting status, or undefined if not permitted. */
    next: (status: S, command: C) => transitions.find((x) => x.fromState === status && x.event === command)?.toState,
    /** All commands legal from `status` — powers availableMutations(). */
    available: (status: S): C[] =>
      [...new Set(transitions.filter((x) => x.fromState === status).map((x) => x.event))],
    /** Mermaid lifecycle diagram for docs (~15 lines, owned). */
    toMermaid: (title?: string) => renderMermaid(transitions, title),
  };
}
```

### 7.3 Declaring a page type

A page type is one declarative object — `IPageTypeDef` (formal interface in
[§10.5](#105-authoring-api-defining-page-and-item-types)) — bundling its `statusTransitions` (the
FSM, built with `t()` from [§7.2](#72-our-own-guard-a-tiny-transition-table)); its `commands`
(each an `ICommandDef`: typed `args`/`result`, the `transition` it represents, and a pure
`produces`); an `apply` reducer; and a `render`. Authors never write permission `if`s — legality
is the transition table.

At command time the bus: (1) validates `args` against the command's `ISchema`; (2) reads the
target entity's current status from the workspace projection; (3) asks the FSM
`can(status, command)`; (4) runs `produces` to compute the events + result. The workspace reducer
then routes each event to the page named by `event.pageId` and calls that page type's `apply`;
structural events update `children` / `links` / `pages` directly.

---

## 8. Event sourcing & CQRS

### 8.1 The event envelope

```ts
export interface IEventEnvelope<T extends string = string, P = unknown> {
  eventId: string;        // unique id (injected id generator)
  streamId: WorkspaceId;  // the aggregate == the workspace
  pageId?: PageId;        // the page this event targets (absent for pure workspace events)
  version: number;        // 0-based per-WORKSPACE sequence; defines fold order
  type: T;                // "QuestionAnswered" | "PageReparented" | ...
  schemaVersion: number;  // schema version this payload was written under (§8.5)
  payload: P;
  meta: IEventMeta;
}

export interface IEventMeta {
  occurredAt: string;     // ISO-8601, from injected Clock (never Date.now() at render)
  actor?: string;         // "llm:planner", "user:ben"
  commandId?: string;     // idempotency: the command that produced this event
  causationId?: string; correlationId?: string;
}
```

`version` is **per-workspace** and equals stream length; it drives fold order and optimistic
concurrency. The Durable Streams opaque offset is used only for resuming reads/subscriptions.

### 8.2 Rehydration and the reducer

```ts
function foldWorkspace(events: IEventEnvelope[], from?: IWorkspaceState): IWorkspaceState {
  let s = from ?? emptyWorkspace(events[0]);     // events[0] = WorkspaceCreated when from is undefined
  for (const e of events) s = applyWorkspace(s, e);   // routes by e.type / e.pageId
  return s;
}
```

`applyWorkspace` handles structural events itself (mutating `pages`/`children`/`links`) and
delegates content events to the target page type's `apply`. The reducer is **total and pure**
(no I/O, clock, or randomness) and asserts `version` contiguity (fail fast on a gap). Before
`apply` sees an event, the reducer **upcasts** its payload to the current schema
([§8.5](#85-schema-evolution-upcasting)).

### 8.3 Snapshots

Because the workspace stream accumulates **all** page + structure activity, snapshots keep
rehydration bounded. A snapshot records `{ version, cursor, state }` — the fold result, the
workspace `version` it covers, and the coarse Durable Streams resume **cursor** (the stream's
next-offset at that point). On load: read the latest snapshot, `read(from = snapshot.cursor)`, and
fold the tail, **skipping any event with `version ≤ snapshot.version`** — the cursor is coarse, so
the fold stays idempotent.

**Cadence:** write a snapshot **every `snapshotEvery` events (default 100) or after
`snapshotIdleMs` of write-idle (default 5000 ms) — whichever comes first**
([§10.1](#101-entry-point--configuration)). The event count bounds rehydration under load; the
idle timer ensures a quiescent workspace still gets a fresh snapshot so reopening is fast.

**Storage:** a **sibling append-only stream** `…/workspace/{id}/snapshot`; readers take the latest
message. With infinite retention ([§9.1](#91-one-stream-per-workspace)) superseded snapshots
linger harmlessly (small; optional compaction later). A snapshot is a cache, never the source of
truth — and a schema bump ([§8.5](#85-schema-evolution-upcasting)) invalidates older snapshots, so
they're dropped and re-folded.

### 8.4 Live projection

The engine is **strict CQRS** (§8.6): a write-side **decide-aggregate** validates and appends, and a
**separate read model** serves reads. The decide-aggregate is the state the command bus folds to run the
FSM guard / invariants / OCC on the hot path (§5, §15); it is *not* what reads see.

`createWiki` ships a **default in-memory read model** — an `IReadModel` (§8.6) maintained per open
workspace, updated two ways: **write-through** after a local append, and a **live tail** (`subscribe`)
that folds in events from other writers. It tracks the highest `version` it has applied as its
**applied token** (§8.6), so `appliedToken()` / `waitFor()` are answered locally. The common path needs
no re-read, and a reader's view stays fresh — this is the same tail that powers G6.

The split is real even in-process: the decide-aggregate is advanced synchronously by the append, while
the read model catches up off the tail, so a read is **eventually consistent** unless gated by a token
(§8.6). An external read model (e.g. a SQL projection) plugs into the same `IReadModel` seam and is fed
by the same tail.

### 8.5 Schema evolution (upcasting)

The log is immutable, so as a schema changes we **upcast on read** rather than rewrite history.
Each page/item type carries a current `version`; every event is stamped with the `schemaVersion`
it was written under ([§8.1](#81-the-event-envelope)). A type supplies **upcasters** keyed by
from-version — each a pure `(payload) => payload` migrating one step. During fold, before `apply`,
the reducer composes upcasters from `event.schemaVersion` up to the type's current `version`, so
`apply`/`render` only ever see the current shape:

```ts
// in a page type def (§10.5):
version: 3,
upcasters: {
  1: (p) => ({ ...p, priority: "medium" }),                          // v1 → v2: new field w/ default
  2: ({ owner, ...p }) => ({ ...p, owners: owner ? [owner] : [] }),  // v2 → v3: reshaped
},
```

Upcasters are **pure and total**, do no I/O, and never mutate the stored event (they transform a
copy on the way into the fold). New events are written at the current `version`; structural
(workspace) events version independently of page types. A payload whose `schemaVersion` exceeds
the registered `version` (a forward/unknown version) is a hard error (`UnknownPageTypeError`) —
see below.

> **Unknown page/event types on rehydrate.** Because state is folded from history, opening a
> workspace whose stream contains a page `type` or event the configured `pageTypes` don't cover
> has no reducer/renderer to apply. Policy: **fail closed** — `openWorkspace` throws
> `UnknownPageTypeError` naming the missing type(s) rather than silently dropping events. Register
> the type (or a compatibility shim) to proceed. This keeps folds total and history honest.

### 8.6 Consistency tokens, read models & CQRS

The engine is **strict CQRS with eventual consistency** ([ADR-003](#adr-003--cqrs-with-consistency-tokens-2026-06-02)): the write side (commands → events) and the read side (queryable projections) are **separate**, and the read side trails the write side. Every write returns a **consistency token**; reads may pass a token to **wait** until the read side has caught up. This is what lets a caller convert "eventually consistent" into "consistent with my last write" on demand.

**The consistency token.** A `ConsistencyToken` is an **opaque, comparable string** encoding `{ workspaceId, version }` — `version` being the per-workspace 0-based sequence (== stream length; drives fold order & OCC, §8.1). Tokens are compared **within a single workspace only**; cross-workspace tokens are independent.

```ts
/** Opaque; encodes { workspaceId, version }. Compare WITHIN a workspace only. */
export type ConsistencyToken = string;
```

**Every write returns `Committed<T>`.** A successful command returns its value *and* the token marking where its events landed — the **committed head `version` after the append and any OCC rebase-retry** (§15), not a pre-rebase guess. An idempotent or zero-event write (a deduplicated `commandId`) returns the **current** head. Writes **do not** block on the read model.

```ts
export interface Committed<T> {
  readonly value: T;
  readonly token: ConsistencyToken;
}
```

This wraps **every** write, including the eight currently-`Promise<void>` structural commands — `reparent`, `reorder`, `setPageTitle`, `archivePage`, `link`, `unlink`, `moveItem`, and `archive()` (§10.3) — which become `Promise<Committed<void>>`: they mutate graph state a caller reads back, so they carry a token too. (A breaking API change — see [ADR-003](#adr-003--cqrs-with-consistency-tokens-2026-06-02).)

**The read-model interface.** Any projection — the default in-memory one (§8.4) or an external one — implements `IReadModel`:

```ts
export interface IReadModel {
  /** How far this read model has applied, for a workspace (the zero token if unknown). */
  appliedToken(workspace: WorkspaceId): Promise<ConsistencyToken>;
  /** Resolve once applied ≥ token; reject with ConsistencyTimeoutError after timeoutMs. */
  waitFor(token: ConsistencyToken, opts?: { timeoutMs?: number }): Promise<void>;
}
```

**Token-aware, async reads.** Because a read may have to wait for the read side to catch up, the handle's reads (`tree`/`page`/`toMarkdown`/`status`/`history`, §10.3) take an **optional** token and return a `Promise`:

```ts
read(query, { consistentWith?: ConsistencyToken; timeoutMs?: number }): Promise<…>
//   token present → waitFor(token) then serve  (read-your-writes / monotonic)
//   token absent  → serve current state         (eventually consistent; may be stale)
```

With a token present, the read calls `waitFor(token)` then serves — giving **read-your-writes** by threading the token from a prior `Committed<T>`. With no token it serves the current projection — fast, but possibly stale. A `waitFor` that exceeds `timeoutMs` rejects with **`ConsistencyTimeoutError`** (a `WikiError` subclass, §14); the default timeout is `IWikiConfig.readConsistencyTimeoutMs` (default 5000, §10.1).

**The write-side / read-side split.** The command bus folds a **write-side decide-aggregate** purely to validate the FSM, invariants, and OCC and to append (§5, §15). A **separate read model** — fed by the live tail, token-gated — serves reads (§8.4). The default in-memory read model makes the engine CQRS-correct standalone, with no database; external read models implement the same `IReadModel` against this seam.

**A public, pure fold is exported.** External read models apply each commit by folding it with the engine's own reducer (so they can never *semantically* diverge — same upcasting, same unknown-type policy), then serializing the resulting `IWorkspaceState`. The fold (`foldWorkspace`/`applyWorkspace`, internal today, §16.1) is therefore **exported** as a public, pure, read-only function for that purpose ([ADR-003](#adr-003--cqrs-with-consistency-tokens-2026-06-02)).

---

## 9. Persistence with Durable Streams

The wiki uses Durable Streams **directly**, through one thin `EventLog` module — no storage
abstraction ([ADR-001](#adr-001--use-durable-streams-directly-no-storage-port-2026-06-01)).
Storage *durability* (in-memory / file / ACID) is chosen on the DS **server** you point at, not
in the wiki ([§3.2](#32-durable-streams-the-persistence-substrate)).

### 9.1 One stream per workspace

| Wiki concept | Durable Streams |
|---|---|
| workspace (aggregate) | one stream URL: `{baseUrl}/{namespace}/workspace/{workspaceId}` |
| ensure exists | `DurableStream.create({ url, contentType: "application/json", ttlSeconds })` (idempotent) |
| append a command's events | `IdempotentProducer(handle, workspaceId, …)` → `append()` each → `flush()` (**one atomic POST of the array**) |
| one event | one JSON message |
| read from a position | `stream({ url, offset, live: false })` then `.json()` |
| live tail (G6) | `stream({ url, offset, live: true })` → `subscribeJson(batch => …)` |
| our `version` (0..N) | carried in payload; **not** the opaque DS offset |
| optimistic concurrency | `expectedVersion` → conditional append (`PreconditionFailedError`) |
| exactly-once / fencing | `Producer-Id` = `workspaceId`, `Producer-Seq` = `version`, `Producer-Epoch` fences a stale writer |
| retention | **infinite** — no TTL on workspace streams; full history is the source of truth (snapshots are an optimization, not a trim) |

```ts
// illustrative — the ONLY module that imports @durable-streams/client
import { DurableStream, IdempotentProducer, stream } from "@durable-streams/client";

export class EventLog {
  constructor(private cfg: { baseUrl: string; namespace: string; ttlSeconds?: number }) {}
  private urlFor(ws: WorkspaceId) { return `${this.cfg.baseUrl}/${this.cfg.namespace}/workspace/${encodeURIComponent(ws)}`; }

  /** Append a command's events as ONE atomic batch, asserting the head is at expectedVersion. */
  async append(ws: WorkspaceId, events: IEventEnvelope[], opts: { expectedVersion: number }) {
    const handle = await DurableStream.create({ url: this.urlFor(ws), contentType: "application/json", ttlSeconds: this.cfg.ttlSeconds });
    const producer = new IdempotentProducer(handle, ws, { autoClaim: true, onError: (e) => { throw e; } });
    for (const e of events) producer.append(e);    // e.version is its seq; precondition = expectedVersion
    await producer.flush();                         // throws PreconditionFailedError on a stale append
    return { headVersion: events.at(-1)!.version /*, lastOffset from flush */ };
  }

  /** Read from a coarse cursor; order & dedup are by `event.version`, never the offset. */
  async read(ws: WorkspaceId, fromCursor?: string): Promise<{ events: IEventEnvelope[]; nextCursor: string }> {
    const res = await stream<IEventEnvelope>({ url: this.urlFor(ws), offset: fromCursor, live: false });
    return { events: await res.json(), nextCursor: res.nextOffset };   // batch-level resume cursor
  }

  /** Live tail: hand the consumer each batch's events + the cursor to persist for resume. */
  async subscribe(ws: WorkspaceId, onBatch: (events: IEventEnvelope[], cursor: string) => unknown, opts?: { fromCursor?: string }) {
    const res = await stream<IEventEnvelope>({ url: this.urlFor(ws), offset: opts?.fromCursor, live: true });
    return res.subscribeJson(async (batch) => { await onBatch(batch.items, batch.offset); });
  }
}
```

> **Offsets.** We never rely on per-message offsets: per-event order and dedup come from our
> monotonic `version`; the Durable Streams offset is only a coarse resume **cursor** (the
> response's next-offset / each batch's offset). On resume we read from the saved cursor and skip
> any event with `version ≤` the last folded version. Snapshots ([§8.3](#83-snapshots)) persist
> that cursor with the state in a sibling `…/workspace/{id}/snapshot` stream, via the same `EventLog`.

### 9.2 Why no port / interface?

One backend (Durable Streams); its durability is already a server setting; the in-memory
`DurableStreamTestServer` is a faithful, fast test store (no hand-rolled fake to drift). Promote
`EventLog` to an interface only if a real second backend appears. See ADR-001.

### 9.3 The namespace catalog

A namespace owns one extra stream — the **catalog** at `…/{namespace}/_catalog` — recording
workspace lifecycle (`WorkspaceRegistered { id, name }`, `WorkspaceRenamed`, `WorkspaceArchived`).
`wiki.listWorkspaces()` folds it; `createWorkspace` / `archive` append to it. It is a **secondary
index, not a consistency boundary**: creating a workspace writes the workspace stream first, then
appends a catalog entry (a second stream → not atomic with the first), so the catalog is
eventually consistent and fully **rebuildable** by enumerating the `…/{namespace}/workspace/`
streams. The catalog is also where **namespace-level configuration** will live (defaults, access
policy, the registered page-type set) — *reserved, not yet designed*.

---

## 10. Public TypeScript API

This section is the package's **external contract**, expressed as documented `interface`s.
**Implementations are internal and never exported:** `createWiki` wires up the command bus, the
`EventLog` ([§9](#9-persistence-with-durable-streams)), reducers, and renderers behind these
interfaces. Consumers program against the interfaces only — if a symbol isn't listed in
[§10.7](#107-package-entry-points) it isn't public.

> Code layout reflects the split: the **interfaces** live in `src/api.ts` (no implementation);
> the classes that satisfy them live in `core/` and `stores/`; `index.ts` re-exports the public
> surface ([§16](#16-structure-folders-files-and-module-boundaries)). For a runnable walkthrough see
> [§13](#13-worked-example-an-llm-plans-and-ships-a-feature); this section is the reference.

### 10.1 Entry point & configuration

```ts
/** Create a wiki bound to a Durable Streams server and a fixed set of page types. */
export function createWiki(config: IWikiConfig): IWiki;

/** Immutable configuration for a {@link IWiki}. */
export interface IWikiConfig {
  /** Where workspaces are stored; one Durable Stream is created per workspace. */
  readonly stream: IStreamConfig;
  /** The page types this wiki understands. An unknown `type` is rejected at `createPage`. */
  readonly pageTypes: readonly IPageType[];
  /** Returns the current time as ISO-8601. Injected for determinism/testing. @default () => new Date().toISOString() */
  readonly clock?: () => string;
  /** Generates unique ids (workspace/page/item/event). Injected for determinism/testing. @default a ULID factory */
  readonly ids?: () => string;
  /** Default `actor` stamped on event metadata when a call doesn't override it. */
  readonly actor?: string;
  /** Snapshot after this many events per workspace, or 0 to disable count-based snapshots. @default 100 @see §8.3 */
  readonly snapshotEvery?: number;
  /** Time-based backup: snapshot after this many ms of write-idle. @default 5000 @see §8.3 */
  readonly snapshotIdleMs?: number;
  /** Default timeout (ms) for a token-gated read's `waitFor` before it throws
   *  {@link ConsistencyTimeoutError}; a per-read `timeoutMs` overrides it. @default 5000 @see §8.6 */
  readonly readConsistencyTimeoutMs?: number;
  /** Bound the in-memory projection cache of open workspaces, or `false` to disable caching. */
  readonly cache?: { readonly maxWorkspaces?: number } | false;
  /** Optional sink invoked for every appended event (logging/metrics). Must not throw. */
  readonly onEvent?: (event: IEventEnvelope) => void;
}

/** Connection to a Durable Streams server. Storage *durability* is a server setting (§3.2). */
export interface IStreamConfig {
  /** Base URL of the server, e.g. "http://127.0.0.1:4437". */
  readonly baseUrl: string;
  /** Namespace/tenant segment: streams live at `{baseUrl}/{namespace}/workspace/{id}`. */
  readonly namespace: string;
  /** Optional stream TTL (seconds). **Omit for infinite retention** (the default) — event sourcing
   *  needs full history; snapshots are an optimization, not a trimming mechanism (§9.1). */
  readonly ttlSeconds?: number;
}
```

### 10.2 The `IWiki` interface (what `createWiki` returns)

```ts
/**
 * Top-level handle. Holds no workspace state itself; it creates/opens {@link IWorkspaceHandle}s,
 * each of which is exactly one event-sourced aggregate (one Durable Stream).
 */
export interface IWiki {
  /**
   * Create a new, empty workspace and return a live handle. Appends `WorkspaceCreated`.
   * @param input.name human-readable name.
   * @param input.id   optional explicit id (else generated) — handy for deterministic tests.
   */
  createWorkspace(input: { name: string; id?: WorkspaceId }): Promise<IWorkspaceHandle>;

  /**
   * Open an existing workspace, rehydrating its state (latest snapshot + folded tail).
   * @throws {@link WorkspaceNotFoundError} if no stream exists for `id`.
   * @throws {@link UnknownPageTypeError} if the history contains an unregistered page/event type (§8.5).
   */
  openWorkspace(id: WorkspaceId): Promise<IWorkspaceHandle>;

  /** List workspaces in the configured namespace (folded from the namespace catalog, §9.3). */
  listWorkspaces(): Promise<readonly IWorkspaceSummary[]>;

  /** Release cached projections and live subscriptions held by this instance. */
  close(): Promise<void>;
}

/** Lightweight workspace listing entry. */
export interface IWorkspaceSummary {
  readonly id: WorkspaceId;
  readonly name: string;
  readonly status: "active" | "archived";
}
```

### 10.3 The `IWorkspaceHandle` interface (one workspace = the aggregate)

```ts
/**
 * A live handle to one workspace aggregate. Structural commands mutate the page graph; `mutate`
 * applies a page-scoped, FSM-gated command. Every command appends atomically to the single
 * workspace stream (§6, §15) and resolves to a {@link Committed} value carrying the workspace's
 * **committed head {@link ConsistencyToken}** — the position after the append *and* any OCC
 * rebase-retry (§8.6). Reads are served by the workspace's read model (default in-memory, §8.4),
 * eventually consistent: pass `consistentWith` a write's token to read-your-writes (the read
 * `waitFor`s the read model before serving), or omit it to serve current (possibly stale) state.
 */
export interface IWorkspaceHandle {
  /** The workspace id (== stream id). */
  readonly id: WorkspaceId;

  // ── structural commands (atomic; guarded by invariants + workspace/page status) ──

  /**
   * Create a page of `type` under `parentId` (`null` = top level). Returns the new page id and the
   * committed token (§8.6).
   * @throws {@link ParentNotFoundError} | {@link DuplicateTitleError} | {@link WorkspaceArchivedError}
   */
  createPage<K extends PageTypeName>(
    type: K,
    input: { title: string; parentId: PageId | null } & CreateArgs<K>,
  ): Promise<Committed<PageId>>;

  /**
   * Move `pageId` under `newParentId` (`null` = top level), optionally at `position`.
   * @throws {@link CycleError} if `newParentId` is `pageId` or one of its descendants.
   * @throws {@link PageNotFoundError} | {@link ParentNotFoundError}
   */
  reparent(pageId: PageId, newParentId: PageId | null, position?: number): Promise<Committed<void>>;

  /** Set the exact order of a parent's children. */
  reorder(parentId: PageId | null, orderedChildIds: readonly PageId[]): Promise<Committed<void>>;

  /** Rename a page's tree title. @throws {@link DuplicateTitleError} */
  setPageTitle(pageId: PageId, title: string): Promise<Committed<void>>;

  /** Archive a page (terminal; blocks further mutations of that page). */
  archivePage(pageId: PageId): Promise<Committed<void>>;

  /** Add a typed link between two pages. @throws {@link LinkTargetNotFoundError} */
  link(from: PageId, to: PageId, role: string): Promise<Committed<void>>;
  /** Remove a typed link. */
  unlink(from: PageId, to: PageId, role: string): Promise<Committed<void>>;

  /**
   * Atomically move an item between pages (e.g. a question A→B): the item type's
   * remove+add events are written in a single append. @throws {@link ItemNotFoundError}
   */
  moveItem(input: { from: PageId; to: PageId; itemType: string; itemId: string }): Promise<Committed<void>>;

  /** Archive the whole workspace (terminal). */
  archive(): Promise<Committed<void>>;

  // ── page-scoped content/status command ──

  /**
   * Apply a page-scoped command. `command` is constrained to the addressed page type's command
   * names; `args` and the inner result value are inferred from that command's definition. The
   * result is wrapped in {@link Committed} so the caller gets the committed token (§8.6).
   * @throws {@link ValidationError} if `args` fail the schema.
   * @throws {@link MutationNotAllowedError} if the FSM forbids `command` in the current status.
   * @throws {@link ConcurrencyError} if optimistic-concurrency retries are exhausted.
   */
  mutate<K extends PageTypeName, C extends CommandName<K>>(
    pageId: PageId,
    command: C,
    args: CommandArgs<K, C>,
  ): Promise<Committed<CommandResult<K, C>>>;

  // ── reads (token-gated; async — §8.6) ──
  // Pass `consistentWith` a write's token to read-your-writes (waits up to `timeoutMs`,
  // default IWikiConfig.readConsistencyTimeoutMs); omit it for current/eventually-consistent state.

  /** Current workspace status. */
  status(opts?: IReadOpts): Promise<"active" | "archived">;
  /** The page graph as an ordered tree. @throws {@link ConsistencyTimeoutError} if a waited token doesn't apply in time. */
  tree(opts?: IReadOpts): Promise<ITreeNode>;
  /** A view scoped to one page. @throws {@link PageNotFoundError} | {@link ConsistencyTimeoutError} */
  page(pageId: PageId, opts?: IReadOpts): Promise<IPageView>;
  /** Deterministic Markdown for one page, or the whole workspace tree if `pageId` is omitted.
   *  @throws {@link ConsistencyTimeoutError} if a waited token doesn't apply in time. */
  toMarkdown(pageId?: PageId, opts?: IReadOpts): Promise<string>;
  /** The full ordered event log for this workspace.
   *  @throws {@link ConsistencyTimeoutError} if a waited token doesn't apply in time. */
  history(opts?: IReadOpts): Promise<readonly IEventEnvelope[]>;

  // ── live updates (G6) ──

  /** Subscribe to every event appended to this workspace, in order. */
  subscribe(handler: (event: IEventEnvelope) => void): Promise<Unsubscribe>;
}

/** Optional read consistency for a token-gated read (§8.6). */
export interface IReadOpts {
  /** A token from a prior write: `waitFor` the read model to apply it before serving (read-your-writes). */
  readonly consistentWith?: ConsistencyToken;
  /** Override the default `waitFor` timeout (`IWikiConfig.readConsistencyTimeoutMs`, default 5000 ms). */
  readonly timeoutMs?: number;
}

/** An ordered node in the page tree. The root uses the sentinel id `"@root"`. */
export interface ITreeNode {
  readonly id: PageId | "@root";
  readonly title: string;
  readonly type?: PageTypeName;
  readonly children: readonly ITreeNode[];
}

export type Unsubscribe = () => void;
```

### 10.4 The `IPageView` interface (one page, scoped)

```ts
/**
 * A read view of a single page plus a `mutate` bound to it. Reads are token-gated and async
 * (§8.6): pass `consistentWith` a write's token to read-your-writes, or omit it for current state.
 * The view is captured at construction time ({@link IWorkspaceHandle.page}); its read methods serve
 * from the read model at the consistency they're given.
 */
export interface IPageView<K extends PageTypeName = PageTypeName> {
  readonly id: PageId;
  readonly type: K;
  /** Current parent (`null` = top level). @throws {@link ConsistencyTimeoutError} if a waited token doesn't apply in time. */
  parentId(opts?: IReadOpts): Promise<PageId | null>;
  /** Current tree title. @throws {@link ConsistencyTimeoutError} if a waited token doesn't apply in time. */
  title(opts?: IReadOpts): Promise<string>;
  /** This page's child pages, in tree order. @throws {@link ConsistencyTimeoutError} if a waited token doesn't apply in time. */
  children(opts?: IReadOpts): Promise<readonly IPageView[]>;
  /** Current FSM status. @throws {@link ConsistencyTimeoutError} if a waited token doesn't apply in time. */
  status(opts?: IReadOpts): Promise<StatusOf<K>>;
  /** Deep-readonly typed snapshot of this page's state (fields + items).
   *  @throws {@link ConsistencyTimeoutError} if a waited token doesn't apply in time. */
  state(opts?: IReadOpts): Promise<DeepReadonly<PageState<K>>>;
  /** Command names legal from the current status (derived from the FSM).
   *  @throws {@link ConsistencyTimeoutError} if a waited token doesn't apply in time. */
  availableMutations(opts?: IReadOpts): Promise<readonly CommandName<K>[]>;
  /** Currently-available commands as tool descriptors for LLM function-calling.
   *  @throws {@link ConsistencyTimeoutError} if a waited token doesn't apply in time. */
  describeMutations(opts?: IReadOpts): Promise<readonly IMutationDescriptor[]>;
  /** Deterministic Markdown for this page. @throws {@link ConsistencyTimeoutError} if a waited token doesn't apply in time. */
  toMarkdown(opts?: IReadOpts): Promise<string>;
  /** Sugar for {@link IWorkspaceHandle.mutate} bound to this page; resolves to a {@link Committed} result (§8.6). */
  mutate<C extends CommandName<K>>(command: C, args: CommandArgs<K, C>): Promise<Committed<CommandResult<K, C>>>;
}

/** One command described for tool/function-calling (`describeMutations`). */
export interface IMutationDescriptor {
  /** Command name. */
  readonly name: string;
  /** JSON Schema for the command's arguments (derived from its Zod schema). */
  readonly argsSchema: JsonSchema;
  /** JSON Schema for the result, if the command returns one. */
  readonly resultSchema?: JsonSchema;
  /** Whether the command is legal in the page's current status right now. */
  readonly available: boolean;
  /** Optional description (from the transition's `meta`). */
  readonly description?: string;
}
```

> **Type-level helpers** (`PageTypeName`, `CommandName<K>`, `CommandArgs<K, C>`,
> `CommandResult<K, C>`, `StatusOf<K>`, `PageState<K>`, `CreateArgs<K>`) are derived from the
> registered `pageTypes`. They make `createPage`/`mutate` reject unknown types/commands at
> compile time and infer argument and result types per command. `JsonSchema` is an alias for a
> JSON-Schema document; `DeepReadonly<T>` is the recursive-readonly mapped type.

### 10.5 Authoring API: defining page and item types

The interfaces a consumer implements to extend the wiki with new page/item types. The formal
shapes referenced by [§6.3](#63-page--an-entity-one-spec-per-page-type)/[§6.4](#64-item--an-entity-inside-a-page-one-spec-per-item-type)/[§7.3](#73-declaring-a-page-type):

```ts
/** Register a page type; the result goes in {@link IWikiConfig.pageTypes}. */
export function definePageType<State, Status extends string, Cmds extends CommandMap, Ev extends DomainEvent>(
  def: IPageTypeDef<State, Status, Cmds, Ev>,
): IPageType<State, Status, Cmds, Ev>;

/** Register an item type (a sub-entity that lives inside pages). */
export function defineItemType<Status extends string = never>(def: IItemTypeDef<Status>): IItemType<Status>;

/** Full specification of a page entity (§6.3). */
export interface IPageTypeDef<State, Status extends string, Cmds extends CommandMap, Ev extends DomainEvent> {
  /** Stable type tag, also the page-id prefix (e.g. "feature-brief"). */
  readonly type: string;
  /** Status assigned when a page of this type is created. */
  readonly initialStatus: Status;
  /** Current schema version for this type's events; new events are stamped with it (§8.5). */
  readonly version: number;
  /** Upcasters keyed by from-version, composed on fold to migrate old payloads up to `version` (§8.5). */
  readonly upcasters?: Readonly<Record<number, (payload: unknown) => unknown>>;
  /** The page lifecycle FSM, built with {@link t} (§7.2). Include self-transitions for content edits. */
  readonly statusTransitions: readonly ITransition<Status, keyof Cmds & string>[];
  /** Item types this page may contain, keyed by item-type tag. */
  readonly items?: Readonly<Record<string, IItemType>>;
  /** Page types auto-created (atomically) as children whenever a page of this type is created,
   *  and thereafter pinned — they can't be reparented out or archived independently.
   *  e.g. `feature-brief` → ["implementation-plan","implementation-checklist","testing-plan"]. */
  readonly requiredChildren?: readonly string[];
  /** Page-scoped commands, keyed by command name. */
  readonly commands: Cmds;
  /** Pure reducer: fold one event into this page's state. Must be total, no I/O. */
  readonly apply: (page: PageState<State>, event: Ev) => PageState<State>;
  /** Deterministic Markdown renderer for a page of this type (§11). */
  readonly render: (page: PageState<State>, ctx: IRenderCtx) => string;
}

/** One page-scoped command: typed args, optional typed result, an FSM transition, a pure decider. */
export interface ICommandDef<State, Args, Result, Ev extends DomainEvent> {
  /** Runtime + static schema for the arguments. */
  readonly args: ISchema<Args>;
  /** Optional schema for the result. */
  readonly result?: ISchema<Result>;
  /** The transition this command represents — page-level, or delegated to an item's FSM. */
  readonly transition:
    | { readonly level: "page"; readonly event: string }
    | { readonly level: "item"; readonly itemType: string; readonly idArg: keyof Args; readonly event: string };
  /** Pure decision: check invariants, return the events to append + the typed result. No I/O. */
  readonly produces: (page: State, args: Args, ctx: ICommandContext) => { events: Ev[]; result: Result };
}

/** Full specification of an item entity (§6.4). */
export interface IItemTypeDef<Status extends string = never> {
  /** Stable item-type tag (e.g. "question"). */
  readonly type: string;
  /** Optional lifecycle FSM (e.g. question `open → resolved`). */
  readonly initialStatus?: Status;
  readonly statusTransitions?: readonly ITransition<Status, string>[];
}

/** A declarative FSM transition (our in-house guard — §7.2). */
export interface ITransition<S extends string, C extends string> {
  readonly fromState: S;
  readonly event: C;
  readonly toState: S;
  /** Optional metadata surfaced in {@link IMutationDescriptor.description}. */
  readonly meta?: { readonly description?: string };
}
/** Build a {@link ITransition}. */
export function t<S extends string, C extends string>(fromState: S, event: C, toState: S, meta?: ITransition<S, C>["meta"]): ITransition<S, C>;

/** Adapter over a runtime validator (Zod by default): parse and export JSON Schema. */
export interface ISchema<T> {
  parse(input: unknown): T;          // throws ValidationError on failure
  toJsonSchema(): JsonSchema;
}

/** Context passed to a command's `produces`. */
export interface ICommandContext {
  /** Generate a fresh id (e.g. for a new item). */ readonly newId: () => string;
  /** The command's occurrence time (ISO-8601). */ readonly now: string;
  readonly actor?: string;
  readonly commandId?: string;
}

/** Read-only workspace context passed to a renderer, for deterministic breadcrumbs/backlinks. */
export interface IRenderCtx {
  readonly titleOf: (id: PageId) => string | undefined;
  readonly childrenOf: (id: PageId | "@root") => readonly PageId[];
  readonly linksOf: (id: PageId) => readonly { readonly to: PageId; readonly role: string }[];
}

/** Opaque registration objects returned by the `define*` helpers. */
export interface IPageType<State = any, Status extends string = string, Cmds extends CommandMap = CommandMap, Ev extends DomainEvent = DomainEvent> { readonly __def: IPageTypeDef<State, Status, Cmds, Ev>; }
export interface IItemType<Status extends string = string> { readonly __def: IItemTypeDef<Status>; }
export type CommandMap = Readonly<Record<string, ICommandDef<any, any, any, any>>>;
```

### 10.6 Exported data types and errors

- **Event/state types:** `IEventEnvelope`, `IEventMeta` ([§8.1](#81-the-event-envelope));
  `IWorkspaceState`, `IPageNode`, `IItemRecord` ([§6.2](#62-workspace--the-aggregate-stream-root));
  `ITreeNode`, `IMutationDescriptor`, `IWorkspaceSummary` (above). `DomainEvent` is the base event
  union (`{ type: string; pageId?: PageId; payload: unknown }`).
- **CQRS consistency types** ([§8.6](#86-consistency-tokens-read-models--cqrs)):
  `ConsistencyToken` (opaque, comparable `string` encoding `{ workspaceId, version }`; compared
  *within* a workspace only); `Committed<T>` = `{ readonly value: T; readonly token: ConsistencyToken }`,
  the return shape of **every** write; `IReadOpts` (the optional `{ consistentWith?, timeoutMs? }`
  reads take, above); and `IReadModel` (`appliedToken(workspace)` / `waitFor(token, opts?)`), the
  read-side seam an external read model implements.
- **Branded ids:** `WorkspaceId`, `PageId` (opaque `string` brands).
- **Errors:** every error class is exported and documented in [§14](#14-errors--validation) — all
  extend `WikiError`, so a consumer can catch the base or narrow on `code`/`instanceof`. This now
  includes `ConsistencyTimeoutError` (thrown when a token-gated read's `waitFor` exceeds its
  timeout — added in [§14](#14-errors--validation)).

### 10.7 Package entry points

| Import | Public exports |
|---|---|
| `wiki` | `createWiki`; interfaces `IWiki`, `IWorkspaceHandle`, `IPageView`, `IWikiConfig`, `IStreamConfig`; authoring `definePageType`, `defineItemType`, `t` and the `*Def` / `ISchema` / context interfaces; the data types; all error classes. |
| `wiki/pages/feature` | the worked-example page types — `FeatureBrief`, `ImplementationPlan`, `ImplementationChecklist`, `TestingPlan` (each `IPageType`) — and their exported state/command types. |
| `wiki/testing` *(dev only)* | helpers to start an in-memory `DurableStreamTestServer` and an `IWiki` bound to it. |

---

## 11. Deterministic Markdown rendering

A page's Markdown is a **pure function of its state**; equal state → byte-identical output. The
renderer registry maps `type → render(page, ctx)`, where `ctx` exposes read-only workspace info
(child list, link titles) so a page can render breadcrumbs/backlinks deterministically.

**Determinism rules (enforced by lint + tests):**

1. **No wall-clock or randomness at render time** — timestamps come from `meta.occurredAt`
   already in state.
2. **Stable ordering** — render collections by insertion order (tracked in state) or a stable
   key; sort explicitly, never rely on object-key enumeration. The tree renders in `children`
   order.
3. **Canonical formatting** — fixed heading levels, `\n` line endings, single trailing newline,
   no trailing whitespace, ISO-8601 dates.
4. **Total over state** — optional fields render explicit placeholders (e.g. `_No summary yet._`)
   so diffs stay local.
5. **No external lookups** — render from state only (titles/links are denormalized in the
   workspace), never by fetching.

A **default structured renderer** walks typed sections, item lists (with status badges), and an
"Open questions" / "Resolved questions" split; whole-workspace render emits the tree as nested
headings or a table of contents. The FSM's `toMermaid()` can emit lifecycle diagrams into dev
docs.

---

## 12. Designed for LLMs

- **Mutations ⇒ tools.** Each command's Zod schema exports to **JSON Schema**
  (`describeMutations()`) → drops straight into Anthropic/OpenAI tool definitions, for both
  page-scoped and structural commands.
- **Only legal actions are offered.** `availableMutations()` is derived from the FSM for the
  page's *current* status, so the model is handed only tools it can legally use now; the
  server-side guard still rejects illegal calls.
- **Structured, actionable errors.** `MutationNotAllowedError` reports current status + the legal
  set; structural errors (`CycleError`, `ParentNotFoundError`) say exactly what's wrong, so the
  model self-corrects in one step.
- **One consistent object to reason over.** A workspace loads as a single coherent
  state+history; the agent sees the whole graph atomically, and `subscribe` streams every change
  (G6) — the agent loop Durable Streams was built for.
- **Deterministic context & replayable history** — stable Markdown between turns; the event log
  is a literal transcript for "what changed," undo, and branching.
- **Idempotent commands** — optional `commandId` collapses retried tool calls to one effect.

---

## 13. Worked example: an LLM plans and ships a feature

The running example: an agent drives a feature from brief → plan → implementation → shipped, in
one workspace. It exercises a page type that **mandates child pages**, four item types,
references-as-links, and **cross-page invariants** that are only checkable because the brief and
its children share one aggregate (§6, ADR-002).

### 13.1 The page types

A workspace is a *project* holding many top-level **feature briefs**. A `feature-brief`
**requires three child pages**, created atomically with it:

| Page type | Role | Status FSM | Items it owns | Required children |
|---|---|---|---|---|
| `feature-brief` | brief: components, constraints, open questions, commits | `draft → planning → building → review → shipped` (+ `abandoned`) | `component`, `constraint`, `question`, `commit` | `implementation-plan`, `implementation-checklist`, `testing-plan` |
| `implementation-plan` | ordered plan of attack | `draft → ready` | `step`, `question` | — |
| `implementation-checklist` | tracked work items | `building → complete` | `task` | — |
| `testing-plan` | test cases + results | `draft → ready` | `case` | — |

`createPage("feature-brief", …)` emits, in **one atomic append**, the brief's `PageCreated` plus
a `PageCreated` for each mandated child — so a brief never exists without its
plan/checklist/testing-plan, and those children can't be reparented out or archived alone
(`InvariantViolationError`). **References** to other features/pages are typed **links**
(`ws.link(brief, other, "depends-on" | "relates-to" | "supersedes")`), rendered as the brief's
"References" section. The brief's own fields:

```ts
interface IFeatureBriefFields {
  summary?: string;
  components:  { id: string; name: string }[];                                  // affected components (web-app, cli, …)
  constraints: { id: string; text: string }[];                                  // major design constraints
  questions:   { id: string; text: string; status: "open" | "resolved"; answer?: string }[];
  commits:     { id: string; sha: string; message: string; url?: string }[];     // relevant commits
  // references are links on the workspace graph (not a field) — rendered via ctx.linksOf
}
```

### 13.2 The FSMs that matter

The brief lifecycle — the agent iterates planning ⇄ building:

```mermaid
stateDiagram-v2
  [*] --> draft
  draft --> draft: setSummary / addComponent / addConstraint / askQuestion / answerQuestion
  draft --> planning: beginPlanning
  planning --> planning: addConstraint / askQuestion / answerQuestion
  planning --> building: beginImplementation
  building --> building: addConstraint / askQuestion / answerQuestion / recordCommit
  building --> planning: reopenPlanning
  building --> review: submitForReview
  review --> building: requestChanges
  review --> shipped: ship
  draft --> abandoned: abandon
  planning --> abandoned: abandon
  building --> abandoned: abandon
  review --> abandoned: abandon
  shipped --> [*]
  abandoned --> [*]
```

The item FSMs — a question can't be answered twice; a checklist task toggles; a test case records
a run (`component`, `constraint`, and `commit` are plain items, no lifecycle):

```mermaid
stateDiagram-v2
  state question {
    [*] --> open
    open --> resolved: answerQuestion
  }
  state task {
    [*] --> todo
    todo --> done: checkTask
    done --> todo: uncheckTask
  }
  state "test case" as testcase {
    [*] --> planned
    planned --> passed: markCasePassed
    planned --> failed: markCaseFailed
    failed  --> passed: markCasePassed
  }
```

### 13.3 A session: plan, build, ship

Every write returns `Committed<T>` — its `value` plus the `token` (the committed head `version`
after the append and any OCC rebase-retry, §8.6); even the void structural commands carry a token,
since they change the graph the agent reads back. Reads are `async` and take an optional
`{ consistentWith?: token }` to convert eventual consistency into read-your-writes (§10.3, §10.4).
Unused tokens are simply ignored here; we keep the last one to read against in §13.5.

```ts
const ws = await wiki.createWorkspace({ name: "Acme platform" });

// One call → brief + its 3 mandated children, atomically (4 PageCreated events in one append).
// createPage returns Committed<PageId>: the new id + a token naming where the events landed.
const { value: brief, token: tCreated } = await ws.createPage("feature-brief", { title: "Bulk export", parentId: null });
const page = await ws.page(brief, { consistentWith: tCreated });
const [plan, checklist, testPlan] = (await page.children()).map((c) => c.id);

// ── fill the brief ── (mutate returns Committed<CommandResult>; destructure value when there is one)
await ws.mutate(brief, "setSummary", { text: "Let users export their workspace as CSV/JSON." });
await ws.mutate(brief, "addComponent", { name: "web-app" });
await ws.mutate(brief, "addComponent", { name: "cli" });
await ws.mutate(brief, "addConstraint", { text: "Export must stream; never buffer >50MB in memory." });
const { value: { questionId: q1 } } = await ws.mutate(brief, "askQuestion", { text: "Which formats in v1?" });
await ws.mutate(brief, "answerQuestion", { questionId: q1, answer: "CSV and JSON; Parquet later." });
await ws.link(brief, "feature-brief:01H…rbac" as PageId, "depends-on");   // Committed<void> — reference another feature in this workspace

// ── planning ──
await ws.mutate(brief, "beginPlanning", {});
await ws.mutate(plan, "addStep", { text: "Stream a ReadableStream from a new /export endpoint." });
await ws.mutate(plan, "addStep", { text: "Add `wiki export` CLI wrapping the endpoint." });
const { value: { caseId: c1 } } = await ws.mutate(testPlan, "addCase", { text: "10k-row export < 2s, memory flat." });

// a question that's really a planning detail → move it onto the plan (atomic cross-page move)
const { value: { questionId: q2 } } = await ws.mutate(brief, "askQuestion", { text: "Page size while streaming?" });
await ws.moveItem({ from: brief, to: plan, itemType: "question", itemId: q2 });   // Committed<void>

// ── implementation ── (beginImplementation is gated: plan ≥1 step AND testing-plan ≥1 case)
await ws.mutate(brief, "beginImplementation", {});
const { value: { taskId: t1 } } = await ws.mutate(checklist, "addTask", { text: "Streaming /export endpoint" });
const { value: { taskId: t2 } } = await ws.mutate(checklist, "addTask", { text: "`wiki export` CLI" });
const { value: { taskId: t3 } } = await ws.mutate(checklist, "addTask", { text: "Docs + changelog" });

await ws.mutate(brief, "recordCommit", { sha: "a1b2c3d", message: "feat(api): streaming export endpoint" });
await ws.mutate(checklist, "checkTask", { taskId: t1 });
await ws.mutate(brief, "recordCommit", { sha: "e4f5g6h", message: "feat(cli): wiki export" });
await ws.mutate(checklist, "checkTask", { taskId: t2 });
await ws.mutate(testPlan, "markCasePassed", { caseId: c1 });

// ── review → ship ── (ship is gated: checklist 100% done, all cases passed, no open questions)
await ws.mutate(brief, "submitForReview", {});
await ws.mutate(checklist, "checkTask", { taskId: t3 });   // finish docs after review feedback
const { token: tShipped } = await ws.mutate(brief, "ship", {});   // keep the head token to read against (§13.5)
```

### 13.4 Cross-page invariants the single aggregate buys us

Because the brief and its children fold from **one stream**, a brief command can read its
children's state and enforce gates **atomically** — no second fetch, no race:

- `beginImplementation` (planning→building) requires the `implementation-plan` to have ≥1 step
  **and** the `testing-plan` ≥1 case.
- `ship` (review→shipped) requires the `implementation-checklist` 100% done, every `testing-plan`
  case `passed`, and **zero open questions** on the brief.

A failing gate throws `InvariantViolationError` naming what's missing — an LLM reads it and acts.
These checks would be racy (or impossible to do atomically) if each page were its own stream.

### 13.5 Sample deterministic render + tree

Reads are `async` now; passing the ship token as `consistentWith` waits for the read model to
catch up so the render reflects every write above (read-your-writes, §10.3) before serving:

```ts
// token-gated read → guaranteed to see the just-shipped state (not an eventually-consistent stale view)
const view = await ws.page(brief, { consistentWith: tShipped });
const kids = await view.children();     // [implementation-plan, implementation-checklist, testing-plan]
const md   = await ws.toMarkdown(brief, { consistentWith: tShipped });
```

The brief, rendered mid-flight (status `building`; q1 resolved, q2 moved to the plan):

```markdown
# Feature: Bulk export

**Status:** building

## Summary
Let users export their workspace as CSV/JSON.

## Components affected
- web-app
- cli

## Design constraints
1. Export must stream; never buffer >50MB in memory.

## Open questions
_None._

## Resolved questions
- **Which formats in v1?** → CSV and JSON; Parquet later.

## References
- depends-on → Access control (RBAC)

## Child pages
- Implementation plan
- Implementation checklist
- Testing plan

## Commits
- `a1b2c3d` feat(api): streaming export endpoint
- `e4f5g6h` feat(cli): wiki export
```

```
@root
└─ Bulk export                 (feature-brief, building)
   ├─ Implementation plan      (implementation-plan, draft)
   ├─ Implementation checklist (implementation-checklist, building)
   └─ Testing plan             (testing-plan, draft)
```

### 13.6 Available mutations by feature-brief status (what the LLM is offered)

| Status | Offered (page-scoped) mutations on the brief |
|---|---|
| `draft` | setSummary, addComponent, removeComponent, addConstraint, removeConstraint, askQuestion, answerQuestion\*, beginPlanning, abandon |
| `planning` | addConstraint, removeConstraint, askQuestion, answerQuestion\*, beginImplementation†, abandon |
| `building` | addConstraint, askQuestion, answerQuestion\*, recordCommit, reopenPlanning, submitForReview, abandon |
| `review` | recordCommit, requestChanges, ship†, abandon |
| `shipped` / `abandoned` | _(none — terminal)_ |

\* effective only for an `open` question. † additionally gated by a cross-page invariant (§13.4).
Structural commands (createPage, reparent, reorder, link, moveItem, archivePage) and each child
page's own commands (`addStep`; `addTask`/`checkTask`; `addCase`/`markCasePassed`; …) are offered
per their own FSMs.

---

## 14. Errors & validation

```ts
class WikiError extends Error { code: string; }
class ValidationError         extends WikiError { issues: SchemaIssue[]; }
class MutationNotAllowedError extends WikiError { pageType: string; status: string; command: string; allowed: string[]; }
class WorkspaceNotFoundError  extends WikiError { id: string; }
class WorkspaceArchivedError  extends WikiError { id: string; }
class PageNotFoundError       extends WikiError { id: string; }
class ItemNotFoundError       extends WikiError { itemType: string; id: string; }
class ParentNotFoundError     extends WikiError { parentId: string; }
class CycleError              extends WikiError { pageId: string; newParentId: string; }   // reparent would cycle
class DuplicateTitleError     extends WikiError { parentId: string | null; title: string; }
class LinkTargetNotFoundError extends WikiError { target: string; }
class ConcurrencyError        extends WikiError { expected: number; actual: number; }      // rebase retries exhausted
class InvariantViolationError extends WikiError { detail: string; }
class UnknownPageTypeError    extends WikiError { types: string[]; }   // rehydrate hit an unregistered page/event type (§8.5)
class ConsistencyTimeoutError extends WikiError { token: ConsistencyToken; timeoutMs: number; } // a token-gated read's waitFor timed out (§8.6)
```

- **Validation** uses each command's runtime schema (**Zod**: `z.infer` for static types,
  `zod-to-json-schema` for the LLM tool export), behind a thin `ISchema<T>` adapter. LLM-supplied
  args are *always* validated.
- Errors carry enough structure for an agent to recover (status + allowed set; the cycle's two
  ids; the missing parent id).
- **`ConsistencyTimeoutError`** is thrown when a token-gated read's `waitFor` exceeds `timeoutMs`
  (the call's override or `IWikiConfig.readConsistencyTimeoutMs`, default 5000) — the read model
  hasn't applied the requested `ConsistencyToken` in time ([§8.6](#86-consistency-tokens-read-models--cqrs)).
  It carries the awaited `token` + `timeoutMs` so a caller can retry or fall back to an
  eventually-consistent read (omit the token).

---

## 15. Concurrency, idempotency & ordering

Target: a workspace has **~5 gentle concurrent writers, mostly on different pages**. That's low
contention, so plain optimistic concurrency suffices — **no single-writer actor/routing system.**

- **In-process:** the command bus **serializes commands per `workspaceId`** (a small async
  queue), so one process never races itself.
- **Cross-process:** every append carries `expectedVersion` (the head we folded from). Durable
  Streams rejects a stale append with `PreconditionFailedError`. On conflict we
  **rebase-and-retry**: `read` the (usually tiny) new tail, fold it forward, re-run the command's
  guard + `decide` against the fresh state, and re-append. Because writers are usually on
  *different* pages, the command is still valid and the retry succeeds immediately. Retries are
  bounded; exhaustion surfaces `ConcurrencyError`.
- **Concurrency never bypasses the FSM.** If two writers race the *same* page (both answer one
  question), the first wins; the loser's rebase re-checks the FSM, sees `resolved`, and correctly
  fails with `MutationNotAllowedError`. The rebase re-validates invariants too (a reparent that
  would now cycle is rejected on retry).
- **One tail, all updates (G6).** Readers `subscribe` to the single workspace stream and fold a
  local projection; reads never contend with writers.
- **Idempotency / fencing:** `Producer-Id = workspaceId`, `Producer-Seq = version` (exactly-once
  on retry); `Producer-Epoch` fences a stale writer if ownership ever moves. Commands carry an
  optional `commandId`; a duplicate already in the stream short-circuits.
- **Ordering:** fold order is the per-workspace `version` == stream order; the reducer asserts
  contiguity and fails fast on a gap.
- **Escape hatch (not needed now):** if a workspace becomes write-hot, route its writes to a
  single epoch-fenced owner (zero conflicts), split it, or adopt the StreamFS hybrid. See
  [ADR-002](#adr-002--workspace-as-the-aggregate-one-stream-2026-06-01).

---

## 16. Structure: folders, files, and module boundaries

A pnpm/npm workspaces monorepo. `wiki/` is this package (transport-free core); `wiki-cli/` is a
future sibling that *consumes* it, and `wiki-server/` is the Durable Streams **host** the engine
points at for storage — it imports neither `wiki` nor its types (`wiki-server/DESIGN.md`).

```
.
├─ package.json                 # workspaces root (pnpm-workspace.yaml / "workspaces" field)
├─ tsconfig.base.json           # shared compiler options; each package extends it
├─ wiki/                        # ← THIS package — the core engine; exposes only a TS interface
│   ├─ package.json             # name "wiki"; exports map → "." , "./pages/feature" , "./testing"
│   ├─ DESIGN.md                # ← this document
│   └─ src/
│       ├─ index.ts             # PUBLIC BARREL — re-exports the entire public surface (§10.7)
│       ├─ api.ts               # PUBLIC TYPES ONLY — every I* interface + data shape + id + helper; no runtime code
│       ├─ core/                # IMPLEMENTATIONS (internal; satisfy api.ts, never re-exported raw)
│       │   ├─ wiki.ts          #   createWiki + IWiki / IWorkspaceHandle / IPageView impls; wires the rest
│       │   ├─ command-bus.ts   #   validate → guard → decide → atomic append → fold; rebase-retry; per-ws serialize
│       │   ├─ workspace.ts     #   the aggregate root: PUBLIC pure fold — foldWorkspace + applyWorkspace (the event router; §8.6)
│       │   ├─ readmodel.ts     #   default in-memory IReadModel: appliedToken / waitFor + token-gated reads, fed by the live tail (§8.6)
│       │   ├─ structure.ts     #   tree + links ops & invariants (createPage/reparent/reorder/link/moveItem…)
│       │   ├─ registry.ts      #   page/item `type` → { fsm, commands, apply, render }: the per-type dispatch hub
│       │   ├─ guard.ts         #   in-house FSM: makeGuard, t, ITransition, renderMermaid (zero dependency)
│       │   ├─ snapshot.ts      #   write/read snapshots (sibling stream); load = snapshot + folded tail
│       │   ├─ define.ts        #   definePageType / defineItemType (build the registration objects)
│       │   ├─ types.ts         #   INTERNAL types only (command envelope, projection-cache entry, journal)
│       │   └─ errors.ts        #   exported error classes (WikiError + subclasses)
│       ├─ stores/
│       │   └─ event-log.ts     #   the ONLY module that imports @durable-streams/client
│       ├─ render/
│       │   ├─ markdown.ts      #   registry dispatch + default fallback renderer + whole-workspace tree render
│       │   └─ determinism.ts   #   canonicalization helpers (stable sort, fixed formatting)
│       ├─ schema/
│       │   └─ zod-adapter.ts   #   ISchema<T> over Zod + toJsonSchema()
│       ├─ pages/
│       │   └─ feature/         #   worked-example page types (entity types — pluggable, §13)
│       │       ├─ feature-brief.ts            # FeatureBrief = definePageType({ requiredChildren: […] })
│       │       ├─ implementation-plan.ts
│       │       ├─ implementation-checklist.ts
│       │       ├─ testing-plan.ts
│       │       └─ items.ts                    # shared item types: question, component, constraint, commit, step, task, case
│       └─ testing.ts           # dev-only: start an in-memory DurableStreamTestServer + a wired IWiki
├─ wiki-cli/                    # FUTURE — commander CLI over `wiki`, generated from describeMutations()
└─ wiki-server/                 # the durable Durable Streams HOST the engine points at (wiki-server/DESIGN.md)
```

### 16.1 What each file owns

| File | Owns | Key exports | May import |
|---|---|---|---|
| `api.ts` | the entire **public type surface** | all `I*` interfaces, data shapes, branded ids, type-level helpers | nothing (pure types) |
| `index.ts` | the **public barrel** | re-exports of `api`, `core/errors`, the public `foldWorkspace`/`applyWorkspace` (§8.6), bundled page types | api, core/errors, core/workspace, pages/* |
| `core/wiki.ts` | engine entry + handle impls | `createWiki` | command-bus, registry, event-log, snapshot, api |
| `core/command-bus.ts` | the command hot path (§5) | `CommandBus` *(internal)* | guard, registry, workspace, event-log |
| `core/workspace.ts` | fold/apply (the reducer) — a **public, pure** fold | `foldWorkspace`, `applyWorkspace` *(exported for external read models, §8.6)* | registry, structure, api |
| `core/readmodel.ts` | the default in-memory `IReadModel` | `InMemoryReadModel` *(internal)*; `IReadModel`/`ConsistencyToken` live in `api.ts` | workspace, event-log, api |
| `core/structure.ts` | tree/link ops + invariants | structural command handlers | api, errors |
| `core/registry.ts` | **per-type dispatch** | `Registry` resolving `type → def` | api |
| `core/guard.ts` | the in-house FSM | `makeGuard`, `t`, `ITransition`, `renderMermaid` | *(none)* |
| `core/snapshot.ts` | snapshot read/write | `loadSnapshot`, `writeSnapshot` | event-log, api |
| `core/define.ts` | the authoring API | `definePageType`, `defineItemType` | guard, api |
| `core/errors.ts` | typed errors | `WikiError` + subclasses | *(none)* |
| `stores/event-log.ts` | Durable Streams I/O | `EventLog` | **`@durable-streams/client`**, api |
| `render/markdown.ts` | render dispatch | `renderPage`, `renderWorkspace` | registry, determinism, api |
| `schema/zod-adapter.ts` | runtime validation | `zodSchema(...)` → `ISchema<T>` | zod, zod-to-json-schema |
| `pages/feature/*` | the example page/item types | `FeatureBrief`, … (each `IPageType`) | define, guard (`t`), schema, api |

### 16.2 Dependency direction (a DAG pointing at `api.ts`)

The boundaries that keep the architecture honest:

- **`api.ts` depends on nothing**, and everything depends on it — interfaces split from
  implementations (§10). Implementations live under `core/` and `stores/`.
- **`stores/event-log.ts` is the sole importer of `@durable-streams/client`** — upgrading or
  swapping the storage client touches exactly one file ([ADR-001](#adr-001--use-durable-streams-directly-no-storage-port-2026-06-01)).
- **Page types are plugins.** `pages/*` import only the *authoring API* (`define.ts`, `t` from
  `guard.ts`, `schema/`) and `api.ts` types — **never** `core/wiki.ts`, `command-bus.ts`, or
  `event-log.ts`. A page type is self-contained and could ship from its own package.
- **The core is type-agnostic.** `command-bus.ts`, `workspace.ts`, and `render/markdown.ts` reach
  page-type behaviour **only** through `registry.ts`; they never name a concrete page type. Adding
  a page type touches only its own folder plus the `pageTypes` array passed to `createWiki` ([§13](#13-worked-example-an-llm-plans-and-ships-a-feature)).
- **CQRS seam — write side ⟂ read model.** `workspace.ts` exports a **public, pure** fold
  (`foldWorkspace`/`applyWorkspace`) so an **external read model** can replay the same way the
  engine does (identical upcasting + unknown-type policy); the default `core/readmodel.ts`
  consumes that fold off the live tail and exposes `IReadModel` (`appliedToken`/`waitFor` +
  token-gated reads). The command bus drives only the **write-side** decide-aggregate; handle
  reads delegate to the read model — neither side imports the other ([§8.6](#86-consistency-tokens-read-models--cqrs)).
- **Pure modules import no I/O** (`guard.ts`, the reducers in `workspace.ts`, the renderers,
  `determinism.ts`) — clock and id generation arrive via `ICommandContext`, upholding §11 determinism.
- **No cycles;** `index.ts` is a leaf that nothing imports internally.

### 16.3 Conventions

- **Interfaces** are `I`-prefixed; type aliases, classes, and functions are not.
- **One page type per file** under `pages/<area>/`; file names kebab-case, matching the `type` tag.
- **Events** are PascalCase past-tense (`PageCreated`, `QuestionAnswered`); **commands** are
  camelCase imperative (`addConstraint`, `beginImplementation`).
- A page's **id prefix equals its `type`** (`feature-brief:01J…`) — the type is recoverable from any id.

### 16.4 Dependencies

`wiki/` runtime deps: **`zod`** (+ `zod-to-json-schema`) and **`@durable-streams/client`**
(fetch-based; runs in Node/browser/edge). The default in-memory `IReadModel` (`core/readmodel.ts`,
[§8.6](#86-consistency-tokens-read-models--cqrs)) adds **no** dependency — it folds the live
tail in process; durable/external read models (e.g. a SQL one) live in downstream packages against
the exported `IReadModel` seam. **No FSM dependency** — the guard is ~20 lines in
`core/guard.ts`; `typescript-fsm` is a *design reference only*. **`@durable-streams/server`** is a
**devDependency** (the in-memory `DurableStreamTestServer` used by `testing.ts` and the test suite).

---

## 17. Testing strategy

- **Pure-unit:** reducers, guards, renderers, and **structural invariants** are pure →
  table-driven tests. Key cases: `reparent` cycle rejection, parent-exists, duplicate sibling
  title, link-target integrity, `moveItem` atomicity (both events or neither).
- **FSM coverage:** for every status, `available()` matches the intended table; property test
  that no command is legal from a status it shouldn't be.
- **Workspace script tests:** a sequence of structural + content mutations produces an expected
  event log *and* expected tree + Markdown. The motivating scenario (create a `feature-brief` → its
  3 children appear atomically → plan/checklist/testing-plan filled → `beginImplementation` blocked
  until the plan has steps → `ship` blocked until the checklist is done, cases pass, and no
  questions are open; plus an atomic cross-page question move) is one script.
- **Concurrency / rebase:** simulate two writers; assert different-page commands both land via
  rebase, and same-page conflicts are correctly rejected by the FSM after rebase.
- **Snapshot round-trip:** fold-from-zero == fold-from-snapshot+tail (byte-identical state).
- **Real (in-memory) store:** one `DurableStreamTestServer` (in-memory) per suite; the bus and
  `EventLog` exercise the *actual* DS code path — no fake to drift from real offset/idempotency/
  precondition/ordering semantics. Fast (localhost) and faithful.
- **Determinism guards:** lint/test that render + reducer never import the clock or RNG.
- **LLM-shape tests:** `describeMutations()` emits valid JSON Schema; `availableMutations()` ⊆
  the full command set for the current status.

---

## 18. Future work

- **`wiki-cli/`** — `commander` CLI driven by `describeMutations()` (largely generated):
  `wiki ws create`, `wiki ws <id> page create`, `wiki ws <id> reparent`, `wiki ws <id> render`.
- **`wiki-server/`** — the durable Durable Streams **host** the engine connects to for shared,
  multi-process deployments; specified separately in [`wiki-server/DESIGN.md`](../wiki-server/DESIGN.md).
  (Replaces the former `wiki-api/` idea — the engine needs a stream *host*, not an API wrapper.)
- **Projections / read models** across workspaces — "all open questions," search, dashboards.
- **Branching / forking** a workspace (the event log makes "fork at version N" natural).
- **Soft delete / archival** flows; **access control** (actor-scoped command permissions above
  the FSM).
- **More page types** — Decision Record (ADR), Spec, Risk, Experiment, Meeting.
- **Cross-workspace page move** as an explicit export/import saga.

---

## 19. References

- Durable Streams — Concepts: <https://durablestreams.com/concepts>
- Durable Streams — JSON mode: <https://durablestreams.com/json-mode>
- Durable Streams — TypeScript client: <https://durablestreams.com/typescript-client>
- Durable Streams — Deployment / server (`DurableStreamTestServer`, storage modes): <https://durablestreams.com/deployment>
- Durable Streams — StreamFS (filesystem-in-streams; structure vs content streams): <https://durablestreams.com/stream-fs>
- Durable Streams — PROTOCOL.md (atomicity, preconditions): <https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md>
- Durable Streams 0.1.0 & State Protocol: <https://electric-sql.com/blog/2025/12/23/durable-streams-0.1.0>
- `@durable-streams/client` (npm): <https://www.npmjs.com/package/@durable-streams/client> · `@durable-streams/server`: <https://www.npmjs.com/package/@durable-streams/server>
- `typescript-fsm` (**design reference only — not a dependency**): <https://github.com/WebLegions/typescript-fsm>
- Zod: <https://zod.dev> · `zod-to-json-schema`: <https://github.com/StefanTerdell/zod-to-json-schema>
- Vernon, *Effective Aggregate Design* (aggregate boundaries): <https://www.dddcommunity.org/library/vernon_2011/>
- Fowler, *Event Sourcing*: <https://martinfowler.com/eaaDev/EventSourcing.html>
- Fowler, *CQRS* (command/query separation, read models): <https://martinfowler.com/bliki/CQRS.html>

---

## Appendix A: Decision records

### ADR-001 — Use Durable Streams directly; no storage port (2026-06-01)

**Context.** The first draft wrapped Durable Streams in an `EventStore` port with
`InMemory`/`DurableStreams`/`File` adapters ("test in-memory, swap later").

**Findings.** Durable Streams *is* the storage layer; durability is a **server** setting
(in-memory / file / ACID via `DurableStreamTestServer({ dataDir })` or the Rust server's
`DS_STORAGE__MODE`; production via Caddy / Electric Cloud). `@durable-streams/server` is built
for dev/test/CI/embedding. The client is fetch-based and portable; only the server needs Node.

**Decision.** Drop the port and custom adapters. Use Durable Streams directly via one thin
`EventLog` (events↔messages, version↔offset, OCC). Tests use an in-memory `DurableStreamTestServer`.

**Why this isn't the abstraction we rejected.** `EventLog` is an anti-corruption boundary around
one young (0.2.x) dependency and a real impedance mismatch — not a swappable multi-backend layer.
No interface until a second backend actually exists.

### ADR-002 — Workspace as the aggregate (one stream) (2026-06-01)

**Context.** First draft used **one stream per page**. Reviewer: that's too granular — we want to
reparent a page within a "workspace" (a graph of pages), and with multiple streams that isn't
atomic. Question raised: *can Durable Streams aggregate streams?*

**Findings.** **No cross-stream transactions** — atomicity is per-stream (servers commit producer
state + append atomically; a writer can append-and-close atomically). A **single POST of a JSON
array is an atomic multi-event append.** Conditional append is native (`PreconditionFailedError`).
The StreamFS precedent uses a *hybrid* (structure stream + per-file content streams), which makes
*structural* ops atomic but **not cross-page content** ops.

**Requirements gathered.** Atomic operations needed: structural (reparent/reorder/link) **and**
cross-page **content** moves (e.g. move an open question onto a page's implementation plan). Scale: *gentle* multi-writer (~5
concurrent writers, mostly different pages); a key desired benefit is **one stream everyone tails
for all updates**.

**Decision.** The **workspace is the aggregate = one Durable Stream**; pages are **entities**
within it (tree + typed links). A command's events are written as one atomic batch. The hybrid
was rejected because it can't make cross-page *content* moves atomic and would force readers to
tail many streams.

**Tradeoff (explicit).** A coarser aggregate trades intra-workspace write *parallelism* for
cross-page *atomicity* and single-tail reads. At the target scale this is a clear win;
concurrency is handled by in-process per-workspace serialization + optimistic concurrency with
rebase-and-retry — **no actor/routing system**.

**Consequences.** Snapshots recommended as the stream grows ([§8.3](#83-snapshots)); `version` is
per-workspace; cross-*workspace* moves are a non-atomic saga (a non-goal). Escape hatch if a
workspace gets write-hot: single epoch-fenced owner, split the workspace, or adopt the StreamFS
hybrid.

### ADR-003 — CQRS with consistency tokens (2026-06-02)

**Context.** A stateless consumer (open → act → close) pays a full rehydrate per call ([§8.3](#83-snapshots)) — a non-starter once a long-lived host (`wiki-mcp`, the embedding read-model + MCP server) wants to serve reads from a durable, queryable projection (SQL) rather than re-fold history. That host must keep its read store **separate** from the write path, yet an agent must still be able to **read its own writes**. Today the engine keeps a *single* in-memory projection ([§8.4](#84-live-projection)) and the handle's reads (`tree`/`page`/`toMarkdown` — [§10.3](#103-the-iworkspacehandle-interface-one-workspace--the-aggregate)) are **synchronous and token-free**, conflating the write-side fold with the read view. The contract is specified in [`wiki-mcp/DESIGN.md`](../wiki-mcp/DESIGN.md) §3; per the owner's directive it must live in the **core engine**, not just the host.

**Findings.** The engine already owns the right quantity to name a position in history: the per-workspace `version` (0-based, monotonic, `== stream length`, drives fold order **and** OCC — [§8.1](#81-the-event-envelope)). So a consistency token is just `{ workspaceId, version }`, surfaced as an opaque, comparable string — compared **within** a workspace only (cross-workspace tokens are independent). Synchronously writing both stores would couple the write path and span two non-atomic stores; waiting on a token after the append converts "eventual" into "after my write" without that coupling. The reducer that validates a command is already a fold; reusing a *public* fold lets an external read model never semantically diverge from the write model.

**Decision.** Adopt **strict CQRS with eventual consistency** as a **core engine property**:

- **Split the single projection ([§8.4](#84-live-projection)) in two.** A write-side **decide-aggregate** — the fold the command bus maintains to validate the FSM / invariants / OCC — and a **separate read model** (a default **in-memory `IReadModel`**, fed by the live tail and token-gated). The engine is CQRS-correct standalone; external read models (e.g. `wiki-mcp`'s SQL projection) implement the same `IReadModel`.
- **Every write returns `Committed<T>`** — `{ readonly value: T; readonly token: ConsistencyToken }`. The token is the **committed head `version` after the append *and* any OCC rebase-retry** ([§15](#15-concurrency-idempotency--ordering)), so it names where the events *actually* landed; an idempotent / zero-event write returns the **current** head. This includes the **eight currently-`void` structural commands** (`reparent`, `reorder`, `setPageTitle`, `archivePage`, `link`, `unlink`, `moveItem`, `archive()`) ([§10.3](#103-the-iworkspacehandle-interface-one-workspace--the-aggregate)) — they mutate a graph the agent reads back, so they carry a token too (→ `Committed<void>`). Writes **do not** block on the read model; they return as soon as the append commits.
- **Reads optionally take a token and `waitFor`.** Read methods gain `{ consistentWith?: ConsistencyToken; timeoutMs?: number }` and become **async** (return a `Promise`): a token present → `waitFor(token)` then serve (read-your-writes / monotonic); absent → serve current state (eventually consistent, possibly stale). The `IReadModel` interface is:

```ts
interface IReadModel {
  /** How far this read model has applied, for a workspace. */
  appliedToken(workspace: WorkspaceId): Promise<ConsistencyToken>;
  /** Resolve once applied ≥ token; reject after timeoutMs (default from config). */
  waitFor(token: ConsistencyToken, opts?: { timeoutMs?: number }): Promise<void>;
}
```

- **Export a public, pure `fold`.** `foldWorkspace` / `applyWorkspace` are internal today ([§16.1](#161-what-each-file-owns)); a read-only fold is exported so external read models reuse exact write-model semantics (upcasting, unknown-type policy, item/FSM effects) and only own the state→storage mapping.
- **A new `ConsistencyTimeoutError`** (a `WikiError` subclass, [§14](#14-errors--validation)) when `waitFor` exceeds `timeoutMs`, so a caller can retry or read stale-with-a-flag. `IWikiConfig` gains a default read-consistency timeout (`readConsistencyTimeoutMs`, default 5000).

**Consequences (a real, breaking API change — not small).** Both write *and* read surfaces change. **Writes:** every return becomes `Committed<T>` (including the eight `Promise<void>` structural commands and `archive()`), so every caller unwraps `.value`/`.token`. **Reads:** the handle's synchronous, token-free `tree`/`page`/`toMarkdown` become **token-aware and `async`**, served from the new read model rather than the write-side fold. §8 (event sourcing) and §10 (API) both change; the in-memory `IReadModel` keeps the engine CQRS-correct with no database. The payoff: fast writes, eventually-consistent reads, and a token to demand read-your-writes on demand — and a public fold that lets `wiki-mcp`'s SQL read model stay semantically identical to the engine. (See [`wiki-mcp/DESIGN.md`](../wiki-mcp/DESIGN.md) §3 / ADR-M1.)
