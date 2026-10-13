# wiki-mirror

**Status:** current

## Kind
package

## Summary
The **local Markdown mirror** — a headless, schema-agnostic stream client and the disk-writing sibling of `wiki-ui`. It tails a (possibly remote) `wiki-server`'s Durable Stream, folds + renders each commit with the embedded `wiki` engine, and writes the deterministic Markdown tree to a local checkout. Imports `wiki` (+ `wiki-models`) only — never `wiki-mcp`/`wiki-server`; tails read-only and authors nothing back.

## Purpose
Decouple Markdown emission from the host so `wiki-server` can be deployed remotely. The emitter's roots are absolute filesystem paths meaningful only on the machine that owns the disk, so emission and its `workspaceId → root` config are inherently a local concern. An entry may also name a `subtreeRootId`, so one workspace can feed several repos with one part each. `wiki-mirror` moves emission out of `wiki-mcp` into a separate local process. It runs one tail loop per configured entry, and the on-disk `MarkdownDiskProjector` reconciles the entry's root on each commit.

## Design notes
Tail loop (WorkspaceMirror): open a handle → subscribe → on each commit re-fold the full history (foldWorkspace) and re-render (renderSearchDocs), then rebuild the projector. v1 always rebuilds; the projector content-hashes every page, so an unchanged re-render writes nothing — a full re-fold per commit is the simplest correct design (incremental applyWorkspace deltas are a later optimization if large workspaces lag).

Determinism is the safety net: render is pure, so folding the same events through the same wiki-models yields byte-identical Markdown to what the retired embedded emitter wrote. Only WHERE the rendering runs changed — host → local client.

**Supervision, not a boot loop.** `EmitterSupervisor` wraps each configured emitter, so a workspace that cannot be opened (a typo, a 403, an expired grant, an unwritable root) stays LISTED with its reason and retries with backoff instead of being dropped from the process. Dropping it made a broken emitter indistinguishable from an unconfigured one, and left it dead until someone noticed the Markdown had stopped moving. A disconnected emitter still reports the version its manifest last recorded, so a client can see how far behind it is. A start attempt is bounded by a timeout, because the stream client retries transport failures forever: `openWorkspace` against an unreachable host never rejects, it hangs, and an emitter that hangs looks exactly like one that works.

**Liveness has to be probed from outside the engine.** `handle.history()` is served from the in-memory projection with no I/O, and the Durable Streams client exposes no connection state, retries transport failures forever, and dies PERMANENTLY on a 4xx, which is the shape of an expired grant. `ServerProbe` therefore issues a cheap HEAD against each workspace stream on a timer, which answers three questions at once: whether the host is reachable, whether we are still authorized (401/403), and whether the server's stream offset has moved ahead of what we applied for longer than the stuck threshold. Recovery is a full engine rebuild (`MirrorService.restart`) because the refreshing auth header caches the grant it first read, so no layer below that can pick up a new sign-in. The health listener stays bound across the rebuild, so a client polling it never sees the port move.

**The health endpoint answers 200 even when everything is broken.** A non-2xx would tell every client that no mirror is running here, which is the one thing it must never say while it is running. Failures live in the body: an `auth` block (mode, user, expiry, expired), a `server` block (reachable, unauthorized, last error), and per workspace `connected`, `lastReconcileError`, `nextRetryAt`, and `stuck`. `connected` is narrowed at this layer rather than in the tail loop, because only here do we know whether the HOST is reachable and whether the tail is keeping pace. A subscription handle proves neither.

**Subtree emitters.** An entry with a `subtreeRootId` mirrors that page and its descendants. A page is in scope when its parent chain reaches the subtree root. When the chain breaks on a page the fold skipped, membership is unknown and the page's file is frozen in place, exactly like any other unreliable path. The tail loop renders only the pages in scope, so the rest of the workspace costs no render work. Several entries on one workspace keep their own supervisor, status, backoff, and manifest, but they share the engine's single handle and therefore one stream tail. The probe sends one HEAD per workspace and judges its pace by the least recently reconciled connected entry. A subtree root that is missing from the fold makes the reconcile throw, so nothing is written or swept and the error surfaces as `lastReconcileError` with a retry. A mirror never empties a repo because its root page went away. Moving a page out of a subtree removes its file from that root, because the page now belongs to whichever entry covers its new place. Archiving still never deletes a file.

**The root is the mirror.** A mirror used to write `<root>/<workspace-slug>/`, which tied the folder to the workspace name and moved the whole tree whenever the workspace was renamed. Now the entry's root holds the tree directly. The manifest records a layout version and the entry's scope. When either differs from the running config, the next reconcile is a full rebuild that writes the new layout and sweeps every file the old manifest owned. That is how an existing mirror moves out of its old slug folder, and how changing an entry's subtree on the same root replaces one subtree's files with another's.

## Components
- [wiki-mirror-menubar](architecture:mt7dkh1l-00e4-rwjefz)

## Dependencies
- **depends-on** → [wiki](architecture:mpznj2kb-0009-pvqw9d) — Tails the stream and folds/renders via wiki's PUBLIC surface only (createWiki, foldWorkspace, renderSearchDocs, Registry) — no wiki-mcp internals.
- **depends-on** → [wiki-models](architecture:mpznj3vk-000b-mqwd0h) — Loads page-type bundles by reference (dynamic import) at runtime — schema-agnostic, exactly like the server.

## Code references
- function `startMirror` in `wiki-mirror/src/main.ts`
- class `WorkspaceMirror` in `wiki-mirror/src/mirror.ts`
- class `MarkdownDiskProjector` in `wiki-mirror/src/markdown-projection.ts`
- function `resolveConfig` in `wiki-mirror/src/config.ts`
- function `loadModels` in `wiki-mirror/src/models.ts`
- class `MirrorService` in `wiki-mirror/src/main.ts`
- class `EmitterSupervisor` in `wiki-mirror/src/supervisor.ts`
- class `ServerProbe` in `wiki-mirror/src/server-probe.ts`
- function `startHealthServer` in `wiki-mirror/src/health.ts`
- `wiki-mirror/scripts/install-agent.sh`
- `wiki-mirror/scripts/build-portable.mjs`
- function `pageRelPath` in `wiki-mirror/src/markdown-projection.ts`
- function `inSubtree` in `wiki-mirror/src/markdown-projection.ts`

## Data model
`IMirrorConfig { streamBaseUrl, namespace, models[], modelsDir?, emitters: { workspaceId, root, subtreeRootId? }[], healthHost, healthPort, probeIntervalMs?, token?, configPath }`. The root is the mirror. A whole-workspace entry writes its top-level pages directly into `<root>/`. A subtree entry writes its page to `<root>/index.md` and nests the descendants beneath it. Below that, a page with children becomes a folder with an `index.md`. Archived pages live at `<root>/.archived/<type>--<id>.md` and attachments at `<root>/.assets/<sha256><ext>`. The manifest `<root>/.wiki-md-manifest.json` records, per workspace, the applied version, the path and hash of every owned file, the page-to-path map, each page's assets, the layout version, and the scope (the subtree root id, or null). It drives no-churn writes and the boot self-heal, and it is rewritten only when an owned file changes.

The health endpoint publishes `MirrorStatusResponse { status, uptimeMs, pid, namespace, streamBaseUrl, configPath, auth, server, workspaces[] }`. Each entry carries `workspaceId`, `root` (the entry's unique identity, since a workspace may appear several times), `subtreeRootId`, `subtreeTitle`, `name`, `appliedVersion`, `lastReconcileAt`, `lastReconcileError`, `connected`, and the probe's `stuck`, `behindSince`, `nextRetryAt`, and `attempts`. `GET /_mirror/workspaces` returns the namespace catalog. Each catalog entry carries `mirroredRoot` (the root of a whole-workspace entry, or null) and `mirrors` (every `{ root, subtreeRootId }` entry for that workspace). `GET /_mirror/workspaces/{id}/tree` returns `{ pages: [{ id, title, type, depth, archived }] }` to depth 3, with depth 0 for a top-level page, and answers 503 when the workspace cannot be read. A configuration UI picks workspaces and subtree pages from these two routes. No token value ever appears in any payload.

## Usage
Compiled and run as Node (built with `tsdown`, relative imports use `.js`). Config resolves `flags → env WIKI_MIRROR_* → file → defaults`. The file is the user-level `~/.wiki/wiki-mirror.config.json` by default, ONE per-machine file shared by every project's mirror rather than a copy per checkout (point elsewhere with `--config` / `WIKI_MIRROR_CONFIG`). It carries `streamBaseUrl`, `namespace`, `models` (bundle specifiers dynamically imported into the engine `Registry`), `modelsDir` (a directory of bundles discovered one level deep, the portable alternative to bare specifiers), `emitters` (a workspaceId and an optional subtreeRootId, mapped to an absolute root), `probeIntervalMs`, and an optional `token`. One more entry can come from `--workspace` and `--root`, optionally with `--subtree <pageId>`. By convention a repo mirrors to `<repo>/wiki-mirror/`. This repo is the exception and mirrors to `docs/hotseat-wiki/`, because `wiki-mirror/` is the package itself. The config is read once at startup, so restart to reconfigure.

It normally runs as a **launchd user agent** installed by `wiki-mirror/scripts/install-agent.sh`: started at login, restarted on a crash, logging to `~/Library/Logs/wiki-mirror/`, and driven by `--status` / `--restart` / `--logs` / `--uninstall`. Three runtimes: `--mode source` runs the checkout through `tsx` and always reflects the working tree, `--mode dist` runs the built `dist/bin.js`, and `--mode portable` runs the self-contained artifact from `npm run bundle -w wiki-mirror` (one `.mjs` importing nothing but `node:` builtins, plus the built model bundles as loose files) on any Mac that has Node and no `node_modules`. The root `npm start` no longer launches a mirror, because a second one exiting under `concurrently -k` would take the server down with it. `npm run start:mirror` still runs one in a terminal for debugging.

An unreachable host at boot is no longer fatal. The service starts anyway, says why over its health endpoint, and begins mirroring on its own when the host returns. A health port already held by another mirror exits 0, a parking condition rather than a crash, so a supervisor does not respawn into the same collision.

Auth against a gated server, by precedence (`resolveAuthorization` in `wiki/auth-client`): an explicit static token (`--token` → `WIKI_MIRROR_TOKEN` → config-file `token`) rides every request verbatim, else a stored OAuth grant (`wiki-mirror login` runs the browser sign-in once and persists a self-refreshing grant at `~/.wiki/credentials.json`, shared with `migrate-workspace`) becomes a per-request refreshing header function, else unauthenticated.

## Invariants & constraints
- Imports `wiki` (+ `wiki-models`) only — never `wiki-mcp`/`wiki-server` internals; a parallel engine consumer like wiki-ui.
- Tails read-only: appends no events to any workspace stream.
- Single emission path: Markdown is written here and nowhere else (the embedded emitter was removed from wiki-mcp/wiki-server).
- Compiled and run as Node: relative imports use `.js` extensions (unlike the source-consumed wiki / wiki-models).
- A configured emitter always appears in the health payload, even when it never started: an omitted entry is indistinguishable from an unconfigured one, and every field a client checks (notably `lastReconcileError`) is present rather than undefined.
- One mirror process per health port: a second instance finding the port taken exits 0 with a clear message rather than crashing or running a second writer against the same roots.
- One writer per root. Config rejects two entries on the same root and any root nested inside another, because a mirror sweeps every file it owns but no longer expects.
- A missing subtree root never sweeps. The reconcile fails, the files and the manifest stay as they are, and the entry reports the error until the page returns.
- Emitter config (a workspaceId and an optional subtreeRootId, mapped to an absolute root) is per-machine local state in a file, never stored on the shared server. The same workspace or subtree may be mirrored into several roots, so the root alone identifies an entry.

## Synced commit
5b70600
