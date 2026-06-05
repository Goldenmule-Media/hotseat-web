# wiki-mcp — Design Document

> Status: **Draft / living document** · Last updated: 2026-06-02 · Owner: @benjamin
>
> A **long-lived CQRS read model + MCP server** for the wiki engine. `wiki-mcp/` embeds the `wiki`
> engine ([wiki/DESIGN.md](../wiki/DESIGN.md)), keeps it **hydrated** (no per-call refold), and
> maintains a **durable read model in SQL** (via [Kysely](https://kysely.dev) — [PGlite](https://pglite.dev)
> locally, Postgres in production). Write and read models are **separate**, kept **eventually
> consistent**; every write returns a **consistency token** and reads may **wait** on it. It exposes
> the engine to agents as an **MCP server** that manages those tokens so an agent always reads its own
> writes. `wiki-server` hosts it — one process hosts streams and `wiki-mcp`.

---

## Table of contents

1. [Motivation & goals](#1-motivation--goals)
2. [Non-goals](#2-non-goals)
3. [The core CQRS contract (engine-level)](#3-the-core-cqrs-contract-engine-level)
4. [Architecture](#4-architecture)
5. [The SQL read model (Kysely · PGlite/pg)](#5-the-sql-read-model-kysely--pglitepg)
6. [Derived projections (outline · symbols · cross-references)](#6-derived-projections-outline--symbols--cross-references)
7. [The LanguageRegistry (runtime analyzer plugins)](#7-the-languageregistry-runtime-analyzer-plugins)
8. [The MCP server & token management](#8-the-mcp-server--token-management)
9. [Staying hydrated (the runtime)](#9-staying-hydrated-the-runtime)
10. [wiki-server integration](#10-wiki-server-integration)
11. [Failure & operational concerns](#11-failure--operational-concerns)
12. [Package structure](#12-package-structure)
13. [Testing strategy](#13-testing-strategy)
14. [Future work](#14-future-work)
15. [References](#15-references)
- [Appendix A: Decision records](#appendix-a-decision-records)

---

## 1. Motivation & goals

A stateless client (open → act → exit) pays a full **rehydrate per call** — a non-starter at any real
scale ([wiki/DESIGN.md §8.3](../wiki/DESIGN.md)). The fix is a **long-lived process** that stays
hydrated and serves reads from a **durable, queryable read model** instead of re-folding history.

That process is `wiki-mcp`. It is built on a principle the engine must adopt in its **core**
([§3](#3-the-core-cqrs-contract-engine-level)): **strict CQRS**. The write model (commands → events)
and the read model (queryable projections) are **separate** and **eventually consistent**. To make
that usable, every write returns a **consistency token**, and a read may pass a token to **wait**
until the read model has caught up. `wiki-mcp` then exposes the engine to LLM agents over **MCP**,
and **manages the tokens** so MCP reads always reflect the caller's own prior MCP writes.

### Goals

- **G1 — Stay hydrated.** A long-lived process: hot write-side handles (live tail, no per-call refold)
  and an always-current read model. Reads never re-fold history ([§9](#9-staying-hydrated-the-runtime)).
- **G2 — Strict CQRS with tokens, in the core.** Write/read separation + eventual consistency are an
  **engine** contract: writes return a token, reads optionally wait on it ([§3](#3-the-core-cqrs-contract-engine-level)).
- **G3 — A durable SQL read model.** Projections in Postgres via **Kysely** — **PGlite** locally,
  **pg** in production (same SQL, dev/prod parity). Survives restart; resumes without re-folding from
  zero ([§5](#5-the-sql-read-model-kysely--pglitepg)).
- **G4 — An MCP surface.** The engine's command catalog → MCP **tools** (it is LLM-first by design,
  [wiki/DESIGN.md §12](../wiki/DESIGN.md)); workspaces/pages → MCP **resources** ([§8](#8-the-mcp-server--token-management)).
- **G5 — Automatic read-your-writes.** The MCP server tracks each session's tokens and threads them
  into reads, so an agent's reads always reflect its own writes — without the agent managing tokens.
- **G6 — Clean layering.** Engine contract (core) ⟂ read model (SQL) ⟂ MCP surface — each replaceable.

---

## 2. Non-goals

- **No new domain model or rules.** The engine owns mutations, the FSM, invariants, rendering. The
  read model is *derived*; it never validates a command.
- **Not synchronous read/write.** Read-after-write is achieved by **waiting on a token**, not by
  writing both stores in one transaction ([§3.3](#33-reads-wait-on-a-token), [ADR-M1](../docs/wiki/decision-records/cqrs-with-consistency-tokens-in-the-engine-core.md)).
- **Not a general SQL/query API.** The read model is internal; access is the defined MCP tools/resources
  and a small typed query layer — not arbitrary SQL to clients.
- **Not multi-tenant beyond namespaces.** One configured namespace per server instance (v1).
- **Does not replace the CLI's purpose** — `wiki-cli/` is *set aside, not deleted*; if revived, it
  becomes a thin client of this server rather than a stateless re-folder.

---

## 3. The core CQRS contract (engine-level)

> **Required, coordinated `wiki` engine changes.** Per the owner's directive, CQRS-with-tokens lives in
> the **core engine**, not just here — so `wiki-mcp` builds on the contract below, and
> **`wiki/DESIGN.md` must adopt it** (changes to its §8 event-sourcing and §10 API). This section is
> the contract; the engine ships a default in-memory read model so it is CQRS-correct standalone, and
> external read models (this package's SQL one) implement the same interface.

### 3.1 The consistency token

A **token** marks a position in a workspace's history. The engine already has the right quantity: the
per-workspace `version` (0-based, monotonic, `== stream length`, drives fold order & OCC —
[wiki/DESIGN.md §8.1](../wiki/DESIGN.md)). A token is therefore `{ workspace, version }`, surfaced as
an **opaque, comparable string**:

```ts
type ConsistencyToken = string;            // opaque; encodes { workspaceId, version }
// compare WITHIN a workspace only; cross-workspace tokens are independent.
```

### 3.2 Writes return a token

**Every** successful write returns a token — the workspace's **committed head `version` after the append
*and any OCC rebase-retry*** ([wiki/DESIGN.md §15](../wiki/DESIGN.md)), so it names where the events
*actually* landed, not a pre-rebase guess. An idempotent or no-op write (a deduplicated `commandId`, zero
events) returns the **current** head. This includes the eight `Promise<void>` structural commands
(`reparent`, `reorder`, `setPageTitle`, `archivePage`, `link`, `unlink`, `moveItem`, `archive` —
[wiki/DESIGN.md §10.3](../wiki/DESIGN.md)): they mutate the graph an agent reads back, so they carry a
token too.

```ts
interface Committed<T> { readonly value: T; readonly token: ConsistencyToken; }
// createPage(...) -> Promise<Committed<PageId>>;  mutate(...) -> Promise<Committed<CommandResult>>
// reparent(...)   -> Promise<Committed<void>>;    link(...)   -> Promise<Committed<void>>;  … (ALL writes)
```

Writes **do not wait** on the read model — they return as soon as the append commits. The token is the
caller's handle to *later* demand read-side consistency. Wrapping every write — including the void
structural ones — in `Committed<T>` is a breaking engine change ([ADR-M1](../docs/wiki/decision-records/cqrs-with-consistency-tokens-in-the-engine-core.md)).

### 3.3 Reads wait on a token

The engine defines a **read-model consistency interface** that any projection implements:

```ts
interface IReadModel {
  /** How far this read model has applied, for a workspace. */
  appliedToken(workspace: WorkspaceId): Promise<ConsistencyToken>;
  /** Resolve once applied ≥ token; reject after timeoutMs (default from config). */
  waitFor(token: ConsistencyToken, opts?: { timeoutMs?: number }): Promise<void>;
}
```

Reads take an **optional** token and wait before serving:

```ts
read(query, { consistentWith?: ConsistencyToken; timeoutMs?: number })
//   token present → waitFor(token) then query  (read-your-writes / monotonic)
//   token absent  → query current state        (eventually consistent; may be stale)
```

This is the whole CQRS bargain: **fast writes, eventually-consistent reads, and a token to convert
"eventual" into "after my write" on demand.** A `waitFor` that times out surfaces a typed error so the
caller can retry or read stale-with-a-flag ([§11](#11-failure--operational-concerns)).

**Undiscovered workspaces & halts.** `waitFor(token)` must not depend on the read model having already
*discovered* the token's workspace — the namespace catalog is only eventually consistent
([wiki/DESIGN.md §9.3](../wiki/DESIGN.md)), so a just-created workspace's first token can arrive before its
tailer exists. `waitFor` therefore **lazily ensures a tail** for the referenced workspace (opening one
directly) rather than waiting on catalog discovery, and `appliedToken` of an unknown workspace is the zero
token. If a workspace's projection has **halted** ([§11](#11-failure--operational-concerns)), `waitFor`
**rejects with a non-retryable error** instead of blocking to the timeout.

### 3.4 The default read model (engine-internal)

So the engine is CQRS-correct without a database, it ships a **default in-memory `IReadModel`** — but
*how* it is wired (fed off the live tail; the write-side decide-aggregate split from the read model; its
handle reads becoming token-aware) is **engine-internal and belongs to [wiki/DESIGN.md §8](../wiki/DESIGN.md)**,
not here. This package depends only on the **token shape** (§3.1), the **`Committed<T>` write return**
(§3.2), and the **`IReadModel` interface** (§3.3), and supplies an **external SQL `IReadModel`** against
that same seam ([§5](#5-the-sql-read-model-kysely--pglitepg)).

---

## 4. Architecture

```
   LLM agents ───────────────── MCP (tools · resources) ─────────────────┐
                                                                          │
   ┌──────────────────────────────── wiki-mcp ────────────────────────────▼─────────┐
   │                                                                                  │
   │  MCP server  ── manages per-session tokens (§6) ──────────────┐                  │
   │      │ write tool                         │ read tool         │                  │
   │      ▼                                    ▼ (consistentWith token)                │
   │  embedded `wiki` engine            SQL READ MODEL (IReadModel, §5)                │
   │  (WRITE side: hot handles,          ├─ Kysely → PGlite (local) | pg (prod)        │
   │   validate → append, returns ──┐    ├─ appliedToken / waitFor                     │
   │   a token §3.2)                │    ├─ section tree + typed fields + blocks (jsonb)│
   │      │ append                  │    └─ queries: page, tree, render, search,       │
   │      ▼                         │        "open questions" across workspaces        │
   │      │                         │   DERIVED PROJECTIONS (§6, same tailer):         │
   │      │                         │    ├─ outline (section tree)                     │
   │      │                         │    ├─ symbol index (code fields + code blocks)   │
   │      │                         │    └─ cross-reference index (ref fields + spans) │
   │      │                         │   LanguageRegistry (§7): per-language analyzers  │
   │      ▼                         │                    ▲                             │
   │  ════ workspace streams ═══════╪════════════════════╪═══ projection tailer ═══════│
   │       (Durable Streams)        └── token (version) ──┘   (live tail → apply → SQL) │
   └──────────────────────────────────────────────────────────────────────────────────┘
        ▲ append/read over @durable-streams/client         (wiki-server hosts both, §10)
   ┌────┴───────────────────────┐
   │ wiki-server (stream host)   │
   └─────────────────────────────┘
```

The token bridges the two planes: a write appends at `version N` and returns the token; the **projection
tailer** later reads `version N` off the stream and applies it to SQL, advancing `appliedToken` to `N`;
a `waitFor(N)` resolves exactly then.

**Dependency direction:** `wiki-mcp` → `wiki` (engine, library), **Kysely**, **PGlite**/**pg**, and an
**MCP SDK** — all *new* dependencies ([§12](#12-package-structure)). `wiki-server` → `wiki-mcp` (hosts it,
[§10](#10-wiki-server-integration)).

---

## 5. The SQL read model (Kysely · PGlite/pg)

A **projection service** owns the SQL read model and implements `IReadModel` ([§3.3](#33-reads-wait-on-a-token)).

### 5.1 Projection mechanism

- **Discover & tail.** Tail the namespace **catalog** ([wiki/DESIGN.md §9.3](../wiki/DESIGN.md)) to learn
  workspaces; for each, hold a live tail of its stream ([wiki/DESIGN.md §8.4](../wiki/DESIGN.md)).
- **Apply = fold then serialize.** For each commit (an ordered event batch), fold it with the engine's
  **reducer** to the resulting `IWorkspaceState`, then **serialize that state into SQL** ([ADR-M3](../docs/wiki/decision-records/projection-engine-fold-serialize-to-sql.md)).
  In the section model a commit is an array of **section operations** ([structured-content §9.4](../docs/structured-content.md))
  — `setField` / `addSection` / `addBlock` / `setBlock` / `addElement` / `applyTextEdits` / `setMeta` /
  `transition` — folded by the engine's **one built-in section reducer**; there are no per-type events or
  author reducers to special-case. Reusing the fold means the read model can never *semantically* diverge
  from the write model (same upcasting, same unknown-type policy, same `reduceMeta` hook —
  [structured-content §9.5](../docs/structured-content.md)) — the only mapping we own is state→rows. **This
  requires the engine to expose a *public, pure* fold** (`foldWorkspace`/`applyWorkspace` are internal today —
  [wiki/DESIGN.md §16.1](../wiki/DESIGN.md)); exporting a read-only fold for external read models is part of
  the coordinated engine changes.
- **Atomic per commit.** Each commit's row writes **and** the new `applied version` for that workspace are
  written in **one SQL transaction**, so `appliedToken` never reports ahead of the data. The derived
  projections (§6) — outline, symbol index, cross-reference index — are recomputed from the **same folded
  state** in the **same transaction**, so they never lead or lag the base rows.
- **Idempotent + resumable.** `projection_offsets` stores, per workspace, the applied `version` and the
  Durable Streams resume cursor. On restart, resume each tail from the cursor and **skip events with
  `version ≤ applied`** — no re-fold from zero ([wiki/DESIGN.md §8.3](../wiki/DESIGN.md)). The stream
  remains the source of truth; SQL is a rebuildable cache.

### 5.2 Schema (the section tree + typed fields + JSONB)

One schema serves **every** page type — the engine's types are pluggable, and the content model is now a
**tree of typed sections** ([structured-content §2](../docs/structured-content.md)) rather than flat
`fields`/`items` containers. There is no longer a `fields JSONB` + `items JSONB` pair per page; instead the
section tree is materialized one row per section, each section's ordered **typed fields** living in JSONB
keyed by `fieldKey`, with the field-kind tag preserved so a query can discriminate `scalar` / `prose` /
`code` / `attachment-ref` / `ref` / `blocks` / `list` ([structured-content §3](../docs/structured-content.md)).
Type-specific shape stays in **JSONB**, queryable with Postgres JSON operators
([ADR-M2](../docs/wiki/decision-records/sql-read-model-via-kysely-pglite-local-pg-prod.md)):

```sql
workspaces(id PK, name, status, updated_at)                       -- applied position lives in projection_offsets (one source of truth)
pages(id PK, workspace_id FK, type, parent_id, title, status,
      created_at, updated_at)                                     -- page-level only; content lives in sections
sections(id PK, workspace_id FK, page_id FK, parent_id,           -- the intra-page section tree (§2 nests)
         key, name, ord,                                          -- key: stable, model-declared; ord: explicit order
         fields JSONB, meta JSONB)                                -- fields keyed by fieldKey, each {kind, …}; meta bag (§9.5)
tree_edges(workspace_id, parent_id, child_id, ord)                -- ordered page children (workspace tree)
links(workspace_id, from_id, to_id, role)
events(workspace_id, version, type, page_id, command, payload JSONB, occurred_at)  -- the log; `command` is the originating command recorded in metadata (§9.4)
projection_offsets(workspace_id PK, applied_version, cursor, fingerprint)  -- resume + IReadModel
```

- **Sections, not fields/items.** A `list` field's elements (items) live **inside** that field's JSONB
  (`{ kind: "list", elementType, elements: [...] }`), so a `question` element keeps its `id`, optional
  status, fields, and meta in one place; there is no separate `items` table. A `blocks` field's block/inline
  tree lives in the **same** field JSONB (`{ kind: "blocks", blocks: [...] }`) as a typed,
  `structuredClone`-/`jsonb`-safe tree ([structured-content §3.1](../docs/structured-content.md)) — never an
  opaque Markdown blob. Both fold deterministically (explicit array order, stable injected ids), so the
  serialized JSONB is byte-stable for equal state.
- **The section tree is queryable.** `sections.parent_id` + `ord` materialize the intra-page tree directly
  (the §6 outline is read straight off it); `(page_id, key)` is unique per page, so a `(sectionKey, fieldKey)`
  address resolves with one indexed lookup.
- **No render column.** Markdown is itself a read model now ([structured-content §8](../docs/structured-content.md))
  — the configurable Markdown render read model, a sibling of this SQL one — so `renderPage` is served by that
  projection from folded state + the model's static render config, not from a stored string.

`waitFor({ws, version})` resolves when `projection_offsets.applied_version ≥ version` (the load-bearing
semantic). In every v1 topology the tailer that writes SQL and the reader that serves `waitFor` share one
process and DB, so an **in-process notify-on-commit** wakes waiters with a short **poll** as backstop;
cross-process `LISTEN/NOTIFY` is reserved for a future multi-process `pg` topology (PGlite has no
cross-process notify) — a build-time detail. Typed cross-workspace query tables (e.g. `open_questions`)
are an opt-in **hybrid** extension maintained by registered projectors ([§14](#14-future-work)) — the
core+JSONB layer needs none to function.

### 5.3 PGlite local, Postgres prod

Kysely speaks the **Postgres dialect** to both, so SQL is the same across environments — close to
drift-free, though PGlite and a Postgres server aren't byte-identical, so a `pg` smoke subset guards the
gap ([§13](#13-testing-strategy)). **PGlite** ([@electric-sql/pglite](https://pglite.dev)) is embedded Postgres-in-process — zero
infra for dev/test/single-node, persisting to a data dir (or memory for tests). **pg** is a real
Postgres for production. The choice is one config knob, mirroring `wiki-server`'s file/managed tiers and
completing the **ElectricSQL** stack (Durable Streams + PGlite). Schema changes ship as **Kysely
migrations**; a `fingerprint` (registered page-type set + schema version) invalidates and triggers a
rebuild-from-stream when it changes.

---

## 6. Derived projections (outline · symbols · cross-references)

The section model makes content **first-class, uniform, and introspectable**
([structured-content §1](../docs/structured-content.md)), so deterministic, language-aware tooling lives
**here in the host as read-side projections** over canonical content
([structured-content §11](../docs/structured-content.md)), fed by the **same projection tailer** as the SQL
read model (§5.1). Each is a pure function of the **folded state** for a commit, recomputed and written in
the **same per-commit transaction** (§5.1) so it advances with the same `appliedToken` — a `waitFor` that
sees the base rows sees the indexes too. None of these touch `wiki`: the engine stores canonical text and a
content hash only ([structured-content §4/§13](../docs/structured-content.md)).

### 6.1 Outline — the section tree

The **outline** is the section names/tree straight from folded state
([structured-content §11](../docs/structured-content.md)) — no parsing. It is materialized directly off
`sections(page_id, parent_id, key, name, ord)` (§5.2): a token-gated `outline(pageId)` read returns the
nested `(key, name, order)` tree. Outline-organizing **headings are sections**; a `heading` *block* is
intra-section presentation and is **not** an outline entry
([structured-content §2/§3.1](../docs/structured-content.md)).

### 6.2 Symbol index — over `code` fields **and** `code` blocks

A **symbol index** is derived by parsing canonical `code` source through the §7 `LanguageRegistry`
([structured-content §11](../docs/structured-content.md)). Crucially it indexes **both** code-bearing
shapes, because a `code` block **is** a `code` field with a `blockId` — same `{ lang, source, hash }`, same
analyzer ([structured-content §3.1](../docs/structured-content.md)):

```sql
symbols(workspace_id, page_id, section_id, field_key,
        block_id,                                  -- NULL for a `code` field; the BlockId for a `code` block (§3.1)
        name, kind, lang, range, def_hash)         -- range over canonical source; def_hash = the field/block content hash
```

The key `(section_id, field_key, block_id?)` reaches code embedded in a `blocks` document with **zero new
machinery** — the same path serves both. `def_hash` carries the §5/§9.4 content hash, so the rename
worked-example ([structured-content §5](../docs/structured-content.md)) reads canonical source and the hash
straight from this projection and issues a hash-preconditioned `applyTextEdits` (§6.4). A parser upgrade
re-projects the index; it never rewrites history ([structured-content §4](../docs/structured-content.md)).

### 6.3 Cross-reference index — walks **into** block/inline trees

A **cross-reference index** records every `ref` ([structured-content §3](../docs/structured-content.md)) so
reorders/renames/renumbers and integrity are tool-decidable. A `ref` exists at **two depths** — a `ref`
*field*, and an inline **`ref` span** inside a prose block (paragraph / heading / list item / table cell)
([structured-content §3.2](../docs/structured-content.md)) — so the projector **recurses into the block and
inline trees**, exactly as the engine's ingestion integrity walk does
([structured-content §7](../docs/structured-content.md)). Because the same walk runs read-side, **an inline
reference can never dangle undetected**:

```sql
xrefs(workspace_id, page_id, src_section_id, src_field_key,
      src_block_id, src_inline_path,              -- where the ref lives: field-level (blocks NULL) or a block/inline path
      target_kind,                                -- section | page | symbol | block (RefTarget, §2)
      target_id, target_section_id, target_field, target_symbol_or_block,
      resolved BOOLEAN)                            -- integrity flag; the engine rejects unresolved at write (§7), this is the read-side mirror
```

The displayed label of a `ref` is **render-derived** (a section number, page title, or symbol name —
[structured-content §3](../docs/structured-content.md)), so this index never stores a label; it stores the
*target*, and the Markdown render read model (§5.2) derives the text. This is the load-bearing payoff of the
document model: a reference *inside a sentence* stays correct under reordering
([structured-content §3.2](../docs/structured-content.md)).

### 6.4 Semantic operations are guarded `applyTextEdits`

`outline` and the indexes are **read-only**; a refactor that *changes* content is still
**FSM-gated + event-sourced** ([structured-content §5/§11](../docs/structured-content.md)). A
language-aware op (rename, extract) is **computed host-side** — the host reads canonical source + content
hash from the symbol index (§6.2), parses via the §7 analyzer, and computes the new source plus the
in-scope edit ranges — then applies the result as **one guarded `applyTextEdits` section operation**
([structured-content §9.4](../docs/structured-content.md)) carrying a **content-hash precondition**
([structured-content §5](../docs/structured-content.md)): the pure command rejects an edit computed against
source made stale by an OCC rebase. Even a refactor is therefore one attributed event in `history()`
(recorded under e.g. `renameSymbol`, §5.2 `events.command`), folded by the one built-in reducer; render
fences the new source verbatim. Cross-page references within one workspace ride one atomic multi-page append
(the `moveItem` precedent); cross-workspace references are reported, not silently touched
([structured-content §5](../docs/structured-content.md)). This package never parses inside `produces` — all
language work is host-side ([structured-content §5](../docs/structured-content.md)).

---

## 7. The LanguageRegistry (runtime analyzer plugins)

Parsers (tree-sitter / Roslyn / LSP) are **heavy and version-sensitive**, so they live **in the host, never
in `wiki`** ([structured-content §4/§11/§13](../docs/structured-content.md)). They load through a runtime
**`LanguageRegistry`** that **mirrors the `ModelRegistry` dynamic-import pattern**
([ADR-M6](../docs/wiki/decision-records/live-modelregistry-with-cache-busted-hot-reload.md)): per-language analyzers are
loaded **by module specifier** via cache-busted `import()`, registered/loaded/reloaded/unregistered behind a
generation counter, and selected per `lang` tag at projection time.

Each plugin exposes a narrow **`ILanguageAnalyzer`** ([structured-content §11](../docs/structured-content.md)):

```ts
interface ILanguageAnalyzer {
  readonly lang: string;                                  // matches a `code` field/block's lang tag (§3)
  parse(source: string): Ast;                             // read-model AST — derived, never stored (§4)
  symbols(source: string): SymbolEntry[];                 // feeds the symbol index (§6.2)
  references(source: string): ReferenceEntry[];           // in-source refs; complements the §6.3 ref index
  rename(source: string, symbol: string, to: string):     // computes edits host-side (§6.4) — no write
    { edits: TextEdit[]; unresolved: Site[] };
}
```

- **AST is a read-model projection.** An analyzer parses canonical source **inside a projection** in this
  host — exactly as the SQL read model serializes state — and the result feeds §6.2/§6.3. The **canonical
  text stays the write-model source of truth** ([structured-content §4/§10](../docs/structured-content.md));
  the engine never stores or folds an AST. A parser upgrade re-projects; it never rewrites history.
- **Mirrors ADR-M6, separately.** The `LanguageRegistry` is a *sibling* of the `ModelRegistry`, not the same
  object: `ModelRegistry` swaps **page-type schema** (and triggers a re-fold/reproject); `LanguageRegistry`
  swaps **analyzers** and triggers a re-projection of the §6.2/§6.3 indexes only (write-model state is
  untouched — analyzers never fold). Both share the cache-busting `import(fileURL + '?v=' + hash)` trick and
  a generation counter; control is **pipeline-driven** off the `wiki-server` control listener
  (a `/_server/languages` sibling of `/_server/models`, [wiki-server/DESIGN.md §8.5](../wiki-server/DESIGN.md)),
  not an MCP tool — same trust/operability stance as ADR-M6.
- **`rename` returns, never writes.** An analyzer is **pure-ish input→edits**; it returns the `TextEdit[]`
  (and any unresolved/ambiguous sites, [structured-content §5](../docs/structured-content.md)) which §6.4
  then applies as a guarded, hash-preconditioned `applyTextEdits`. The analyzer has no write authority.

Phasing follows the spec ([structured-content §12](../docs/structured-content.md)): **outline + symbol-index
read-only projections first** (Phase 2, establishing the analyzer contract and token-gating before any
write-back), then **semantic operations** (Phase 3, one language first). Until an analyzer for a `lang` is
loaded, a `code` field is an opaque canonical blob served verbatim — the outline and the structural
cross-reference index still work, since they need no parser.

---

## 8. The MCP server & token management

The MCP surface turns the engine into agent-callable tools/resources, and is where the two CQRS planes
are **plugged together**.

### 8.1 Tools & resources

- **Tools (writes + queries).** The engine's command catalog becomes MCP tools. **Page** mutations take
  their input schema straight from the command's `argsSchema` (`IPageView.describeMutations()` —
  [wiki/DESIGN.md §10.4](../wiki/DESIGN.md)); in the section model these are the generated structural
  commands (set a field, add/move a section, add/set a block, add/set an element) plus declared commands,
  each surfaced with the `(section, field)` it touches ([structured-content §9.4](../docs/structured-content.md)).
  **Structural** commands (`createPage`, `reparent`, `link`, …) aren't covered by `describeMutations()` today
  (it is page-scoped in `api.ts`), so their tool schemas need a small engine addition (a structural-command
  catalog) or hand-authored schemas in v1. Plus read tools (`getPage`, `renderPage`, `tree`, `listWorkspaces`,
  `search`, `openQuestions`) and the **derived-projection** read tools `outline`, `symbols`, and `references`
  (§6) — token-gated like every read.
- **Resources (reads).** Workspaces/pages as resources — `wiki://{ns}/workspace/{id}` (rendered Markdown
  for the tree) and `…/page/{pageId}` — served from the SQL read model. Page Markdown is produced by the
  **render read model** (§5.2), not a stored render column.
- **Only-legal-actions.** The full catalog is exposed; the engine's guard rejects illegal calls with
  **structured errors** (status + legal set, [wiki/DESIGN.md §12/§14](../wiki/DESIGN.md)) the agent
  self-corrects on. A `describeMutations`-style tool reports the *currently* legal set per page; dynamic
  per-resource tool lists are a refinement ([§14](#14-future-work)).
- **Transport.** **stdio** for a local agent; **HTTP/SSE** (streamable HTTP) when networked/embedded in
  `wiki-server`. The transport is a `CreateWikiMcpOptions.transport` field the **embedding host chooses**:
  the standalone `bin` defaults to stdio, while `wiki-server` passes the http transport. (MCP SDK specifics
  confirmed at build — [§12](#12-package-structure).)

### 8.2 Token management (automatic read-your-writes)

This realizes the owner's "the MCP server manages the tokens so MCP commands always return updated
read-model data":

- Each MCP **session** holds a **high-water token per workspace** (the max token from *every* write tool it
  ran — including the void structural commands, [§3.2](#32-writes-return-a-token)).
- A **write tool** runs against the embedded engine, which returns a token; the server advances that
  workspace's high-water mark and includes the token in the tool result (so a client *may* also thread it).
- A **single-workspace read** passes that workspace's high-water token as `consistentWith`, waiting for the
  SQL read model to catch up ([§3.3](#33-reads-wait-on-a-token)) before serving.
- A **cross-workspace read** (`search`, `openQuestions`) **fans out** — it waits on the high-water token of
  *each* workspace the session has written, so the result reflects all of the session's writes, not just
  one (a single combined token *vector* is [§14](#14-future-work)).

The agent therefore always sees its own prior writes (session read-your-writes + monotonic reads), while
distinct sessions stay independent and the model stays eventually consistent. Session high-water marks are
per-session: a **reconnect resets** them (subsequent reads are eventually-consistent until the session
writes again, or the client threads a returned token). A `waitFor` timeout maps to a retryable MCP error,
or an explicit `stale: true` result ([§11](#11-failure--operational-concerns)).

---

## 9. Staying hydrated (the runtime)

The answer to "rehydration per call is a non-starter":

- **Read side — never re-folds.** The SQL read model — and the §6 derived projections it co-maintains — is
  kept current by the projection tailer and is **durable**; on restart it resumes from `applied_version`
  ([§5.1](#51-projection-mechanism)), not from zero. Reads (the bulk of agent traffic, including
  cross-workspace queries, outline, and symbol/cross-reference lookups) hit SQL directly.
- **Write side — stays hot.** The embedded engine keeps active workspace **handles open** (live tail keeps
  their write-side aggregate fresh), bounded by an LRU (`IWikiConfig.cache.maxWorkspaces` —
  [wiki/DESIGN.md §10.1](../wiki/DESIGN.md)). A command on a hot workspace appends with **no refold**; a
  cold workspace opens once (snapshot + short tail) and *stays* hot.
- **Bounded memory.** Only N workspaces are hot for writes at a time; everything else is served from SQL.
  The expensive full-fold path effectively disappears from steady state.

---

## 10. wiki-server integration

`wiki-mcp` is the **module that holds the engine and the logic**; `wiki-server` is the **process that hosts
streams and hosts `wiki-mcp`**. There are **no modes** — one process does both. `wiki-server` stays a thin
host: it boots the Durable Streams host, then starts `wiki-mcp`, passing the local stream `baseUrl`/namespace
and the DB config. The projection tailer reads **localhost** streams (cheap). The MCP surface is served over
**streamable HTTP** on its **own** listener: `wiki-server` runs a third `http.createServer` (beside the stream
host on `port` and the control/log listener on `port`+1) on `--mcp-port` (env `WIKI_SERVER_MCP_PORT`, default
`port`+2, e.g. `4439`), exposing the endpoint at `http://<host>:<mcpPort>/mcp`. It builds the
`{ kind: "http", host, port: mcpPort, path: "/mcp" }` transport and passes it into `createWikiMcp` — an
embedded host **cannot** use stdio, which binds the host process's own terminal and is unreachable by a
separate MCP client ([§8.1](#81-tools--resources)). `wiki-server` logs `mcpUrl` on boot and surfaces it on
`GET /_server/info` (and on its `RunningWikiServer` handle), so a client can discover where to connect (see
[`wiki-server/DESIGN.md` §8.5](../wiki-server/DESIGN.md)).

The split is about *where logic lives*, not deployment shape: **the engine, read model, projection, token
management, and MCP surface all live in `wiki-mcp`** ([ADR-M5](../docs/wiki/decision-records/wiki-mcp-holds-the-logic-wiki-server-hosts-it.md)).
`wiki-server` may *know* it has an engine (transitively, via `wiki-mcp`) — that's fine — it just must not
*implement* engine logic itself. `wiki-mcp` imports the **engine** as a library and reaches streams over
`@durable-streams/client`; it never imports `wiki-server` code. (`wiki-server/DESIGN.md` is amended to record
that it hosts `wiki-mcp`.)

**Logging.** `wiki-mcp` does not own a log API; it emits all telemetry through a `Logger` the **host
injects** (`createWikiMcp({ logger })`, [§11](#11-failure--operational-concerns)). `wiki-server` passes its
**consolidating** logger, so engine / projection / MCP logs land in one stream with the stream host's and
are exposed by the host's log API ([wiki-server/DESIGN.md §8.5](../wiki-server/DESIGN.md)).

---

## 11. Failure & operational concerns

- **Projection lag & backpressure.** Reads with a token wait up to `timeoutMs`; on timeout, a typed
  error (retryable) or an explicit `stale: true` result — never a silent stale read presented as fresh.
- **Rebuild.** The read model is a cache: drop the tables and re-fold every workspace from its stream
  (the source of truth) — base rows **and** the §6 derived projections together. Triggered manually or by a
  `fingerprint` change ([§5.3](#53-pglite-local-postgres-prod)); a `LanguageRegistry` (§7) swap re-projects
  the symbol/cross-reference indexes only, without re-folding the write model.
- **Poison events.** An event the configured page types can't fold fails closed (`UnknownPageTypeError`,
  [wiki/DESIGN.md §8.5](../wiki/DESIGN.md)); the affected workspace's projection halts (and is reported)
  rather than corrupting SQL — register the type or a shim to proceed.
- **Two stores, one truth.** The stream is authoritative; SQL never feeds command validation, so a SQL
  failure degrades reads (and read-your-writes waits) but **cannot** corrupt the write model.
- **Migrations.** Kysely migrations run at startup; a schema/fingerprint bump rebuilds rather than
  attempting a lossy in-place migration of a derived cache.
- **Logging via an injected `Logger`.** `wiki-mcp` emits operational telemetry (projection progress,
  tail lag, MCP requests, errors) through a `Logger` it **takes from the host** — it owns no log API of
  its own, so the host can consolidate and expose it ([wiki-server/DESIGN.md §8.5](../wiki-server/DESIGN.md)).
  The interface is minimal; `createWikiMcp({ …, logger })` accepts it (default: a console logger when run
  standalone):

```ts
export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child?(fields: Record<string, unknown>): Logger;   // optional scoped logger
}
```

---

## 12. Package structure

A consumer sibling. **New dependencies** (none currently in the repo — versions/APIs pinned at build):
`wiki`, `kysely`, `@electric-sql/pglite`, `pg`, and an MCP SDK (`@modelcontextprotocol/sdk`). Per-language
**analyzer** packages (tree-sitter / Roslyn / LSP) are **not** deps of `wiki-mcp` — they load at runtime
behind the `LanguageRegistry` (§7), exactly as model bundles load behind the `ModelRegistry`.

```
.
├─ wiki/                         # engine (library dependency)
├─ wiki-server/                  # stream host: hosts wiki-mcp (§10)
└─ wiki-mcp/                     # ← THIS package
    ├─ package.json             # bin: wiki-mcp → dist/bin.js; deps above
    ├─ DESIGN.md
    └─ src/
        ├─ main.ts              # LIBRARY (side-effect-free): exports createWikiMcp/main/types; config → createWikiMcp({ …, logger }) → start (stdio|http). No shebang, no self-exec guard.
        ├─ bin.ts               # bin entry: #!/usr/bin/env node; runs main() over stdio; holds the self-exec guard (kept out of the library so a host bundling wiki-mcp from source can't auto-boot a rogue server)
        ├─ config.ts            # namespace, stream baseUrl, db (pglite|pg), timeouts, injected Logger (§11)
        ├─ logger.ts            # the injected Logger interface + console/silent defaults (§11)
        ├─ engine.ts            # build the embedded IWiki (write side), hot-handle LRU, token surface; rebind for ADR-M6
        ├─ readmodel/
        │   ├─ schema.ts        #   Kysely table types (pages, sections, symbols, xrefs, …; §5.2/§6)
        │   ├─ migrations/      #   Kysely migrations
        │   ├─ store.ts         #   open + migrate the Kysely store (PGlite | pg)
        │   ├─ pglite-dialect.ts #  hand-rolled Kysely dialect for PGlite
        │   ├─ project.ts       #   fold → serialize state → SQL (one txn/commit): section tree + typed fields + blocks
        │   ├─ derive.ts        #   derived projections from folded state: outline · symbol index · xref index (§6)
        │   ├─ render.ts        #   Markdown render read model — folded state + static render config (§5.2; structured-content §8)
        │   └─ readmodel.ts     #   IReadModel: appliedToken / waitFor + typed queries (incl. outline/symbols/references)
        ├─ models/
        │   ├─ registry.ts      #   live ModelRegistry: generation-counted, mutable page-type set (ADR-M6)
        │   └─ loader.ts        #   cache-busted dynamic import() of a model bundle (ADR-M6)
        ├─ lang/
        │   ├─ registry.ts      #   live LanguageRegistry: generation-counted analyzer set (§7, mirrors models/registry.ts)
        │   ├─ loader.ts        #   cache-busted dynamic import() of an analyzer plugin (§7, mirrors models/loader.ts)
        │   └─ analyzer.ts      #   ILanguageAnalyzer contract: parse / symbols / references / rename (§7)
        ├─ tail/
        │   ├─ projection.ts    #   catalog + per-workspace tailers driving project.ts + derive.ts (rebind/reproject, ADR-M6)
        │   └─ engine-source.ts #   EventSource over the embedded engine — history() + subscribe()
        └─ mcp/
            ├─ tools.ts         #   command catalog + queries → MCP tools (from argsSchema; incl. outline/symbols/references)
            ├─ resources.ts     #   wiki:// resources from the read model
            ├─ tokens.ts        #   per-session high-water token manager (§8.2)
            └─ server.ts        #   MCP server (stdio | http/sse)
```

Like `wiki-server`, it is **compiled and run as Node** (`bin`), so relative imports use **`.js`
extensions** (raw Node ESM needs them; the engine's extensionless `Bundler` style is for source-consumed
packages). The **bin is split from the library**: `bin.ts` holds the `#!/usr/bin/env node` shebang and the
`import.meta.url` self-exec guard and runs `main()` over stdio, while `main.ts` stays side-effect-free —
because a host that bundles `wiki-mcp` **from source** inlines every module under one shared
`import.meta.url`, so a guard living in the library would fire under the host's argv and boot a rogue second
server. tsdown's `entry` is
`src/bin.ts` (output `dist/bin.js`, the package `bin`), and its `deps.alwaysBundle` must use a **regex**
(`/^wiki(\/|$)/`) so the `wiki/registry` and `wiki/authoring` **subpath** exports are bundled too — a
bare-string match leaves them external and Node crashes at runtime loading the engine's extensionless TS
source (`ERR_MODULE_NOT_FOUND`).
Add `wiki-mcp` to the root `workspaces`. It imports `wiki`'s **public** surface only.

---

## 13. Testing strategy

Tests target the **CQRS seam** and the **projection**, using an in-memory `DurableStreamTestServer`
([wiki/testing](../wiki/DESIGN.md)) and a **PGlite** instance (in-memory) for the read model.

- **Token semantics.** A write returns a token; a read with that token blocks until the projection
  applies it, then returns the new state; a read without a token may return stale. `waitFor` times out as
  specified.
- **Read-your-writes via MCP.** Through the MCP server: a write tool then a read tool (same session) always
  reflects the write — and `waitFor` is what makes it pass (prove by injecting projection lag).
- **Projection correctness.** For a scripted history, the serialized SQL equals the engine's folded
  `IWorkspaceState` (page/section/field/tree/link rows + JSONB, with `list` elements and `blocks` trees in
  field JSONB, §5.2); cross-workspace queries (`openQuestions`) match.
- **Derived projections (§6).** For a scripted history, `outline` equals the folded section tree; the symbol
  index covers symbols in **both** `code` fields and `code` blocks (keyed by `block_id`); the cross-reference
  index resolves every `ref` field **and** inline ref-span (the walk descends into block/inline trees), and
  flags a deliberately-dangled inline ref — proving an inline reference can never dangle undetected.
- **Semantic ops are guarded (§6.4).** A host-computed rename applies as one `applyTextEdits` with a content-hash
  precondition; a stale hash (post-rebase) is rejected; render fences the new source byte-identically; `history()`
  attributes the event to the originating command.
- **Resume.** Apply N commits → stop → restart → the projection resumes from `applied_version` (no re-fold)
  and converges; idempotent re-delivery causes no double-apply.
- **MCP surface.** Tool input schemas equal the engine's `argsSchema`; resources render the read model;
  illegal mutations surface the engine's structured error.
- **Dialect parity.** The projection suite runs on PGlite; a smoke subset runs on `pg` to guard dialect drift.

---

## 14. Future work

- **Hybrid per-type projection tables** (e.g. `open_questions`, full-text search) via registered projectors,
  beyond core+JSONB ([§5.2](#52-schema-the-section-tree--typed-fields--jsonb)).
- **Richer analysis projections** beyond outline/symbols/cross-references — call graph and type index over
  `code` fields/blocks ([structured-content §11](../docs/structured-content.md)), once the §7 analyzer contract
  and per-workspace re-projection on a `LanguageRegistry` swap are proven.
- **Dynamic MCP tool lists** scoped to a page's currently-legal commands (push `tools/list_changed`).
- **Cross-workspace / cross-namespace** read models and dashboards (the read model makes these natural —
  [wiki/DESIGN.md §18](../wiki/DESIGN.md)).
- **Multiple read models** behind the same `IReadModel` (e.g. a search index, an analytics warehouse).
- **Token vectors** for multi-workspace transactions/reads, if a use case needs cross-aggregate consistency.

---

## 15. References

- Engine (embedded; the CQRS contract must land here): [`wiki/DESIGN.md`](../wiki/DESIGN.md) — §8 (event sourcing), §8.4 (live projection), §10 (API), §12 (LLM), §14 (errors).
- **Content model (authoritative)**: [`docs/structured-content.md`](../docs/structured-content.md) — §2 (section tree), §3 (field-kinds + blocks/inline), §4 (write model vs read models), §5 (code edits), §9.4 (section operations), §11 (host projections + `LanguageRegistry`).
- Stream host (hosts wiki-mcp): [`wiki-server/DESIGN.md`](../wiki-server/DESIGN.md).
- Schema layer (runtime-loaded page-type bundles): [`wiki-models/DESIGN.md`](../wiki-models/DESIGN.md) — the `ModelRegistry` loads these ([ADR-M6](../docs/wiki/decision-records/live-modelregistry-with-cache-busted-hot-reload.md)); the `LanguageRegistry` (§7) mirrors it for analyzers.
- Parsers (load behind the `LanguageRegistry`, §7): tree-sitter <https://tree-sitter.github.io> · LSP <https://microsoft.github.io/language-server-protocol/> · Roslyn.
- Kysely: <https://kysely.dev> · PGlite: <https://pglite.dev> · node-postgres: <https://node-postgres.com>
- Model Context Protocol: <https://modelcontextprotocol.io> · TS SDK: `@modelcontextprotocol/sdk`.
- CQRS / read models: Fowler, <https://martinfowler.com/bliki/CQRS.html>.

---

## Appendix A: Decision records

These architecture decisions are now first-class, FSM-governed pages in the wiki, rendered to
[`docs/wiki/decision-records/`](../docs/wiki/decision-records/) (the engine's own Markdown
projection — see the [index](../docs/wiki/decision-records/index.md)). They are no longer
maintained inline here; the legacy IDs map to their pages:

| Legacy ID | Decision |
|---|---|
| ADR-M1 | [CQRS with consistency tokens in the engine core](../docs/wiki/decision-records/cqrs-with-consistency-tokens-in-the-engine-core.md) |
| ADR-M2 | [SQL read model via Kysely; PGlite local, pg prod](../docs/wiki/decision-records/sql-read-model-via-kysely-pglite-local-pg-prod.md) |
| ADR-M3 | [Projection = engine-fold + serialize-to-SQL](../docs/wiki/decision-records/projection-engine-fold-serialize-to-sql.md) |
| ADR-M4 | [The MCP server manages tokens for automatic read-your-writes](../docs/wiki/decision-records/the-mcp-server-manages-tokens-for-automatic-read-your-writes.md) |
| ADR-M5 | [wiki-mcp holds the logic; wiki-server hosts it](../docs/wiki/decision-records/wiki-mcp-holds-the-logic-wiki-server-hosts-it.md) |
| ADR-M6 | [Live ModelRegistry with cache-busted hot-reload](../docs/wiki/decision-records/live-modelregistry-with-cache-busted-hot-reload.md) |
| ADR-M7 | [AST/analysis as read-side projections + a runtime LanguageRegistry](../docs/wiki/decision-records/ast-analysis-as-read-side-projections-a-runtime-languageregistry.md) |
