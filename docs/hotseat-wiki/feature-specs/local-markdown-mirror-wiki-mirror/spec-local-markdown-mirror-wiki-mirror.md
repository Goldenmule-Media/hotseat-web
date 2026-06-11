# Spec — Local markdown mirror (wiki-mirror)

**Status:** drafting

## Overview
Markdown emission is inherently a local concern: it writes a specific developer's checkout at a specific absolute path. That was invisible while wiki-server always ran on the same machine as the checkout; making the server deployable surfaces it. The resolution is to treat emission as a stream client, not a host responsibility — the headless analog of wiki-ui — and to move it, and its per-machine config, out of the shared server and onto the local machine. This spec records the decided design; the parent brief holds the deliberation trail.

## Design
## Topology: host vs. client

Today wiki-server boots the stream host plus wiki-mcp, and wiki-mcp fans every commit out to three render-sinks — the SQL read model, the search index, and the MarkdownDiskProjector — with the disk sink driven by the `_emitter-config` stream and the configureEmitter MCP tools. After this change wiki-server/wiki-mcp keep only the SQL and search sinks and can run on shared, remote infrastructure; a separate wiki-mirror process runs on the developer's machine, tails the (possibly remote) workspace stream, and writes Markdown to a local root.

## wiki-mirror is a parallel engine consumer

Like wiki-ui's SharedWorker, wiki-mirror runs `createWiki` pointed at the server's stream and tails it directly: open a workspace handle, subscribe, and on each commit fold + render + write. The differences from wiki-ui are that it writes to disk instead of a screen, runs headless in Node (so it can `import()` wiki-models at runtime, which the browser cannot), and authors nothing back. It reaches the engine only through `wiki`'s public surface. The per-commit loop, in sketch:

```ts
// wiki-mirror — one tail loop per configured workspace (sketch)
const wiki     = createWiki({ stream: { baseUrl, namespace }, pageTypes });
const registry = new Registry(pageTypes);
const handle   = await wiki.openWorkspace(workspaceId);

const sink = new MarkdownDiskProjector(
  { enabled: true, root, workspaces: [workspaceId], layout: "tree" },
  logger,
);
await sink.init();                       // load manifest + self-heal disk, then back-fill

await handle.subscribe(async (commit) => {
  const events = await handle.history();
  const state  = foldWorkspace(events, registry);
  const docs   = renderSearchDocs(state, registry);
  isStructuralCommit(commit.events)
    ? await sink.rebuild(workspaceId, state.version, docs, state)
    : await sink.applyDelta(workspaceId, state.version, docs, removed(commit), state);
});
```

## What relocates, what is deleted

MarkdownDiskProjector moves wiki-mcp → wiki-mirror unchanged — it is already a pure RenderSink depending only on `wiki`'s public types and Node `fs`. EmitterRegistry, EmitterConfigStore, the `_emitter-config` stream, and the configureEmitter/listEmitters/removeEmitter MCP tools are deleted. wiki-mcp's ProjectionService keeps its fan-out for the surviving SQL + search sinks. The mirror does not import ProjectionService; it runs its own slim single-sink tail loop on the public primitives (foldWorkspace, renderSearchDocs, renderAffectedDocs, isStructuralCommit), and the projector's on-disk manifest gives it per-workspace version tracking and self-heal for free.

## Configuration is local-machine state

A wiki-mirror.config.json maps workspaceId → absolute root (alongside the stream baseUrl, namespace, and models), resolved flags → env (WIKI_MIRROR_*) → file → defaults. Because two developers tailing the same server have different checkouts at different paths, this mapping is inherently per-machine — which is exactly why it cannot live on the server. One process tails every configured workspace in the namespace. Config is read at startup; reconfiguring requires a restart (workspace tailing is live; config reload is deferred).

```json
{
  "streamBaseUrl": "http://127.0.0.1:4437",
  "namespace": "hotseat",
  "models": ["wiki-models/feature"],
  "emitters": [
    { "workspaceId": "ws:…", "root": "/abs/path/to/docs/hotseat-wiki" }
  ]
}
```

## Preserved behaviors and determinism

The projector's atomic temp+rename writes, content-hashing (honest git diffs), boot self-heal back-fill (rebuilding a wiped output dir from the workspace head), archive-moves-to-`.archived`-never-deletes, and single-writer-per-root lock all carry over verbatim — they were always disk-side, never host-side. Determinism is the safety net: because render is pure and the mirror folds the same events through the same wiki-models, the bytes it writes are identical to what the embedded emitter wrote. Only where the rendering runs changes.

## Operability and local development

The mirror owns its own logger to stdout; per-workspace render/write failures are best-effort and logged (mirroring MarkdownDiskProjector.fail), while a fatal boot error (bad config, unreachable stream) exits nonzero. A health/control endpoint is deferred. Root `npm start` runs wiki-server (with models) and wiki-mirror (pointed at 127.0.0.1:4437, configured for docs/hotseat-wiki/) together, so the dev loop stays one command and this repo keeps mirroring itself.

## Deferred: git operations

A future wiki-mirror could stage/commit/push the mirror after a quiet period. Out of scope here; the design simply does not preclude it — the mirror already owns the checkout path, the natural seam for git work.

## Decisions
Emitter configuration lives only in a local file owned by the mirror; the server-side `_emitter-config` stream and its MCP tools are retired. Where should the emitter configuration (workspace → on-disk root) live once wiki-server can be deployed remotely?

The embedded emitter is removed from wiki-mcp/wiki-server; Markdown emission has exactly one home — wiki-mirror — with no all-local fallback. Should the embedded markdown emitter be kept for the all-local dev case, or retired so emission has a single home?

Scope is markdown mirroring only; git operations are deferred, with the checkout-ownership seam left open for them. Is the scope a focused markdown mirror, or a general host for local-only concerns?

The new package is wiki-mirror, a workspace-member Node/tsdown package depending on wiki + wiki-models, a parallel engine consumer that never imports wiki-mcp/wiki-server. What are the new package's name, shape, and dependency boundary?

No new engine API is required — the mirror runs a slim single-sink tail loop on wiki's existing public exports (foldWorkspace/renderSearchDocs/Registry) and reuses MarkdownDiskProjector unchanged. Does tailing a remote stream and rendering to disk require any new public API on the wiki engine?

Config is read at startup and changed by restart; workspace tailing is live but config reload is deferred. How does the mirror pick up configuration changes — live reload, file-watch, or restart?

One mirror process tails all configured workspaces in a namespace. Does one mirror process handle many workspaces, or is it one process per workspace?

Config is a wiki-mirror.config.json resolved flags → env (WIKI_MIRROR_*) → file → defaults. What is the local config file's format and resolution order?

The mirror owns its own stdout logger; per-workspace failures are best-effort, fatal boot errors exit nonzero, and a health endpoint is deferred. Where do mirror failures and operability surface, now that emission is out of the server's logs/health?

## References
_None._

## Child pages
_None._
