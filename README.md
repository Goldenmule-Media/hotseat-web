# Structured Wiki

A TypeScript, **event-sourced, LLM-first structured wiki**. Pages aren't free text — they're **typed
documents** (a "feature brief", an "implementation plan") that change only through **named, typed
mutations** gated by a **finite-state machine**. A workspace is a graph of pages backed by a single
append-only [Durable Stream](https://durablestreams.com/concepts); history is the source of truth, and
every page renders **deterministically** to Markdown. Agents reach it over **MCP**.

- **Only legal actions.** A mutation is accepted only where the page's FSM allows it; illegal calls
  return a structured error naming the legal set, so an agent self-corrects.
- **Atomic within a workspace.** Structural changes (reparent, link, cross-page item moves) are
  all-or-nothing — one workspace is one event stream.
- **Read-your-writes.** Writes return a consistency token; the MCP layer threads it so an agent always
  reads its own prior writes.
- **Schema is pluggable and hot-reloadable.** Page types live in `wiki-models` and load into a running
  server by reference — the engine ships none baked in.
- **Renders back to disk (optional, per project).** A separate local process, **`wiki-mirror`**, tails a
  (possibly remote) server's Durable Stream and writes a workspace's deterministic Markdown into a local root,
  content-hashed so the git diff stays honest. It is configured by a local `wiki-mirror.config.json`
  (`workspaceId → absolute root`), per machine — never server state. The wiki stays the source of truth; each
  repo gets a faithful, always-current rendered copy.

### The packages

| Package | Role |
|---|---|
| `wiki` | The engine. Transport-free TypeScript API; event sourcing, FSM, CQRS, Markdown render. Ships **no** page types. |
| `wiki-models` | The schema layer — the only home for concrete page types (e.g. the `feature` bundle). Loaded at runtime. |
| `wiki-mcp` | Long-lived host: embeds the engine, maintains a SQL read model (PGlite/pg), exposes MCP tools + resources. |
| `wiki-server` | Thin process that runs the durable stream host **and** hosts `wiki-mcp` in one process. |
| `wiki-mirror` | Local Markdown mirror: tails a (possibly remote) server's stream and writes a workspace's deterministic Markdown to a local checkout — the headless, disk-writing sibling of `wiki-ui`. |
| `wiki-ui` | Standalone Next.js browser for a running server — embeds the engine client-side, tails the stream live, drives FSM transitions. **Not** a workspace member (own install/build). |

Architecture, boundaries, and conventions live in [`CLAUDE.md`](./CLAUDE.md); per-package design intent,
the content model, ADRs, and feature specs live in the wiki's own rendered mirror under
[`docs/hotseat-wiki/`](./docs/hotseat-wiki/).

---

## Quickstart: using the wiki

The wiki is driven over **MCP**. Boot the server (which loads your page-type schema), point an MCP client
at it, and create content with the wiki tools.

### 1. Start the server with a schema loaded

The server loads **no page types by default** — pass the `feature` bundle so `feature-brief` and friends
become creatable:

```bash
npm install                                                   # first time only
npm run start -w wiki-server -- --models wiki-models/feature
```

This boots three local listeners: the **stream host** (`:4437`), a **control API** (`:4438`), and the
**MCP endpoint** (`:4439/mcp`). Data persists under `./.wiki-data`. Confirm it's healthy and the schema
loaded:

```bash
curl localhost:4438/_server/health     # {"status":"ok"}
curl localhost:4438/_server/models      # bundle "feature" with its page types
```

### 2. Connect an MCP client

This repo already ships [`.mcp.json`](./.mcp.json) pointing the `wiki` MCP server at
`http://127.0.0.1:4439/mcp` — so **in Claude Code, the `wiki` tools light up as soon as the server is
running** (with a model loaded). Any other MCP client can connect to the same URL.

### 3. Build a feature with `/build-feature`

The bundled Claude Code skill drives a feature through the `feature` bundle's FSM end-to-end:

```
/build-feature <workspaceId> "<one-line intent>"
/build-feature <workspaceId> feature-brief:<id>      # drive an existing brief
```

(No workspace yet? One MCP call — `createWorkspace → { name: "My project" }` — returns the `workspaceId`.)

It seeds (or picks up) a feature-brief, grounds the implementation plan in the real repo, writes the
code, and **verifies** with real typecheck/tests plus a `/code-review` pass before flipping any FSM gate —
stopping at the human sign-off gates (`submitForReview` / `ship`). It delegates *what's next* to the
wiki's own `nextActions` rather than hardcoding the lifecycle, and it's branch/worktree-agnostic, so
several can run in parallel worktrees against the one shared wiki. Design and caveats:
[`.claude/skills/build-feature/README.md`](./.claude/skills/build-feature/README.md).

**Using it from other repos.** The skill also ships as the `hotseat` Claude Code plugin
([`plugins/hotseat/`](./plugins/hotseat/)), which bundles the `wiki` MCP wiring alongside it; this repo's
root is the plugin marketplace. In the other repo's Claude Code session:

```
/plugin marketplace add /Users/you/path/to/hotseat-web   # local checkout (repo root, not plugins/hotseat)
/plugin marketplace add Goldenmule-Media/hotseat-web     # …or straight from GitHub
/plugin install hotseat@hotseat
```

After editing the plugin here, run `/plugin marketplace update hotseat` in the consuming session to pick
up the changes. The plugin carries only the client side — it still needs a running `wiki-server` with the
`feature` model loaded (step 1; override the endpoint with `WIKI_MCP_URL` if not `127.0.0.1:4439`).
Details and prerequisites: [`plugins/hotseat/README.md`](./plugins/hotseat/README.md).

### Driving the tools by hand

The MCP tools mirror the engine — any MCP client can do what the skill does. A typical first flow
(tool → key arguments):

1. `createWorkspace` → `{ name: "My project" }` → returns a `workspaceId`.
2. `createPage` → `{ workspaceId, type: "feature-brief", title: "Dark mode" }` → returns a `pageId`.
   Creating a `feature-brief` **atomically creates its required children** (an implementation-plan,
   implementation-checklist, and testing-plan), pinned under it.
3. `describeMutations` → `{ workspaceId, pageId }` → lists the commands legal **right now** for that page
   plus each command's JSON-Schema args. This is how you discover what to call next.
4. `mutatePage` → `{ workspaceId, pageId, command: "setSummary", args: { text: "…" } }`, then e.g.
   `command: "askQuestion", args: { text: "Which themes?" }`. The engine validates args and the FSM;
   an illegal command comes back as a structured error with the legal set.
5. Read it back: `renderPage` → `{ workspaceId, pageId }` (Markdown; omit `pageId` for the whole tree),
   `tree` → `{ workspaceId }`, or `getPage`. Within a workspace: `search` (full-text over content), `attention`
   (items a model flags as awaiting a human), and `nextActions` (rolls a subtree's legal edges into do / blocked
   / humanGates / attention, so an agent self-directs). Cross-workspace is a system/discovery affordance only:
   `listWorkspaces` (ADR-30).

Because the FSM gates everything, the lifecycle is enforced for you — e.g. a feature-brief can't
`beginImplementation` until its plan has a step and its testing-plan a case, and can't `ship` until the
checklist is done, cases pass, and no questions are open.

### Embedding the engine as a library (alternative)

`wiki` is also a plain TypeScript library — `createWiki({ stream, pageTypes })` returns an `IWiki`; writes
return `Committed<T>`, reads are async and token-gated. It needs a Durable Streams server to point at (run
`wiki-server`, or use the in-process server from `wiki/testing` for embedded/test use). Page types come
from `wiki-models` (e.g. `import { featurePageTypes } from "wiki-models/feature"`). The API surface is
canonical in the types — start at `wiki/src/index.ts` (and `wiki/src/api.ts`); see
[`docs/hotseat-wiki/architecture/wiki/`](./docs/hotseat-wiki/architecture/wiki/) for the prose walkthrough.

---

## Developer quickstart

### Prerequisites

- **Node ≥ 20** and npm (the repo uses npm workspaces). No database or other service to install —
  storage is file-backed Durable Streams and the read model is embedded PGlite.

### Install & verify

```bash
npm install        # installs all workspaces
npm run typecheck  # strict tsc across every package — this is the gate (there is no linter)
npm run test       # vitest across every package (in-memory stream server + PGlite; no external infra)
npm run build      # wiki → tsc; wiki-models/wiki-mcp/wiki-server → tsdown bundles
```

### The dev loop

| Task | Command |
|---|---|
| Typecheck / test / build one package | append `-w <pkg>`, e.g. `npm run test -w wiki-mcp` |
| Run one test file | `npm run test -w wiki -- test/guard.test.ts` (`--` forwards to `vitest run`) |
| Run one test by name | `npm run test -w wiki -- -t "rejects a stale append"` |
| Watch a package's tests | `npm run test:watch -w <pkg>` (wiki · wiki-mcp · wiki-server) |
| Run the server (tsx, no build) | `npm run start -w wiki-server -- --models wiki-models/feature` |

`<pkg>` ∈ `wiki` · `wiki-models` · `wiki-mcp` · `wiki-server`.

### Editing the schema: the reload loop

Page types live in `wiki-models/src/feature/`. The intended loop is **edit → build → reload** into a
running server (no restart):

```bash
npm run build -w wiki-models
curl -X POST localhost:4438/_server/models \
  -H 'content-type: application/json' \
  -d '{"id":"feature","specifier":"wiki-models/feature"}'
```

The server re-imports the rebuilt bundle, rebinds the engine, and reprojects the read model.

### Conventions that bite (full list in `CLAUDE.md`)

- **Determinism:** no `Date.now()` / `Math.random()` / `new Date()` in reducers (`apply`), deciders
  (`produces`), or renderers (`render`) — use the injected `now()` / `newId()`. Equal state must render
  byte-identical Markdown.
- **Import extensions depend on the package:** `wiki` and `wiki-models` are consumed as TS *source* →
  **extensionless** relative imports; `wiki-mcp` and `wiki-server` compile and run under Node → relative
  imports use **`.js`**.
- **tsdown bundling:** `deps.alwaysBundle` must use a **regex** (`/^wiki(\/|$)/`), not the bare string
  `"wiki"`, or subpath exports (`wiki/registry`, `wiki/authoring`) stay external and Node fails at runtime.

### Where to read more

- [`CLAUDE.md`](./CLAUDE.md) — architecture, package boundaries, and the full conventions list.
- [`.claude/skills/build-feature/README.md`](./.claude/skills/build-feature/README.md) — the bundled
  `/build-feature` Claude Code skill (agentic, FSM-gated feature builds).
- [`docs/hotseat-wiki/architecture/`](./docs/hotseat-wiki/architecture/) — per-package design intent + the engine's
  content model. [`docs/hotseat-wiki/decision-records/`](./docs/hotseat-wiki/decision-records/) — every ADR.
  [`docs/hotseat-wiki/feature-specs/`](./docs/hotseat-wiki/feature-specs/) — feature/product documents.
