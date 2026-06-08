# Implementation plan

**Status:** ready

## Steps
1. Promote `@durable-streams/client` from a devDependency to a runtime `dependency` in `wiki-mcp/package.json` (the new `EmitterConfigStore` opens its own client). Confirm the tsdown config keeps it external (npm dep, not bundled) so the engine-bundle rules are unaffected.
2. Add `EmitterConfigStore` (new file `wiki-mcp/src/emitters/config-store.ts`). Mirror the engine catalog handle pattern (`wiki/src/stores/event-log.ts`): a lazily, idempotently created `DurableStream` handle for `${streamBaseUrl}/${namespace}/_emitter-config`; `append(JSON.stringify(event))`; `readAll()` via `stream({url, offset: START_OFFSET, live: false})` then `.flat()`. Events: `EmitterConfigured {emitterId, workspaceId, root, archive, at}` and `EmitterRemoved {emitterId, at}`. Provide `appendConfigured()`, `appendRemoved()`, `readAll()`, a pure `fold(events)` returning the last-writer-wins live set keyed by `emitterId`, and a live `subscribe()` (`stream({url, live: true})`) the registry tails.
3. Extend `ProjectionService` (`wiki-mcp/src/tail/projection.ts`): add `removeRenderSink(sink: RenderSink): void` that splices the sink out of the private `renderSinks` array by identity; factor a single-sink `reconcileSink(sink, source)` out of the existing `reconcileSinks(source)` (unfold each workspace once, bring just that sink to head), and re-express `reconcileSinks` as a loop over `renderSinks` calling it. This lets a freshly-registered emitter back-fill without a full boot reconcile.
4. Add an emitter→projector adapter: a pure `toMarkdownConfig(emitter)` mapping a live emitter `{emitterId, workspaceId, root, archive}` to the existing `IMarkdownProjectionConfig` (`{enabled: true, root, workspaces: [workspaceId], layout: "tree", archive}`). `MarkdownDiskProjector` itself is unchanged — it is now constructed per emitter at runtime instead of once from boot config.
5. Add `EmitterRegistry` (new file `wiki-mcp/src/emitters/registry.ts`), holding a `Map<emitterId, {emitter, sink}>`. `start()`: `store.readAll()` → `fold` → for each live emitter build a `MarkdownDiskProjector` from `toMarkdownConfig`, `init()` it, `projection.addRenderSink(sink)`, then `projection.reconcileSink(sink, source)` to back-fill its root from the workspace stream head. Then tail `store.subscribe()`: on `EmitterConfigured` add — or replace (removeRenderSink old, add new) — the sink and reconcile it; on `EmitterRemoved` `projection.removeRenderSink(sink)` and drop the map entry. Removal leaves already-mirrored files on disk (per brief constraint).
6. Add MCP tools `configureEmitter`, `listEmitters`, `removeEmitter` in `wiki-mcp/src/mcp/tools.ts`, each a `WikiTool` descriptor following `archiveWorkspaceTool` and registered in `wikiTools()`. `configureEmitter({emitterId, workspaceId, root, archive?})` validates the workspace exists then `store.appendConfigured(...)`; `removeEmitter({emitterId})` → `store.appendRemoved(...)`; `listEmitters()` → `fold(store.readAll())` returns the live set. Add the `EmitterConfigStore` to `WikiToolContext` so handlers can reach it. Writes take effect via the registry's live tail — no restart.
7. Remove the static Markdown surface. In `wiki-mcp/src/config.ts`: delete `resolveMarkdown()` and the `markdown?: IMarkdownProjectionConfig` field on `WikiMcpConfig`, plus the `--md` / `--md-root` / `--md-workspaces` / `--md-archive` flags and `WIKI_MCP_MD*` env reads. In `wiki-mcp/src/main.ts`: delete the boot-time `MarkdownDiskProjector` wiring (the addRenderSink block) and instead construct + `start()` the `EmitterRegistry` after the live tail starts. Keep `MarkdownDiskProjector` and `IMarkdownProjectionConfig` (now internal-only).
8. wiki-server: drop the `--md*` / `WIKI_MCP_MD*` documentation and any explicit markdown config surface from `wiki-server/src` (it forwards argv/env wholesale, so this is mostly removing the documented flags and the resolved-config passthrough that no longer exists).
9. Docs: replace the "Markdown-disk mirror (off by default)" section in `CLAUDE.md` (and README) with the runtime emitter API — `configureEmitter` / `listEmitters` / `removeEmitter` over MCP — and a note that emitter config is event-sourced on the per-namespace `_emitter-config` durable stream, replayed on boot. Scrub the deleted `--md*` / `WIKI_MCP_MD*` references.
10. Gate: run `npm run typecheck` and `npm run test` (wiki-mcp + wiki-server). The detailed test matrix (store fold last-writer-wins, removeRenderSink + single-sink reconcile, registry boot-replay + live add/remove back-fill, MCP tool round-trip) is authored in the sibling Testing plan page.

## Data models & interfaces
```typescript
// wiki-mcp/src/emitters/config-store.ts
// Event-sourced emitter registry on its OWN durable stream:
//   ${streamBaseUrl}/${namespace}/_emitter-config  (separate from workspace streams)

export type EmitterArchive = "drop" | "mirror";

export type EmitterConfigEvent =
  | { readonly type: "EmitterConfigured"; readonly emitterId: string;
      readonly workspaceId: string; readonly root: string;
      readonly archive: EmitterArchive; readonly at: string }
  | { readonly type: "EmitterRemoved"; readonly emitterId: string; readonly at: string };

// One emitter = one workspace mirrored to one absolute on-disk root.
export interface LiveEmitter {
  readonly emitterId: string;
  readonly workspaceId: string;
  readonly root: string;
  readonly archive: EmitterArchive;
}

export interface IEmitterConfigStore {
  appendConfigured(e: Omit<LiveEmitter, never> & { at: string }): Promise<void>;
  appendRemoved(emitterId: string, at: string): Promise<void>;
  readAll(): Promise<EmitterConfigEvent[]>;
  // last-writer-wins per emitterId; EmitterRemoved deletes the entry
  fold(events: readonly EmitterConfigEvent[]): Map<string, LiveEmitter>;
  // live tail for the registry (stream({ url, live: true }))
  subscribe(onEvent: (e: EmitterConfigEvent) => void): Promise<() => void>;
}
```

```typescript
// wiki-mcp/src/tail/projection.ts — additions to ProjectionService
// (RenderSink + addRenderSink already exist; reconcileSinks(source) already exists)

class ProjectionService {
  // remove a previously-registered sink by identity (new)
  removeRenderSink(sink: RenderSink): void;

  // bring ONE sink to each workspace's stream head (factored out of reconcileSinks) (new)
  reconcileSink(sink: RenderSink, source: EventSource): Promise<void>;

  // now a loop: for (const s of this.renderSinks) await this.reconcileSink(s, source)
  reconcileSinks(source: EventSource): Promise<void>;
}
```

```typescript
// wiki-mcp/src/emitters/registry.ts

import type { IMarkdownProjectionConfig } from "../tail/markdown-projection.js";

// emitter -> the existing per-root projector config (MarkdownDiskProjector unchanged)
export function toMarkdownConfig(e: LiveEmitter): IMarkdownProjectionConfig {
  return { enabled: true, root: e.root, workspaces: [e.workspaceId],
           layout: "tree", archive: e.archive };
}

export interface IEmitterRegistry {
  // boot: replay+fold the config stream, register + back-fill one sink per live emitter,
  // then tail subscribe() for runtime add/replace/remove
  start(): Promise<void>;
  stop(): Promise<void>;
}

// wiki-mcp/src/mcp/tools.ts — three new WikiTool descriptors
export interface ConfigureEmitterArgs {
  emitterId: string; workspaceId: string; root: string; archive?: EmitterArchive;
}
export interface RemoveEmitterArgs { emitterId: string; }
// listEmitters: {} -> { emitters: LiveEmitter[] }
// WikiToolContext gains: readonly emitters: IEmitterConfigStore;
```

## Open questions
_None._

## Resolved questions
_None._

## References
_None._

## Child pages
_None._
