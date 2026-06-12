# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An **event-sourced, CQRS, LLM-first structured wiki**. Pages are typed documents that change only
through named, typed, FSM-gated mutations (never free text); a workspace is a graph of pages that maps
to one append-only Durable Stream and is the unit of atomic consistency; everything renders
deterministically to Markdown. An **npm-workspaces monorepo of five packages** (`wiki` · `wiki-models` ·
`wiki-mcp` · `wiki-server` · `wiki-mirror`) forms the engine + host + local Markdown mirror; a sixth
directory, **`wiki-ui`**, is a standalone Next.js browser for a running server — its own install/build,
**not** a workspace member. ESM, TypeScript, Node ≥20.

**The codebase documents itself.** Design intent lives in the wiki and is mirrored to [`docs/hotseat-wiki/`](docs/hotseat-wiki/):
per-package architecture plus the cross-cutting [Content model](docs/hotseat-wiki/architecture/content-model.md)
page (sections, field-kinds, the section-operation reducer, render) in
[`docs/hotseat-wiki/architecture/`](docs/hotseat-wiki/architecture/); every Architecture Decision Record in
[`docs/hotseat-wiki/decision-records/`](docs/hotseat-wiki/decision-records/); feature/product documents in
[`docs/hotseat-wiki/feature-specs/`](docs/hotseat-wiki/feature-specs/). **The wiki is the source of truth; `docs/hotseat-wiki/**` is
its always-current rendered mirror** (the local `wiki-mirror` process back-fills it — see "Running locally"). This
file is the **boundary map + the gotchas**; the depth is in those pages. **Before changing a package's
behavior, read its architecture page and the ADRs it links.**

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
| Run server + mirror | `npm start` (root — boots the server **and** the local `wiki-mirror` via `concurrently`) |

`<pkg>` ∈ `wiki` · `wiki-models` · `wiki-mcp` · `wiki-server` · `wiki-mirror`. **`wiki-ui` is NOT covered by the root
scripts** — it has its own `node_modules`/lockfile and `next build`/`vitest`; run `npm install` / `npm run
typecheck` / `npm run build` / `npm run dev` **inside `wiki-ui/`** (see "wiki-ui (the browser)" below).
Don't run `npm install` at the root (already done).

## Architecture: five packages + a browser UI

Dependency arrows point downward; **the import boundaries are load-bearing — do not cross them.**

```
wiki-server   runs @durable-streams/server (durable stream host) AND hosts wiki-mcp in-process.
   │          Thin WIRING only — implements no engine logic. Imports @durable-streams/server +
   │          wiki-mcp. MUST NOT import `wiki` directly (only transitively via wiki-mcp).
   ▼
wiki-mcp      Long-lived host: embeds the engine (write side, hot LRU of workspace handles),
   │          maintains a durable SQL read model (Kysely → PGlite local / pg prod) via a
   │          projection tailer, and exposes MCP (tools + resources). Owns the live ModelRegistry
   │          (runtime hot-reload of schema). Imports `wiki`'s PUBLIC surface only.
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

**Per-package design intent (read before changing behavior):**
[wiki](docs/hotseat-wiki/architecture/wiki/) ·
[wiki-models](docs/hotseat-wiki/architecture/wiki-models/) ·
[wiki-mcp](docs/hotseat-wiki/architecture/wiki-mcp/) ·
[wiki-server](docs/hotseat-wiki/architecture/wiki-server.md) ·
[wiki-mirror](docs/hotseat-wiki/architecture/wiki-mirror.md) ·
[Content model](docs/hotseat-wiki/architecture/content-model.md).

**`wiki-ui`** — a standalone **Next.js (App Router) app**, *not* a workspace member (own lockfile,
`transpilePackages`). A **live-updating** browser for a running `wiki-server`: it **embeds the engine in the
browser** (imports `wiki` + `wiki-models` as source, runs a PGlite search index client-side), points it at
the server's Durable Stream, and **tails that stream directly** — re-projecting on every commit, no MCP hop,
no polling. A parallel consumer of the engine: it reads live **and** drives the model's **FSM transitions**
interactively (`handle.mutate` through the same handle — no second engine), but authors no free text.
Canonical doc: [`wiki-ui/README.md`](wiki-ui/README.md).

**`wiki-mirror`** — a workspace-member Node package (tsdown/tsx, like `wiki-mcp`), the **local Markdown
mirror** and the headless, disk-writing sibling of `wiki-ui`. It tails a (possibly remote) `wiki-server`'s
Durable Stream, folds + renders each commit with the embedded engine, and writes the deterministic Markdown
tree to a local checkout — a parallel consumer of `wiki` (+ `wiki-models`) that imports **no**
`wiki-mcp`/`wiki-server` internals and authors nothing back. Its `workspaceId → root` map is a per-machine
local config file (`wiki-mirror.config.json`), never server state. This is what keeps `docs/hotseat-wiki/`
current. Canonical doc: the *Local markdown mirror* feature spec
([`docs/hotseat-wiki/feature-specs/`](docs/hotseat-wiki/feature-specs/)).

Keeping the engine and stream host **schema-agnostic**, with all page types in `wiki-models` loaded at
runtime, is a deliberate, central design choice (see the *Live ModelRegistry with cache-busted hot-reload*
and *Declarative page types* ADRs). When adding behavior, put it in the layer that owns it: engine
mechanics → `wiki`; page types/schema → `wiki-models`; read model / projection / MCP / token logic →
`wiki-mcp`; process wiring → `wiki-server`; local disk mirror → `wiki-mirror`; browser presentation → `wiki-ui`.

## Core engine model (`wiki`) — orientation

The load-bearing mental model; full detail in [`architecture/wiki/`](docs/hotseat-wiki/architecture/wiki/), the
[Content model](docs/hotseat-wiki/architecture/content-model.md) page, and the ADRs.

- **Workspace = aggregate = one Durable Stream.** A command's events are written as ONE atomic
  array-message ("commit"); reads flatten array-messages back to a flat event list.
- **Guarded mutations.** A page type (`definePageType`) declares typed sections/fields, item types, a status
  **FSM** (`t(from, event, to)`), commands (Zod-validated args via `zodSchema`), a pure `apply` reducer,
  and a deterministic `render`. A mutation is legal **iff** the FSM declares the transition; structural
  rules (acyclic tree, unique sibling title, link target exists) are invariants checked in handlers.
  Field completeness is declarative too: a field's `requiredIn: [statuses]` (the dual of a section's
  `mutableIn`) makes the ENGINE refuse entering — or blanking content while in — those statuses until the
  field is authored, naming the missing `section.field` paths; models never hand-roll completeness gates.
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

- **Comments: short and rare.** Most code needs none. When one is warranted (a constraint the
  code can't express), keep it to a line or two — never essay-length, never restating what the
  code does.
- **Determinism (hard rule).** No `Date.now()`, `Math.random()`, or `new Date()` in reducers (`apply`),
  deciders (`produces`), or renderers (`render`). Time/ids arrive via injected `now()` / `newId()`. Equal
  state must render byte-identical Markdown.
- **Import-extension style differs by package — match the file you're in:**
  - `wiki` and `wiki-models` are consumed as TS **source** (`moduleResolution: "Bundler"`) → relative
    imports are **extensionless** (`from "../api"`). `wiki-ui` consumes them the same way (Next
    `transpilePackages` resolves extensionless `.ts`).
  - `wiki-mcp`, `wiki-server`, and `wiki-mirror` are **compiled and run as Node** (`bin` / `tsx`) → relative
    imports use **`.js`** extensions (`from "./config.js"`). Bare package specifiers are always extensionless.
- **Builds differ:** `wiki` builds with `tsc` (emits `dist/`); `wiki-models` / `wiki-mcp` / `wiki-server` /
  `wiki-mirror` build with **`tsdown`** (Rolldown), bundling the workspace source in and keeping npm deps external
  (`wiki-ui` builds with `next build`). In every tsdown config, `deps.alwaysBundle` **must be a regex**
  (`/^wiki(\/|$)/`) so subpath exports like `wiki/registry` and `wiki/authoring` are bundled too — a
  bare-string `"wiki"` leaves them external and Node crashes at runtime loading the engine's extensionless
  TS source (`ERR_MODULE_NOT_FOUND`).
- **Naming:** `I`-prefixed interfaces; events PascalCase past-tense (`QuestionAnswered`); commands
  camelCase imperative (`addConstraint`); a page's id prefix is its type (`feature-brief:<id>`).
- **Dev-only dependency cycle:** `wiki-models` depends on `wiki` (runtime); `wiki` **devDepends** on
  `wiki-models` because the engine's own tests import the real `feature` bundle from `wiki-models/feature`.
- **Tests** live in each package's `test/` (vitest), and use in-memory infra: `wiki/testing`
  (`createTestWiki`, `startTestServer`, `wikiOn`) spins up an in-process `DurableStreamTestServer`;
  `wiki-mcp` uses in-memory PGlite; `wiki-mirror` drives the public engine via `wiki/testing` (a writer +
  a mirror client on one server). `wiki-models` has no tests (`vitest run --passWithNoTests`).

## Running locally

`npm run start -w wiki-server` boots three listeners in one process: the **stream host** (`:4437`), a
**control listener** (`:4438` — `/_server/health`, `/_server/info`, `/_server/logs`, `/_server/models`),
and the embedded **wiki-mcp** streamable-HTTP MCP endpoint (`:4439/mcp`). File storage defaults to
`./.wiki-data`. Config is `flags → env → defaults` (a cwd `.env` seeds unset env keys first — see
`.env.example`): `wiki-server` reads `WIKI_SERVER_*` (host/port/storage/
data-dir/control-port/mcp-port/models/models-dir/auth) **and** resolves the embedded `wiki-mcp`'s `WIKI_MCP_*`
(namespace, `WIKI_MCP_DB` = `pglite`|`pg`, `WIKI_MCP_PG_URL`, data-dir), overriding the MCP's stream URL to
its own. Full surface: [`architecture/wiki-server.md`](docs/hotseat-wiki/architecture/wiki-server.md).

- **GitHub auth (`--auth github` / `WIKI_SERVER_AUTH=github`; default `none`).** An **auth gateway** takes
  over `:4437` (the stream host moves to an internal loopback port), serving GitHub OAuth at `/auth/*` and
  reverse-proxying ONLY workspace/catalog stream paths behind a signed bearer session (deny-by-default);
  the MCP endpoint demands the same token, and the control listener becomes **loopback-only** (its model
  loads/logs are operator surface, not user surface). Set `WIKI_SERVER_AUTH_USERS` to allowlist who may
  sign in at all. **Workspace = project:** the CREATOR becomes owner (ledger at
  `<dataDir>/auth/access.json`); the owner manages members (`/auth/workspaces/{id}/members`, or the
  wiki-ui Members panel); non-members get 403s + filtered listings; pre-auth workspaces stay open to any
  signed-in user until `/claim`ed. Needs a GitHub OAuth App (callback
  `{WIKI_SERVER_PUBLIC_URL}/auth/github/callback`) — copy `.env.example` → `.env` at the repo root (read
  via npm's `INIT_CWD`). Per-client credentials: wiki-ui signs in interactively; MCP clients and CLIs sign
  in via the gateway's **OAuth 2.1 façade** (discovery on the 401's `resource_metadata`, dynamic client
  registration, PKCE; all tokens are stateless signed blobs) — Claude Code authenticates from `/mcp` with
  NO header in `.mcp.json` and refreshes itself, and `wiki-mirror login` stores a self-refreshing grant at
  `~/.wiki/credentials.json` shared by `wiki-mirror` and `migrate-workspace`. A manually copied token
  (wiki-ui account menu) still works and takes precedence: `.mcp.json` `"headers": {"Authorization":
  "Bearer <token>"}`; `wiki-mirror` takes `WIKI_MIRROR_TOKEN`. The engine seam is `IStreamConfig.headers`
  (per-request function values, so refreshed tokens take effect live).

- **The server loads NO page types by default.** Provide the schema explicitly:
  `npm run start -w wiki-server -- --models wiki-models/feature` (or `WIKI_SERVER_MODELS=wiki-models/feature`).
  At runtime you can also `POST /_server/models {"id":"feature","specifier":"wiki-models/feature"}`, or list
  with `GET localhost:4438/_server/models`. **Load every bundle at once:** `npm start` (root) boots the
  server with `--models-dir ../wiki-models/src` **and** the local `wiki-mirror` process (via `concurrently`;
  config `~/.wiki/wiki-mirror.config.json`). Under `--models-dir`, each `src/<bundle>/` → a bundle,
  id = dir name; also accepts a built `dist` tree, skipping non-bundle chunks with a warning. An explicit
  `--models` overrides a discovered bundle of the same id (and still hard-fails if it can't load).
- **Markdown disk mirrors — the `wiki-mirror` process.** A project mirrors a workspace's deterministic
  Markdown to its own checkout by running **`wiki-mirror`**, a SEPARATE local process (not the server): it
  tails the (possibly remote) server's Durable Stream, folds + renders each commit with the embedded engine,
  and writes the tree to a local root — the disk-writing sibling of `wiki-ui`, built on `wiki`'s public
  surface alone (no `wiki-mcp`/`wiki-server` internals; tails read-only, authors nothing back). Config is a
  **user-level local file** (`~/.wiki/wiki-mirror.config.json` by default — ONE per machine, shared by every
  project; override with `--config` / `WIKI_MIRROR_CONFIG`; resolved `flags → env WIKI_MIRROR_* → file →
  defaults`) mapping each `workspaceId →` **absolute** root (one tail loop each) — per-machine state, never
  stored on the shared server or a checkout. It is read once at startup; **restart to reconfigure**. Layout `<root>/<workspace>/<page tree>`
  (folder + `index.md` per page-with-children), content-hashed so the git diff stays honest, atomic
  temp+rename writes, an on-disk manifest (`.wiki-md-manifest.json`), and a boot back-fill that self-heals a
  wiped output dir. **Archiving never deletes a mirrored file:** archiving a page (or the whole workspace)
  moves its file to a stable id-named `<workspace>/.archived/<type>--<id>.md`, and unarchiving moves it back
  to the tree; only a hard page delete removes a file. **This repo's own
  [`docs/hotseat-wiki/`](docs/hotseat-wiki/) is one such mirror**, driven by the `wiki-mirror.config.json` at
  the repo root (run it with the server via `npm start`, or standalone via `npm run start -w wiki-mirror`).
  Local-only trust (roots written verbatim, no sandboxing); single-writer per root (documented, not enforced).
- **`.mcp.json`** wires this Claude Code session's `wiki` MCP server to `http://127.0.0.1:4439/mcp` — i.e. a
  locally-running `wiki-server`. The `wiki` MCP tools won't work unless that server is up **with a model loaded**.
- **Self-direction (don't ask "what next?").** The wiki is self-directing via two model-declared classifiers
  the engine surfaces generically: per-edge `agency` (`"agent"` = a forward edge to drive autonomously;
  `"human"` = a sign-off/decision gate) on FSM transitions, and a per-instance `awaitsHuman` predicate on
  element types. After a write, use the echoed `next` / the `nextActions` tool to drive the agent edges to
  completion (a `blocked` edge's unmet reason names the content to author); stop only at `agency:"human"`
  gates and `awaitsHuman` items (the `attention` tool lists them). Both classifiers live in `wiki-models`;
  `wiki`/`wiki-mcp` stay schema-agnostic.

### wiki-ui (the browser)

`wiki-ui` is independent of the workspace scripts — install and run it from **inside `wiki-ui/`**:

```bash
npm run start -w wiki-server -- --models wiki-models/feature   # a server (from the repo root)
cd wiki-ui && npm install && npm run dev                       # http://localhost:3000
```

Point it at the server with `NEXT_PUBLIC_WIKI_STREAM_BASE_URL` (default `http://127.0.0.1:4437`) and
`NEXT_PUBLIC_WIKI_NAMESPACE` (must match the server's `WIKI_MCP_NAMESPACE`); because the engine runs
client-side these are `NEXT_PUBLIC_*` (copy `.env.example` → `.env.local`). Unlike the server, a browser
can't `import()` a bundle at runtime, so **schema is resolved at build time**: `lib/models.ts`
static-imports `wiki-models/feature` — add page types there and rebuild (an unknown type renders a graceful
notice). Beyond reading, the UI drives **FSM transitions** interactively (click an edge in the status graph
→ confirm / fill args → the browser-side engine issues the command); it authors no free text. Edits from any
other client (e.g. the `wiki` MCP tools) also stream in live. Details: [`wiki-ui/README.md`](wiki-ui/README.md).
