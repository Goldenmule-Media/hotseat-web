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
6. [The MCP server & token management](#6-the-mcp-server--token-management)
7. [Staying hydrated (the runtime)](#7-staying-hydrated-the-runtime)
8. [wiki-server integration](#8-wiki-server-integration)
9. [Failure & operational concerns](#9-failure--operational-concerns)
10. [Package structure](#10-package-structure)
11. [Testing strategy](#11-testing-strategy)
12. [Future work](#12-future-work)
13. [References](#13-references)
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
  and an always-current read model. Reads never re-fold history ([§7](#7-staying-hydrated-the-runtime)).
- **G2 — Strict CQRS with tokens, in the core.** Write/read separation + eventual consistency are an
  **engine** contract: writes return a token, reads optionally wait on it ([§3](#3-the-core-cqrs-contract-engine-level)).
- **G3 — A durable SQL read model.** Projections in Postgres via **Kysely** — **PGlite** locally,
  **pg** in production (same SQL, dev/prod parity). Survives restart; resumes without re-folding from
  zero ([§5](#5-the-sql-read-model-kysely--pglitepg)).
- **G4 — An MCP surface.** The engine's command catalog → MCP **tools** (it is LLM-first by design,
  [wiki/DESIGN.md §12](../wiki/DESIGN.md)); workspaces/pages → MCP **resources** ([§6](#6-the-mcp-server--token-management)).
- **G5 — Automatic read-your-writes.** The MCP server tracks each session's tokens and threads them
  into reads, so an agent's reads always reflect its own writes — without the agent managing tokens.
- **G6 — Clean layering.** Engine contract (core) ⟂ read model (SQL) ⟂ MCP surface — each replaceable.

---

## 2. Non-goals

- **No new domain model or rules.** The engine owns mutations, the FSM, invariants, rendering. The
  read model is *derived*; it never validates a command.
- **Not synchronous read/write.** Read-after-write is achieved by **waiting on a token**, not by
  writing both stores in one transaction ([§3.3](#33-reads-wait-on-a-token), [ADR-M1](#adr-m1--cqrs-with-consistency-tokens-in-the-engine-core-2026-06-02)).
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
structural ones — in `Committed<T>` is a breaking engine change ([ADR-M1](#adr-m1--cqrs-with-consistency-tokens-in-the-engine-core-2026-06-02)).

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
caller can retry or read stale-with-a-flag ([§9](#9-failure--operational-concerns)).

**Undiscovered workspaces & halts.** `waitFor(token)` must not depend on the read model having already
*discovered* the token's workspace — the namespace catalog is only eventually consistent
([wiki/DESIGN.md §9.3](../wiki/DESIGN.md)), so a just-created workspace's first token can arrive before its
tailer exists. `waitFor` therefore **lazily ensures a tail** for the referenced workspace (opening one
directly) rather than waiting on catalog discovery, and `appliedToken` of an unknown workspace is the zero
token. If a workspace's projection has **halted** ([§9](#9-failure--operational-concerns)), `waitFor`
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
   │   a token §3.2)                │    └─ queries: page, tree, render, search,       │
   │      │ append                  │        "open questions" across workspaces        │
   │      ▼                         │                    ▲                             │
   │  ════ workspace streams ═══════╪════════════════════╪═══ projection tailer ═══════│
   │       (Durable Streams)        └── token (version) ──┘   (live tail → apply → SQL) │
   └──────────────────────────────────────────────────────────────────────────────────┘
        ▲ append/read over @durable-streams/client          (wiki-server hosts both, §8)
   ┌────┴───────────────────────┐
   │ wiki-server (stream host)   │
   └─────────────────────────────┘
```

The token bridges the two planes: a write appends at `version N` and returns the token; the **projection
tailer** later reads `version N` off the stream and applies it to SQL, advancing `appliedToken` to `N`;
a `waitFor(N)` resolves exactly then.

**Dependency direction:** `wiki-mcp` → `wiki` (engine, library), **Kysely**, **PGlite**/**pg**, and an
**MCP SDK** — all *new* dependencies ([§10](#10-package-structure)). `wiki-server` → `wiki-mcp` (hosts it,
[§8](#8-wiki-server-integration)).

---

## 5. The SQL read model (Kysely · PGlite/pg)

A **projection service** owns the SQL read model and implements `IReadModel` ([§3.3](#33-reads-wait-on-a-token)).

### 5.1 Projection mechanism

- **Discover & tail.** Tail the namespace **catalog** ([wiki/DESIGN.md §9.3](../wiki/DESIGN.md)) to learn
  workspaces; for each, hold a live tail of its stream ([wiki/DESIGN.md §8.4](../wiki/DESIGN.md)).
- **Apply = fold then serialize.** For each commit (an ordered event batch), fold it with the engine's
  **reducer** to the resulting `IWorkspaceState`, then **serialize that state into SQL** ([ADR-M3](#adr-m3--projection--engine-fold--serialize-to-sql-2026-06-02)).
  Reusing the fold means the read model can never *semantically* diverge from the write model (same
  upcasting, same unknown-type policy) — the only mapping we own is state→rows. **This requires the engine
  to expose a *public, pure* fold** (`foldWorkspace`/`applyWorkspace` are internal today —
  [wiki/DESIGN.md §16.1](../wiki/DESIGN.md)); exporting a read-only fold for external read models is part of
  the coordinated engine changes.
- **Atomic per commit.** Each commit's row writes **and** the new `applied version` for that workspace are
  written in **one SQL transaction**, so `appliedToken` never reports ahead of the data.
- **Idempotent + resumable.** `projection_offsets` stores, per workspace, the applied `version` and the
  Durable Streams resume cursor. On restart, resume each tail from the cursor and **skip events with
  `version ≤ applied`** — no re-fold from zero ([wiki/DESIGN.md §8.3](../wiki/DESIGN.md)). The stream
  remains the source of truth; SQL is a rebuildable cache.

### 5.2 Schema (core tables + JSONB)

One schema serves **every** page type — the engine's types are pluggable, so type-specific data lives in
**JSONB**, queryable with Postgres JSON operators ([ADR-M2](#adr-m2--sql-read-model-via-kysely-pglite-local-pg-prod-2026-06-02)):

```sql
workspaces(id PK, name, status, updated_at)                       -- applied position lives in projection_offsets (one source of truth)
pages(id PK, workspace_id FK, type, parent_id, title, status,
      fields JSONB, items JSONB, created_at, updated_at)          -- items e.g. {question:[...],task:[...]}
tree_edges(workspace_id, parent_id, child_id, ord)                -- ordered children
links(workspace_id, from_id, to_id, role)
events(workspace_id, version, type, page_id, payload JSONB, occurred_at)   -- the log, queryable
projection_offsets(workspace_id PK, applied_version, cursor, fingerprint)  -- resume + IReadModel
```

`waitFor({ws, version})` resolves when `projection_offsets.applied_version ≥ version` (the load-bearing
semantic). In every v1 topology the tailer that writes SQL and the reader that serves `waitFor` share one
process and DB, so an **in-process notify-on-commit** wakes waiters with a short **poll** as backstop;
cross-process `LISTEN/NOTIFY` is reserved for a future multi-process `pg` topology (PGlite has no
cross-process notify) — a build-time detail. Typed cross-workspace query tables (e.g. `open_questions`)
are an opt-in **hybrid** extension maintained by registered projectors ([§12](#12-future-work)) — the
core+JSONB layer needs none to function.

### 5.3 PGlite local, Postgres prod

Kysely speaks the **Postgres dialect** to both, so SQL is the same across environments — close to
drift-free, though PGlite and a Postgres server aren't byte-identical, so a `pg` smoke subset guards the
gap ([§11](#11-testing-strategy)). **PGlite** ([@electric-sql/pglite](https://pglite.dev)) is embedded Postgres-in-process — zero
infra for dev/test/single-node, persisting to a data dir (or memory for tests). **pg** is a real
Postgres for production. The choice is one config knob, mirroring `wiki-server`'s file/managed tiers and
completing the **ElectricSQL** stack (Durable Streams + PGlite). Schema changes ship as **Kysely
migrations**; a `fingerprint` (registered page-type set + schema version) invalidates and triggers a
rebuild-from-stream when it changes.

---

## 6. The MCP server & token management

The MCP surface turns the engine into agent-callable tools/resources, and is where the two CQRS planes
are **plugged together**.

### 6.1 Tools & resources

- **Tools (writes + queries).** The engine's command catalog becomes MCP tools. **Page** mutations take
  their input schema straight from the command's `argsSchema` (`IPageView.describeMutations()` —
  [wiki/DESIGN.md §10.4](../wiki/DESIGN.md)). **Structural** commands (`createPage`, `reparent`, `link`, …)
  aren't covered by `describeMutations()` today (it is page-scoped in `api.ts`), so their tool schemas need
  a small engine addition (a structural-command catalog) or hand-authored schemas in v1. Plus read tools
  (`getPage`, `renderPage`, `tree`, `listWorkspaces`, `search`, `openQuestions`).
- **Resources (reads).** Workspaces/pages as resources — `wiki://{ns}/workspace/{id}` (rendered Markdown
  for the tree) and `…/page/{pageId}` — served from the SQL read model.
- **Only-legal-actions.** The full catalog is exposed; the engine's guard rejects illegal calls with
  **structured errors** (status + legal set, [wiki/DESIGN.md §12/§14](../wiki/DESIGN.md)) the agent
  self-corrects on. A `describeMutations`-style tool reports the *currently* legal set per page; dynamic
  per-resource tool lists are a refinement ([§12](#12-future-work)).
- **Transport.** **stdio** for a local agent; **HTTP/SSE** (streamable HTTP) when networked/embedded in
  `wiki-server`. The transport is a `CreateWikiMcpOptions.transport` field the **embedding host chooses**:
  the standalone `bin` defaults to stdio, while `wiki-server` passes the http transport. (MCP SDK specifics
  confirmed at build — [§10](#10-package-structure).)

### 6.2 Token management (automatic read-your-writes)

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
  one (a single combined token *vector* is [§12](#12-future-work)).

The agent therefore always sees its own prior writes (session read-your-writes + monotonic reads), while
distinct sessions stay independent and the model stays eventually consistent. Session high-water marks are
per-session: a **reconnect resets** them (subsequent reads are eventually-consistent until the session
writes again, or the client threads a returned token). A `waitFor` timeout maps to a retryable MCP error,
or an explicit `stale: true` result ([§9](#9-failure--operational-concerns)).

---

## 7. Staying hydrated (the runtime)

The answer to "rehydration per call is a non-starter":

- **Read side — never re-folds.** The SQL read model is kept current by the projection tailer and is
  **durable**; on restart it resumes from `applied_version` ([§5.1](#51-projection-mechanism)), not from
  zero. Reads (the bulk of agent traffic, including cross-workspace queries) hit SQL directly.
- **Write side — stays hot.** The embedded engine keeps active workspace **handles open** (live tail keeps
  their write-side aggregate fresh), bounded by an LRU (`IWikiConfig.cache.maxWorkspaces` —
  [wiki/DESIGN.md §10.1](../wiki/DESIGN.md)). A command on a hot workspace appends with **no refold**; a
  cold workspace opens once (snapshot + short tail) and *stays* hot.
- **Bounded memory.** Only N workspaces are hot for writes at a time; everything else is served from SQL.
  The expensive full-fold path effectively disappears from steady state.

---

## 8. wiki-server integration

`wiki-mcp` is the **module that holds the engine and the logic**; `wiki-server` is the **process that hosts
streams and hosts `wiki-mcp`**. There are **no modes** — one process does both. `wiki-server` stays a thin
host: it boots the Durable Streams host, then starts `wiki-mcp`, passing the local stream `baseUrl`/namespace
and the DB config. The projection tailer reads **localhost** streams (cheap). The MCP surface is served over
**streamable HTTP** on its **own** listener: `wiki-server` runs a third `http.createServer` (beside the stream
host on `port` and the control/log listener on `port`+1) on `--mcp-port` (env `WIKI_SERVER_MCP_PORT`, default
`port`+2, e.g. `4439`), exposing the endpoint at `http://<host>:<mcpPort>/mcp`. It builds the
`{ kind: "http", host, port: mcpPort, path: "/mcp" }` transport and passes it into `createWikiMcp` — an
embedded host **cannot** use stdio, which binds the host process's own terminal and is unreachable by a
separate MCP client ([§6.1](#61-tools--resources)). `wiki-server` logs `mcpUrl` on boot and surfaces it on
`GET /_server/info` (and on its `RunningWikiServer` handle), so a client can discover where to connect (see
[`wiki-server/DESIGN.md` §8.5](../wiki-server/DESIGN.md)).

The split is about *where logic lives*, not deployment shape: **the engine, read model, projection, token
management, and MCP surface all live in `wiki-mcp`** ([ADR-M5](#adr-m5--wiki-mcp-holds-the-logic-wiki-server-hosts-it-2026-06-02)).
`wiki-server` may *know* it has an engine (transitively, via `wiki-mcp`) — that's fine — it just must not
*implement* engine logic itself. `wiki-mcp` imports the **engine** as a library and reaches streams over
`@durable-streams/client`; it never imports `wiki-server` code. (`wiki-server/DESIGN.md` is amended to record
that it hosts `wiki-mcp`.)

**Logging.** `wiki-mcp` does not own a log API; it emits all telemetry through a `Logger` the **host
injects** (`createWikiMcp({ logger })`, [§9](#9-failure--operational-concerns)). `wiki-server` passes its
**consolidating** logger, so engine / projection / MCP logs land in one stream with the stream host's and
are exposed by the host's log API ([wiki-server/DESIGN.md §8.5](../wiki-server/DESIGN.md)).

---

## 9. Failure & operational concerns

- **Projection lag & backpressure.** Reads with a token wait up to `timeoutMs`; on timeout, a typed
  error (retryable) or an explicit `stale: true` result — never a silent stale read presented as fresh.
- **Rebuild.** The read model is a cache: drop the tables and re-fold every workspace from its stream
  (the source of truth). Triggered manually or by a `fingerprint` change ([§5.3](#53-pglite-local-postgres-prod)).
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

## 10. Package structure

A consumer sibling. **New dependencies** (none currently in the repo — versions/APIs pinned at build):
`wiki`, `kysely`, `@electric-sql/pglite`, `pg`, and an MCP SDK (`@modelcontextprotocol/sdk`).

```
.
├─ wiki/                         # engine (library dependency)
├─ wiki-server/                  # stream host: hosts wiki-mcp (§8)
└─ wiki-mcp/                     # ← THIS package
    ├─ package.json             # bin: wiki-mcp → dist/bin.js; deps above
    ├─ DESIGN.md
    └─ src/
        ├─ main.ts              # LIBRARY (side-effect-free): exports createWikiMcp/main/types; config → createWikiMcp({ …, logger }) → start (stdio|http). No shebang, no self-exec guard.
        ├─ bin.ts               # bin entry: #!/usr/bin/env node; runs main() over stdio; holds the self-exec guard (kept out of the library so a host bundling wiki-mcp from source can't auto-boot a rogue server)
        ├─ config.ts            # namespace, stream baseUrl, db (pglite|pg), timeouts, injected Logger (§9)
        ├─ engine.ts            # build the embedded IWiki (write side), hot-handle LRU, token surface
        ├─ readmodel/
        │   ├─ schema.ts        #   Kysely table types
        │   ├─ migrations/      #   Kysely migrations
        │   ├─ store.ts         #   Kysely + dialect (PGlite | pg) wiring
        │   ├─ project.ts       #   fold → serialize state → SQL (one txn/commit)
        │   └─ readmodel.ts     #   IReadModel: appliedToken / waitFor + typed queries
        ├─ models/
        │   ├─ registry.ts      #   live ModelRegistry: generation-counted, mutable page-type set (ADR-M6)
        │   └─ loader.ts        #   cache-busted dynamic import() of a model bundle (ADR-M6)
        ├─ tail/projection.ts   # catalog + per-workspace tailers driving project.ts
        └─ mcp/
            ├─ tools.ts         #   command catalog + queries → MCP tools (from argsSchema)
            ├─ resources.ts     #   wiki:// resources from the read model
            ├─ tokens.ts        #   per-session high-water token manager (§6.2)
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

## 11. Testing strategy

Tests target the **CQRS seam** and the **projection**, using an in-memory `DurableStreamTestServer`
([wiki/testing](../wiki/DESIGN.md)) and a **PGlite** instance (in-memory) for the read model.

- **Token semantics.** A write returns a token; a read with that token blocks until the projection
  applies it, then returns the new state; a read without a token may return stale. `waitFor` times out as
  specified.
- **Read-your-writes via MCP.** Through the MCP server: a write tool then a read tool (same session) always
  reflects the write — and `waitFor` is what makes it pass (prove by injecting projection lag).
- **Projection correctness.** For a scripted history, the serialized SQL equals the engine's folded
  `IWorkspaceState` (page/item/tree/link rows + JSONB); cross-workspace queries (`openQuestions`) match.
- **Resume.** Apply N commits → stop → restart → the projection resumes from `applied_version` (no re-fold)
  and converges; idempotent re-delivery causes no double-apply.
- **MCP surface.** Tool input schemas equal the engine's `argsSchema`; resources render the read model;
  illegal mutations surface the engine's structured error.
- **Dialect parity.** The projection suite runs on PGlite; a smoke subset runs on `pg` to guard dialect drift.

---

## 12. Future work

- **Hybrid per-type projection tables** (e.g. `open_questions`, full-text search) via registered projectors,
  beyond core+JSONB ([§5.2](#52-schema-core-tables--jsonb)).
- **Dynamic MCP tool lists** scoped to a page's currently-legal commands (push `tools/list_changed`).
- **Cross-workspace / cross-namespace** read models and dashboards (the read model makes these natural —
  [wiki/DESIGN.md §18](../wiki/DESIGN.md)).
- **Multiple read models** behind the same `IReadModel` (e.g. a search index, an analytics warehouse).
- **Token vectors** for multi-workspace transactions/reads, if a use case needs cross-aggregate consistency.

---

## 13. References

- Engine (embedded; the CQRS contract must land here): [`wiki/DESIGN.md`](../wiki/DESIGN.md) — §8 (event sourcing), §8.4 (live projection), §10 (API), §12 (LLM), §14 (errors).
- Stream host (hosts wiki-mcp): [`wiki-server/DESIGN.md`](../wiki-server/DESIGN.md).
- Schema layer (runtime-loaded page-type bundles): [`wiki-models/DESIGN.md`](../wiki-models/DESIGN.md) — the `ModelRegistry` loads these ([ADR-M6](#adr-m6--live-modelregistry-with-cache-busted-hot-reload-2026-06-02)).
- Kysely: <https://kysely.dev> · PGlite: <https://pglite.dev> · node-postgres: <https://node-postgres.com>
- Model Context Protocol: <https://modelcontextprotocol.io> · TS SDK: `@modelcontextprotocol/sdk`.
- CQRS / read models: Fowler, <https://martinfowler.com/bliki/CQRS.html>.

---

## Appendix A: Decision records

### ADR-M1 — CQRS with consistency tokens in the engine core (2026-06-02)

**Context.** Reads must be fast and durable without re-folding, yet an agent must be able to read its own
writes. Synchronously writing both stores couples the write path and spans two non-atomic stores.

**Decision.** Adopt **strict CQRS with eventual consistency** as a **core engine** contract: the write
model (commands → events) and read model (projections) are separate; **writes return a `ConsistencyToken`**
(the per-workspace `version`), and **reads optionally take a token and `waitFor` read-side catch-up**
before serving. The engine ships a default in-memory read model so it is CQRS-correct standalone; external
read models implement the same `IReadModel`.

**Consequences (a real, breaking engine change — not small).** `wiki/DESIGN.md` §8/§10 change on *both*
sides: **every** write return becomes `Committed<T>` (including the eight `Promise<void>` structural
commands, §3.2); and the engine's **single in-memory projection** ([wiki/DESIGN.md §8.4](../wiki/DESIGN.md))
splits into a write-side decide-aggregate **plus** a separate `IReadModel`, with the handle's currently
**synchronous, token-free** reads (`tree`/`page`/`toMarkdown` — [wiki/DESIGN.md §10.3](../wiki/DESIGN.md))
becoming token-aware (and likely `async`). A public pure `fold` must also be exported
([ADR-M3](#adr-m3--projection--engine-fold--serialize-to-sql-2026-06-02)). Writes never block on projection;
reads convert "eventual" to "after my write" on demand. This doc states the contract; the engine doc must
own it.

### ADR-M2 — SQL read model via Kysely; PGlite local, pg prod (2026-06-02)

**Decision.** Materialize the read model in **Postgres via Kysely**, on **PGlite** locally and **pg** in
production — identical Postgres SQL both places. Schema is **core relational tables + JSONB** for the
engine's pluggable type-specific data, so one schema serves all page types with no per-type code.

**Why.** Type-safe queries, dev/prod parity with zero local infra (embedded PGlite), and it completes the
**ElectricSQL** stack (Durable Streams + PGlite). JSONB keeps the schema type-agnostic while staying
queryable; typed per-type tables remain an opt-in optimization ([§5.2](#52-schema-core-tables--jsonb)).

**Consequences.** The read model is a rebuildable cache (drop + re-fold from the stream); a `fingerprint`
guards schema/page-type drift; Kysely migrations manage the schema.

### ADR-M3 — Projection = engine-fold + serialize-to-SQL (2026-06-02)

**Decision.** The projection applies each commit by **folding it with the engine's reducer** to an
`IWorkspaceState`, then **serializing that state into SQL** — rather than writing bespoke per-event SQL
handlers. The applied `version` advances in the **same transaction** as the rows. This requires the engine
to **export a public, pure `fold`** (today `foldWorkspace`/`applyWorkspace` are internal —
[wiki/DESIGN.md §16.1](../wiki/DESIGN.md)); that export is part of the coordinated engine changes.

**Why.** Reusing the fold guarantees the read model matches write-model semantics exactly (upcasting,
unknown-type policy, item/FSM effects) — the only thing we own is the state→rows mapping, which is
mechanical. Atomic apply keeps `appliedToken` honest. The cost (holding a fold to serialize) coincides with
keeping workspaces hydratable anyway ([§7](#7-staying-hydrated-the-runtime)).

**Consequences.** Per-type *rich query* tables, when wanted, are derived from the same serialized state by
opt-in projectors; the base layer needs no per-type code.

### ADR-M4 — The MCP server manages tokens for automatic read-your-writes (2026-06-02)

**Decision.** The MCP server keeps a **per-session high-water token per workspace**: write tools record the
token the engine returns; read tools/resources pass it as `consistentWith` automatically. Agents get
session read-your-writes + monotonic reads without handling tokens; the token is also returned in write
results for clients that want to thread it.

**Why.** It places the token bookkeeping at exactly the layer that has session context, keeping the engine
contract minimal and the agent experience "just works." Distinct sessions stay independent; the model stays
eventually consistent underneath.

**Consequences.** `waitFor` timeouts become retryable MCP errors (or a `stale: true` result); sessions are
the unit of consistency.

### ADR-M5 — wiki-mcp holds the logic; wiki-server hosts it (2026-06-02)

**Context.** Where does the engine live, and how thin should `wiki-server` stay?

**Decision.** `wiki-mcp` is the **module that holds the `wiki` engine** and all read-side logic (projection,
SQL read model, token management, MCP surface). `wiki-server` **hosts streams and hosts `wiki-mcp`** — a thin
wiring layer that delegates and does not implement engine logic itself. There are no deployment "modes": one
process hosts both.

**Why.** A single home for the engine + read model + MCP behavior (testable, replaceable) while `wiki-server`
stays small and comprehensible. The host *knowing* it has an engine is fine; *owning* the logic is not.

**Consequences.** `wiki-server` now transitively depends on the engine — a deliberate, accepted relaxation of
its original "imports neither `wiki` nor anything" stance ([wiki-server/DESIGN.md §1/§2](../wiki-server/DESIGN.md)),
which must be amended to record that it hosts `wiki-mcp`. `wiki-mcp` still imports only the engine (library)
+ the stream client — never `wiki-server` code.

### ADR-M6 — Live ModelRegistry with cache-busted hot-reload (2026-06-02)

**Context.** Page-type schema must be **swappable at runtime** so a model can be edited, rebuilt, and
reloaded into a running server (the local *edit → build → reload* loop, driven from a build pipeline — never
by an agent). Today `createWikiMcp` takes a fixed `pageTypes` set and builds an **immutable** `Registry`
once; the projection captures `registry`/`fingerprint` at construction and `EmbeddedEngine` binds the set
per hot handle. Page types are authored in **`wiki-models`** and loaded **by reference**, and the engine is
already version-aware (upcast-to-latest, [wiki-models ADR-W1](../wiki-models/DESIGN.md)).

**Decision.** Replace the construct-once `Registry` with a mutable, **generation-counted `ModelRegistry`**
that wraps the engine's immutable `Registry`. Bundles are loaded by **dynamic `import()` of a module
specifier**. Operations: `register(id, pageTypes)` (seed the host's page types as an in-memory `default`
bundle — no specifier, so it can't be reloaded), `load(id, specifier)`, `reload(id)` (a **hard replace**),
and `unregister(id)`. On any change the generation + `fingerprint` bump, and:

- `reload` re-imports the rebuilt bundle **under a cache-busting URL** — `import(fileURL + '?v=' + buildHash)`.
  Plain `import()` of the same path returns Node's **cached** module, so the query string is the whole trick
  that makes a code change actually take effect;
- the engine `Registry` is rebuilt from the new def set, `EmbeddedEngine.rebind` **rebuilds the engine** from
  the new page-type set — dropping every hot handle and **closing the old engine** — so new writes bind the
  new code, and the projection **reprojects** the read model: `ProjectionService.reproject` **resets every
  projected workspace's offset** (deletes its `projection_offsets` row) and **clears any halt**, then re-folds
  all from the stream with the new registry ([§5.3](#53-pglite-local-postgres-prod), [ADR-M3](#adr-m3--projection--engine-fold--serialize-to-sql-2026-06-02)).
  It never throws, so a workspace the new set still can't fold simply re-halts without aborting the rest.

Control is the **`wiki-server` control listener** — `GET/POST/DELETE /_server/models[/<id>]`
([wiki-server/DESIGN.md §8.5](../wiki-server/DESIGN.md)) — pipeline-driven, **not** an MCP tool. `wiki-server`
proxies the call into `wiki-mcp`'s `ModelRegistry` and stays schema-agnostic (the request names a specifier;
`wiki-mcp` does the import).

**Why.** The live part belongs at the layer that owns the engine + projection (`wiki-mcp`), so `wiki` and
`wiki-server` need **no change** and stay schema-agnostic. Reusing the fingerprint-rebuild path means reload
correctness rides ADR-M3's fold (upcasting, unknown-type halt) for free. Cache-busting is the minimal
mechanism that defeats the ESM module cache without a worker/`vm`.

**Consequences.** Cache-busting **leaks** the old module instances until GC — acceptable for a local/dev
reload loop; a long-running production hot-swap is a non-goal. A reload that drops a live type or lowers a
version **halts** affected workspaces loudly ([wiki-models §4](../wiki-models/DESIGN.md)). The bundle must
exist as built ESM **on disk at runtime** — it cannot be pre-bundled into the tsdown server image, so models
ship **alongside** the server, not inside it. Loading a bundle is arbitrary code execution (first-party
trusted). Per-namespace model selection + persistence stay reserved ([wiki/DESIGN.md §8](../wiki/DESIGN.md)).
Implementation note: the reset-all **reproject** IS wired — on a registry change the projection deletes every
workspace's `projection_offsets` row, clears halts, and re-folds all from the stream with the new registry
(`ProjectionService.reproject`). What remains a **future optimization** is the finer per-workspace
**compare-stored-vs-current** fingerprint diff that would re-fold only the workspaces whose `projection_offsets.fingerprint`
([§5.3](#53-pglite-local-postgres-prod)) actually changed; that column is still stamped on every apply.
