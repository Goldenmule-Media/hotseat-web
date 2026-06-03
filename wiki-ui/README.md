# wiki-ui

A read-only, **live-updating** browser for a `wiki-server`. It embeds the `wiki` engine
**in the browser**, points it at the server's Durable Stream, and tails that stream
directly — so the view re-projects the moment the wiki changes, with no polling and no
MCP hop.

This is a standalone Next.js (App Router) app — **not** a workspace member of the
monorepo. It consumes `wiki` and `wiki-models` as source via `transpilePackages`.

## How it works

- **Engine in the browser (client-side).** `lib/engine.ts` calls `createWiki({ stream, pageTypes })`
  once per tab. The engine talks to the Durable Stream over HTTP via `@durable-streams/client`.
- **Live updates.** `lib/live.tsx` opens each workspace, seeds from `handle.tree()`, then
  subscribes with `handle.subscribe(...)` (the engine's live primitive). Every committed
  event re-reads the tree and the open page's `toMarkdown()` and re-renders.
- **Rendering is the engine's.** Page bodies are the engine's deterministic Markdown,
  converted to HTML with `marked` (GFM → checkboxes preserved). Intra-wiki links whose
  href is a page id are rewritten to in-app routes; clicks are intercepted for SPA nav.
- **Navigation** is the page tree (`handle.tree()`) plus a child-pages strip from
  structured data — the engine renders child/reference entries as plain titles, so
  navigation is driven by ids, not by parsing the body.
- **Read-only.** The app only ever reads + subscribes; it issues no commands.

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

Open the app, pick a workspace, and edit it from any other client (e.g. the `wiki` MCP
tools) — the view updates live.

## Security

No auth. The app assumes **trusted-network** read access to the wiki-server, matching the
server's local-dev posture. Gated/authenticated access is out of scope for this version.
