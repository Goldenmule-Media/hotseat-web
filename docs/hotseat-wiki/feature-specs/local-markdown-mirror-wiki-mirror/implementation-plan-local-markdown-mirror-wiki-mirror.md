# Implementation plan — Local markdown mirror (wiki-mirror)

**Status:** draft

## Steps
- [x] Scaffold the `wiki-mirror` workspace package: package.json (`type:module`, tsdown build, tsx start; deps `wiki` + `wiki-models` + `@durable-streams/client`), tsconfig, and add it to the root `workspaces` array and the root typecheck/test/build scripts. Match wiki-mcp's conventions (`.js` relative imports, compiled-and-run-as-Node).
- [x] Move `MarkdownDiskProjector` from `wiki-mcp/src/tail/markdown-projection.ts` (and its tests) into `wiki-mirror` unchanged. Drop its `implements RenderSink` coupling — wiki-mirror calls `init`/`applyDelta`/`rebuild`/`fail` directly — and keep the on-disk manifest filename + format identical so existing mirrors self-heal instead of fully rebuilding.
- [x] Add the config layer: an `IMirrorConfig` loaded `flags → env (WIKI_MIRROR_*) → file (wiki-mirror.config.json) → defaults`. Validate every emitter `root` is absolute and that namespace + streamBaseUrl are present; fail fast with a clear message on bad config.
- [x] Add the model loader: dynamic `import()` of each `models` specifier into a `Registry` (reuse wiki-mcp's loader shape), keeping wiki-mirror schema-agnostic exactly like the server.
- [x] Implement the tail-and-render loop: per emitter entry, `createWiki` → `openWorkspace` → projector `init()` (self-heal) → back-fill to head → `subscribe`; on each commit `foldWorkspace` then branch on `isStructuralCommit` to `rebuild` (whole tree via `renderSearchDocs`) vs `applyDelta` (affected pages via `renderAffectedDocs`). One process, all configured workspaces.
- [x] Add the bin/entrypoint + a stdout `Logger`: fatal boot errors (bad config, unreachable stream, unknown model) exit nonzero; per-workspace render/write failures are best-effort and logged through the projector's `fail`, never killing the process.
- [x] Delete the embedded emitter from `wiki-mcp`: remove the `MarkdownDiskProjector` wiring, `EmitterRegistry`, `EmitterConfigStore`, the `_emitter-config` stream, and the configureEmitter/listEmitters/removeEmitter MCP tools — keep `ProjectionService` fan-out for the surviving SQL + search sinks. Drop the emitter-related `WIKI_MCP_*`/`WIKI_SERVER_*` config from wiki-server.
- [x] Wire local-dev orchestration: root `npm start` runs wiki-server (with models) AND wiki-mirror (pointed at 127.0.0.1:4437, configured for `docs/hotseat-wiki/`) together, so the repo keeps mirroring itself with one command.
- [x] Update docs: rewrite the CLAUDE.md 'Markdown disk mirrors' section (now a separate local process, not an MCP-configured registry) and the wiki architecture pages — wiki-mcp loses the emitter; add a `wiki-mirror` node alongside wiki-ui under the Architecture TOC's client tier.
- [x] Verify determinism end-to-end: render a fixture workspace through both the retired embedded path and the new mirror and assert byte-identical output (ties to the testing plan).

## Data models & interfaces
```ts
// wiki-mirror config — resolved flags → env (WIKI_MIRROR_*) → file → defaults
interface IEmitterEntry {
  workspaceId: string;   // ws:… — must exist on the server
  root: string;          // ABSOLUTE on-disk root for this workspace's mirror
}

interface IMirrorConfig {
  streamBaseUrl: string;       // e.g. http://127.0.0.1:4437  (WIKI_MIRROR_STREAM_BASE_URL)
  namespace: string;           // must match the server's WIKI_MCP_NAMESPACE
  models: string[];            // bundle specifiers to import() into the Registry
  emitters: IEmitterEntry[];   // one process tails every entry
  configPath?: string;         // resolved wiki-mirror.config.json path (diagnostics)
}
```

```ts
// wiki-mirror runtime: one long-lived process, one tail loop per emitter entry.
async function startMirror(cfg: IMirrorConfig, logger: Logger): Promise<void> {
  const pageTypes = await loadModels(cfg.models);        // dynamic import() → IPageType[]
  const registry  = new Registry(pageTypes);
  const wiki = createWiki({
    stream: { baseUrl: cfg.streamBaseUrl, namespace: cfg.namespace },
    pageTypes,
  });

  for (const e of cfg.emitters) {                         // N workspaces, one process
    const handle = await wiki.openWorkspace(e.workspaceId);
    const sink = new MarkdownDiskProjector(
      { enabled: true, root: e.root, workspaces: [e.workspaceId], layout: "tree" },
      logger,
    );
    await sink.init();                                    // manifest load + disk self-heal
    await backfillToHead(handle, registry, sink, e.workspaceId);
    await handle.subscribe((commit) =>
      applyCommit(handle, registry, sink, e.workspaceId, commit).catch((err) =>
        sink.fail(e.workspaceId, -1, err),                // best-effort; never kills the loop
      ),
    );
  }
}
```

## Open questions
_None._

## Resolved questions
1. **Re-fold full history on every commit (simple, O(history)/commit) or maintain incremental folded state via `applyWorkspace` (O(delta), more code)?** — _Full re-fold for v1 — simplest and correct; the projector already short-circuits unchanged files by content hash, so a re-fold that produces identical bytes writes nothing. Revisit with incremental `applyWorkspace` only if large workspaces show tail lag._
2. **Keep the projector's on-disk manifest filename and format byte-identical to the embedded emitter's?** — _Yes — keep the manifest filename + format byte-identical so existing `docs/hotseat-wiki/` mirrors self-heal and continue on the first wiki-mirror run rather than doing a full from-scratch rebuild._

## References
_None._

## Child pages
_None._
