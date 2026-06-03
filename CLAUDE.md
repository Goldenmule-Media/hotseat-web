# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An **event-sourced, CQRS, LLM-first structured wiki**. Pages are typed documents that change only
through named, typed, FSM-gated mutations (never free text); a workspace is a graph of pages that maps
to one append-only Durable Stream and is the unit of atomic consistency; everything renders
deterministically to Markdown. It's a 4-package npm-workspaces monorepo (ESM, TypeScript, Node ≥20).

Each package has a long-form `DESIGN.md` with Architecture Decision Records (ADRs) in an appendix — **the
authoritative source of truth for intent.** `wiki/BUILD_NOTES.md` is the engine's implementation guide
(OCC, command bus, event model). Read the relevant `DESIGN.md` before changing a package's behavior.

## Commands

Run from the repo root unless noted. There is **no linter/formatter** — `typecheck` (strict `tsc`) is the gate.

| Task | Command |
|---|---|
| Typecheck all | `npm run typecheck` |
| Test all | `npm run test` |
| Build all | `npm run build` |
| One package | append `-w <pkg>`, e.g. `npm run test -w wiki-mcp` |
| One test file | `npm run test -w wiki -- test/guard.test.ts` (the `--` forwards to `vitest run`) |
| One test by name | `npm run test -w wiki -- -t "rejects a stale append"` |
| Watch | `npm run test:watch -w <pkg>` (wiki · wiki-mcp · wiki-server; not wiki-models) |
| Run the server | `npm run start -w wiki-server` (tsx; see "Running locally") |

`<pkg>` ∈ `wiki` · `wiki-models` · `wiki-mcp` · `wiki-server`. Don't run `npm install` (already done).

## Architecture: four packages, strict layering

Dependency arrows point downward; **the import boundaries are load-bearing — do not cross them.**

```
wiki-server   runs @durable-streams/server (durable stream host) AND hosts wiki-mcp in-process.
   │          Thin WIRING only — implements no engine logic. Imports @durable-streams/server +
   │          wiki-mcp. MUST NOT import `wiki` directly (only transitively via wiki-mcp).
   ▼
wiki-mcp      Long-lived host: embeds the engine (write side, hot LRU of workspace handles),
   │          maintains a durable SQL read model (Kysely → PGlite local / pg prod) via a
   │          projection tailer, and exposes MCP (tools + resources). Owns the live ModelRegistry
   │          (runtime hot-reload of schema, ADR-M6). Imports `wiki`'s PUBLIC surface only.
   ▼
wiki          The engine. Transport-free: exposes ONLY a TypeScript API (`createWiki`,
              `IWorkspaceHandle`, `IPageView`) — no HTTP, no CLI. Consumes a Durable Streams
              server over HTTP for storage via @durable-streams/client. Ships ZERO concrete
              page types — schema-agnostic.

wiki-models   The schema layer — the ONLY home for concrete page types (e.g. the `feature` bundle:
              feature-brief / implementation-plan / implementation-checklist / testing-plan).
              Depends ONLY on `wiki`'s authoring API; never imports wiki-mcp/wiki-server. Built to
              standalone ESM and loaded by reference (dynamic import) at runtime — not baked in.
```

Keeping the engine and stream host schema-agnostic, with all page types in `wiki-models` loaded at
runtime, is a deliberate, central design choice (`wiki-models/DESIGN.md`, wiki-mcp ADR-M6). When adding
behavior, put it in the layer that owns it: engine mechanics → `wiki`; page types/schema → `wiki-models`;
read model / projection / MCP / token logic → `wiki-mcp`; process wiring → `wiki-server`.

`wiki-cli/` is an **empty placeholder** (no `package.json`, not a workspace) — a deferred future package.

## Core engine model (`wiki`)

- **Workspace = aggregate = one Durable Stream.** A command's events are written as ONE atomic
  array-message ("commit"); reads flatten array-messages back to a flat event list.
- **Guarded mutations.** A page type (`definePageType`) declares typed fields, item types, a status
  **FSM** (`t(from, event, to)`), commands (Zod-validated args via `zodSchema`), a pure `apply` reducer,
  and a deterministic `render`. A mutation is legal **iff** the FSM declares the transition; structural
  rules (acyclic tree, unique sibling title, link target exists) are invariants checked in handlers.
- **CQRS with consistency tokens.** Every write returns `Committed<T>` (value + opaque token = the
  committed head `version`). Reads are async and token-gated: pass `consistentWith` a write's token to
  read-your-writes (the read waits via `IReadModel.waitFor`), or omit it for eventually-consistent state.
  The engine ships a default `InMemoryReadModel`; `wiki-mcp` supplies an external SQL `IReadModel` over
  the same seam.
- **OCC** via `Stream-Seq` (strict-greater → HTTP 409 → rebase-and-retry); **version** is the 0-based
  per-workspace event count and drives fold order. **Schema evolution** is upcast-to-latest: events carry
  `schemaVersion`, the fold chains a type's `upcasters` up to its current `version`, one head `apply` runs.
- Public surface is re-exported by `wiki/src/index.ts`; subpaths: `wiki/authoring`, `wiki/registry`,
  `wiki/testing`. Internal machinery (command bus, EventLog, structure/render) is not exported.

## Conventions & gotchas

- **Determinism (hard rule).** No `Date.now()`, `Math.random()`, or `new Date()` in reducers (`apply`),
  deciders (`produces`), or renderers (`render`). Time/ids arrive via injected `now()` / `newId()`. Equal
  state must render byte-identical Markdown.
- **Import-extension style differs by package — match the file you're in:**
  - `wiki` and `wiki-models` are consumed as TS **source** (`moduleResolution: "Bundler"`) → relative
    imports are **extensionless** (`from "../api"`).
  - `wiki-mcp` and `wiki-server` are **compiled and run as Node** (`bin` / `tsx`) → relative imports use
    **`.js`** extensions (`from "./config.js"`). Bare package specifiers are always extensionless.
- **Builds differ:** `wiki` builds with `tsc` (emits `dist/`); `wiki-models` / `wiki-mcp` / `wiki-server`
  build with **`tsdown`** (Rolldown), bundling the workspace source in and keeping npm deps external.
  In every tsdown config, `deps.alwaysBundle` **must be a regex** (`/^wiki(\/|$)/`) so subpath exports like
  `wiki/registry` and `wiki/authoring` are bundled too — a bare-string `"wiki"` leaves them external and
  Node crashes at runtime loading the engine's extensionless TS source (`ERR_MODULE_NOT_FOUND`).
- **Naming:** `I`-prefixed interfaces; events PascalCase past-tense (`QuestionAnswered`); commands
  camelCase imperative (`addConstraint`); a page's id prefix is its type (`feature-brief:<id>`).
- **Dev-only dependency cycle:** `wiki-models` depends on `wiki` (runtime); `wiki` **devDepends** on
  `wiki-models` because the engine's own tests import the real `feature` bundle from `wiki-models/feature`.
- **Tests** live in each package's `test/` (vitest), and use in-memory infra: `wiki/testing`
  (`createTestWiki`, `startTestServer`, `wikiOn`) spins up an in-process `DurableStreamTestServer`;
  `wiki-mcp` uses in-memory PGlite. `wiki-models` has no tests (`vitest run --passWithNoTests`).
- `wiki/BUILD_NOTES.md` is accurate for engine internals but **predates the schema move** — its
  `wiki/src/pages/feature/` paths are stale; those page types now live in `wiki-models/src/feature/`.

## Running locally

`npm run start -w wiki-server` boots three listeners in one process: the **stream host** (`:4437`), a
**control listener** (`:4438` — `/_server/health`, `/_server/info`, `/_server/logs`, `/_server/models`),
and the embedded **wiki-mcp** streamable-HTTP MCP endpoint (`:4439/mcp`). File storage defaults to
`./.wiki-data`.

- **The server loads NO page types by default.** Provide the schema explicitly:
  `npm run start -w wiki-server -- --models wiki-models/feature` (or `WIKI_SERVER_MODELS=wiki-models/feature`).
  At runtime you can also `POST /_server/models {"id":"feature","specifier":"wiki-models/feature"}`, or
  list with `GET localhost:4438/_server/models`.
- **Config** is `flags → env → defaults`. `wiki-server` reads `WIKI_SERVER_*` (host/port/storage/data-dir/
  control-port/mcp-port/models) **and** resolves the embedded `wiki-mcp`'s `WIKI_MCP_*` (namespace,
  `WIKI_MCP_DB` = `pglite`|`pg`, `WIKI_MCP_PG_URL`, data-dir), overriding the MCP's stream URL to its own.
- `.mcp.json` wires this Claude Code session's `wiki` MCP server to `http://127.0.0.1:4439/mcp` — i.e. a
  locally-running `wiki-server`. The `wiki` MCP tools won't work unless that server is up (with a model loaded).
