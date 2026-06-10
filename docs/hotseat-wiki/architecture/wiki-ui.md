# wiki-ui

**Status:** current

## Kind
package

## Summary
A standalone **Next.js (App Router) app** — a live-updating **browser client** for a running `wiki-server`. It **embeds the `wiki` engine in the browser** (one `IWiki` per tab), points it at the server's Durable Stream, and tails that stream directly via `@durable-streams/client` — no MCP hop, no server-side fold. It both **reads** (folds + renders pages live, with the engine's full-text search index running in-browser on PGlite) and **writes** (drives the model's FSM transitions interactively). **Not** an npm-workspace member: own lockfile/`node_modules`, built with `next build`, consuming `wiki` + `wiki-models` as TypeScript **source** via `transpilePackages`.

## Purpose
Give people a faithful, zero-lag window onto a workspace — and a safe way to advance it — without re-implementing any engine logic in the UI. The same engine the host runs is folded client-side, so every view is the engine's own deterministic projection (not a parallel renderer), and the only mutations the UI can make are the model's FSM-gated commands. It is the human-facing complement to the MCP surface: agents drive the wiki over MCP; people watch it update live and take transition steps in the browser.

## Design notes
_No design notes._

## Components
_No components._

## Dependencies
- **depends-on** → [wiki](architecture:mpznj2kb-0009-pvqw9d) — Embeds the engine in the browser (`createWiki`), folds + subscribes to the workspace stream, and issues FSM transitions via `handle.mutate`. Imports `wiki` as TS source (`transpilePackages`).
- **depends-on** → [wiki-models](architecture:mpznj3vk-000b-mqwd0h) — Static-imports the page-type bundle (`wiki-models/feature`) at build time so the browser can fold + render typed pages; unknown types degrade gracefully.

## Code references
- function `getWiki` in `wiki-ui/lib/engine.ts`
- function `usePageMutator` in `wiki-ui/lib/live.tsx`
- `wiki-ui/lib/models.ts`
- `wiki-ui/lib/search-db.ts`
- `wiki-ui/components/FsmGraph.tsx`
- `wiki-ui/next.config.mjs`

## Data model
Holds no durable state of its own — the wiki-server's Durable Stream is the source of truth. Per tab it keeps only engine-derived state: the folded page tree + open-page projection (refreshed off the live tail) and a browser-local **PGlite** database (persisted to IndexedDB) backing the engine's full-text search index. The renderable page-type set is fixed at build time by `lib/models.ts`'s static imports (a browser cannot `import()` an arbitrary bundle at runtime); an unrecognized type degrades to a graceful "unknown type" notice rather than failing the view.

## Usage
Run from **inside `wiki-ui/`** (the root `npm run *` scripts do not touch it): `npm install` then `npm run dev` serves `http://localhost:3000`. Point it at a server with `NEXT_PUBLIC_WIKI_STREAM_BASE_URL` (default `http://127.0.0.1:4437`) and `NEXT_PUBLIC_WIKI_NAMESPACE` (must match the server's `WIKI_MCP_NAMESPACE`); these are `NEXT_PUBLIC_*` because the engine runs in the browser. Start a `wiki-server` with a model loaded, open a workspace, and edits from any client (e.g. the `wiki` MCP tools) appear live. Page types are resolved at **build time** — `lib/models.ts` static-imports `wiki-models/feature`; add types there and rebuild.

## Invariants & constraints
- Standalone Next.js app — NOT an npm-workspace member: its own lockfile/`node_modules`, not built or tested by the root scripts. Consumes `wiki` + `wiki-models` as TS **source** via `transpilePackages` (extensionless imports, like the engine itself).
- The engine runs **client-side only** — one `IWiki` singleton per tab. It is never instantiated during Next server pre-render (`getWiki()` returns `null` on the server); opening a stream there is forbidden.
- Talks to the Durable Stream **directly** via `@durable-streams/client` — no MCP hop and no server-side fold. The runtime link to `wiki-server` is over the wire only (not a code import).
- Page-type schema is resolved at **build time** (`lib/models.ts` static-imports `wiki-models/feature`), not loaded by reference at runtime the way the server does.
- Live updates come from the engine's own subscription tail (`handle.subscribe`): every commit re-folds the tree + open page — no polling. Rendering is the engine's deterministic Markdown (→ `marked`); intra-wiki id links are rewritten to in-app routes.
- The single write path is **interactive FSM transitions** (`usePageMutator` → `handle.mutate`), reusing the read side's handle — no second engine. The UI can only issue the model's FSM-gated commands; it authors no free text.
- Trusted-network posture: no auth, matching the server's local-dev stance. Gated/authenticated access is out of scope for this version.

## Synced commit
38cc341
