# wiki-mirror

**Status:** current

## Kind
package

## Summary
The **local Markdown mirror** — a headless, schema-agnostic stream client and the disk-writing sibling of `wiki-ui`. It tails a (possibly remote) `wiki-server`'s Durable Stream, folds + renders each commit with the embedded `wiki` engine, and writes the deterministic Markdown tree to a local checkout. Imports `wiki` (+ `wiki-models`) only — never `wiki-mcp`/`wiki-server`; tails read-only and authors nothing back.

## Purpose
Decouple Markdown emission from the host so `wiki-server` can be deployed remotely. The emitter's roots are absolute filesystem paths meaningful only on the machine that owns the disk, so emission — and its `workspaceId → root` config — is inherently a local concern. `wiki-mirror` moves it out of `wiki-mcp` into a separate local process: one tail loop per configured workspace, with the on-disk `MarkdownDiskProjector` (relocated unchanged from wiki-mcp) reconciling the tree on each commit.

## Design notes
Tail loop (WorkspaceMirror): open a handle → subscribe → on each commit re-fold the full history (foldWorkspace) and re-render (renderSearchDocs), then rebuild the projector. v1 always rebuilds; the projector content-hashes every page, so an unchanged re-render writes nothing — a full re-fold per commit is the simplest correct design (incremental applyWorkspace deltas are a later optimization if large workspaces lag).

Determinism is the safety net: render is pure, so folding the same events through the same wiki-models yields byte-identical Markdown to what the retired embedded emitter wrote. Only WHERE the rendering runs changed — host → local client.

## Components
_No components._

## Dependencies
- **depends-on** → [wiki](architecture:mpznj2kb-0009-pvqw9d) — Tails the stream and folds/renders via wiki's PUBLIC surface only (createWiki, foldWorkspace, renderSearchDocs, Registry) — no wiki-mcp internals.
- **depends-on** → [wiki-models](architecture:mpznj3vk-000b-mqwd0h) — Loads page-type bundles by reference (dynamic import) at runtime — schema-agnostic, exactly like the server.

## Code references
- function `startMirror` in `wiki-mirror/src/main.ts`
- class `WorkspaceMirror` in `wiki-mirror/src/mirror.ts`
- class `MarkdownDiskProjector` in `wiki-mirror/src/markdown-projection.ts`
- function `resolveConfig` in `wiki-mirror/src/config.ts`
- function `loadModels` in `wiki-mirror/src/models.ts`

## Data model
`IMirrorConfig { streamBaseUrl, namespace, models[], emitters: { workspaceId, root }[] }`. On disk: `<root>/<workspace-slug>/<page tree>` (a folder + `index.md` per page-with-children; archived pages at `.archived/<type>--<id>.md`), plus a content-hash manifest `.wiki-md-manifest.json` (applied version + path/hash per file) that drives no-churn writes and the boot self-heal.

## Usage
Compiled and run as Node (built with `tsdown`; relative imports use `.js`). Config resolves `flags → env WIKI_MIRROR_* → file → defaults`; the file is the user-level `~/.wiki/wiki-mirror.config.json` by default — ONE per-machine file shared by every project's mirror, not a copy per checkout (point elsewhere with `--config` / `WIKI_MIRROR_CONFIG`). It carries `streamBaseUrl`, `namespace`, `models` (bundle specifiers dynamically imported into the engine `Registry`), and `emitters` (workspaceId → absolute root). It is read once at startup; restart to reconfigure. Run with the server via root `npm start` (concurrently), or standalone via `npm run start -w wiki-mirror`. A `waitForStreamHost` retry tolerates the server still booting; a permanently-unreachable host is a fatal nonzero exit.

## Invariants & constraints
- Imports `wiki` (+ `wiki-models`) only — never `wiki-mcp`/`wiki-server` internals; a parallel engine consumer like wiki-ui.
- Tails read-only: appends no events to any workspace stream.
- Emitter config (workspaceId → absolute root) is per-machine local state in a file, never stored on the shared server.
- Single emission path: Markdown is written here and nowhere else (the embedded emitter was removed from wiki-mcp/wiki-server).
- Compiled and run as Node: relative imports use `.js` extensions (unlike the source-consumed wiki / wiki-models).

## Synced commit
_None._
