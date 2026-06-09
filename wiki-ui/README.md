# wiki-ui

A **live-updating** browser for a `wiki-server`. It embeds the `wiki` engine **in the
browser**, points it at the server's Durable Stream, and tails that stream directly — so
the view re-projects the moment the wiki changes, with no polling and no MCP hop. Beyond
reading, it can **drive a page's FSM transitions interactively**: click a transition edge
in the status graph and the browser-side engine issues the command.

This is a standalone Next.js (App Router) app — **not** a workspace member of the
monorepo (its own `node_modules`/lockfile; the root `npm run *` scripts don't touch it).
It consumes `wiki` and `wiki-models` as source via `transpilePackages`.

> **Related docs.** wiki-ui has a typed node in the project's self-documenting wiki:
> [`docs/hotseat-wiki/architecture/wiki-ui.md`](../docs/hotseat-wiki/architecture/wiki-ui.md) (a rendered
> mirror — the wiki itself is the source of truth). See also the architecture map
> [`docs/hotseat-wiki/architecture/`](../docs/hotseat-wiki/architecture/) — in particular the engine it
> embeds, [`wiki/`](../docs/hotseat-wiki/architecture/wiki/), and the schema it imports,
> [`wiki-models/`](../docs/hotseat-wiki/architecture/wiki-models/) — the repo-root
> [`CLAUDE.md`](../CLAUDE.md), and the planned
> [shared-engine-in-a-SharedWorker](../docs/hotseat-wiki/feature-specs/shared-engine-in-a-sharedworker-one-engine-pglite-across-all-tabs/index.md)
> feature spec.

## How it works

- **Engine in the browser (client-side).** `lib/engine.ts` calls
  `createWiki({ stream, pageTypes, search })` once per tab — `getWiki()` returns `null`
  during Next's server pre-render, so the stream is never opened there. The engine talks to
  the Durable Stream over HTTP via `@durable-streams/client`.
- **Live updates.** `lib/live.tsx` opens each workspace, seeds from `handle.tree()`, then
  subscribes with `handle.subscribe(...)` (the engine's live primitive). Every committed
  event re-reads the tree and the open page's `toMarkdown()` and re-renders.
- **Interactive FSM transitions (the write path).** `usePageMutator` (`lib/live.tsx`) is the
  single place the engine handle's `mutate` is called. Click a transition edge leaving the
  current state in the status graph (`components/FsmGraph.tsx`), confirm or fill a
  schema-generated form (`components/TransitionForm.tsx` + `lib/schema-form.ts` — a
  confirm-and-run step today, since the current models' transitions take no args, growing
  fields the moment one declares them), and the browser-side engine commits the command.
  It reuses the read side's handle — no second engine, no server endpoint — and the
  resulting commit flows back through the live tail, so the graph repaints itself. The UI
  only ever issues the model's FSM-gated commands; it authors no free text. Available vs.
  blocked edges (with the blocking reason) come from `describeMutations`.
- **Rendering is the engine's.** Page bodies are the engine's deterministic Markdown,
  converted to HTML with `marked` (GFM → checkboxes preserved). Intra-wiki links whose
  href is a page id are rewritten to in-app routes; clicks are intercepted for SPA nav.
- **Navigation** is the page tree (`handle.tree()`) plus a child-pages strip from
  structured data — the engine renders child/reference entries as plain titles, so
  navigation is driven by ids, not by parsing the body.
- **Full-text search.** The engine's search index runs **in the browser**, backed by a
  PGlite database persisted to IndexedDB (`lib/search-db.ts`, wired via `createWiki`'s
  `search` option). Opening a workspace folds *and* indexes it, so `handle.search(...)`
  returns real ranked hits (`components/SearchLauncher.tsx` → `components/SearchModal.tsx`).

## Configure

Copy `.env.example` → `.env.local` and point it at your server. Because the engine runs
client-side, these are `NEXT_PUBLIC_*`:

| Var | Default | Meaning |
|---|---|---|
| `NEXT_PUBLIC_WIKI_STREAM_BASE_URL` | `http://127.0.0.1:4437` | wiki-server Durable Stream host |
| `NEXT_PUBLIC_WIKI_NAMESPACE` | `default` | stream namespace (server's `WIKI_MCP_NAMESPACE`) |

### Models (build-time)

Unlike the server, a browser app cannot `import()` an arbitrary model bundle at runtime,
so the schema is resolved at **build time**. `lib/models.ts` static-imports
`wiki-models/feature`; to support more page types, add their static imports there and
rebuild. A page whose type is not in the bundle renders a graceful "unknown type" notice.

## Run

From the repo root, start a server with a model loaded:

```bash
npm run start -w wiki-server -- --models wiki-models/feature
```

Then, in this directory:

```bash
npm install      # first time only (standalone node_modules)
npm run dev      # http://localhost:3000
```

Open the app and pick a workspace. Edits from any other client (e.g. the `wiki` MCP
tools) stream in live — and you can drive a page's FSM transitions right in the browser.

## Security

No auth. The app assumes **trusted-network** access to the wiki-server, matching the
server's local-dev posture — note it can **write** (issue FSM transitions), not only read.
Gated/authenticated access is out of scope for this version.
