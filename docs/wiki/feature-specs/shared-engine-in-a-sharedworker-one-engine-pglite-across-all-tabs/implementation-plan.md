# Implementation plan

**Status:** ready

## Steps
1. **Phase 0 — derisk the worker bundle (do this first; it gates everything).** Stand up a throwaway `lib/wiki-host.worker.ts` that imports `createWiki` from `wiki` and opens `new PGlite("idb://…")`, instantiate it as a `{type:"module"}` SharedWorker under `next dev`, and tail one workspace. Resolve the two open questions: (a) does Next/webpack emit PGlite's `.wasm`/`.data` for a worker entry, or must we pass `wasmModule`/`fsBundle`; (b) does `transpilePackages: ["wiki","wiki-models"]` reach the separate worker compilation. If either fails, fix the bundling recipe before writing real code.
2. **Define the flat host RPC contract.** Add `lib/wiki-host-api.ts` with the coarse `WikiHostApi` interface (handshake, listWorkspaces, search, ensureWorkspace, tree, toMarkdown, describeMutations, mutate, archivePage, unarchivePage, subscribe, ping) and the `CommitMsg` broadcast shape. No `IWorkspaceHandle`/`IPageView` cross the port — every call is coarse and returns plain data. This file is imported by both the worker and the tab, so it must be type-only (no engine import at module scope on the tab side).
3. **Build the worker host.** Implement `lib/wiki-host.worker.ts`: relocate the bodies of `engine.ts` + `search-db.ts` + `pglite-dialect.ts` + `models.ts` into worker scope — build PGlite + Kysely + `pageTypes`, run `migrateSearchToLatest`, call `createWiki` once. Hold a `Map<WorkspaceId, IWorkspaceHandle>` opened lazily by `ensureWorkspace`. Run the ONE reachability probe (moved out of `live.tsx`) and the one-time `ensureIndexed` priming here. `onconnect → Comlink.expose(api, port); port.start()`.
4. **Error protocol.** Add the `WikiErrorDTO` (`{__wikiError, code, message, types?, issues?}`) and register a Comlink `transferHandler` for `WikiError` on BOTH sides; wrap every RPC body so an engine throw is caught and re-thrown as the DTO (read `.code`/`.types` off the live instance, where they're intact). Without this, structured clone strips the subclass + own-props and `classify()` mis-buckets every error as a connection failure.
5. **Subscription fan-out + lifecycle.** In the worker, call `handle.subscribe(...)` ONCE per opened workspace; on each commit build a `CommitMsg` (affected workspace + pageId(s) + the freshly-folded `tree()` the worker already holds) and fan it out to that workspace's registered port-callbacks. `subscribe(ws, cb)` registers a Comlink-proxied callback and returns an unsubscribe. Add a heartbeat: tabs call `ping()` on an interval; the worker reaps a port's callbacks when it goes silent, and runs `wiki.close()` only when the last port disconnects.
6. **Tab-side client.** Add `lib/host-client.ts`: feature-detect (`typeof SharedWorker !== "undefined"` + module-worker support) and throw a typed `UnsupportedBrowserError` when absent; construct the worker with a STATIC `new SharedWorker(new URL("./wiki-host.worker.ts", import.meta.url), {type:"module"})` literal; `Comlink.wrap(worker.port)`; run `handshake()` and cache the returned `FsmDescriptor`s in a module-level map. Expose `getHost(): Promise<Remote<WikiHostApi>>` and a sync `fsmOf(type)` reading the cache.
7. **Rewire `lib/engine.ts`.** `getWiki()`'s in-tab `createWiki` is deleted; the file becomes a thin re-export of `getHost()` from `host-client.ts` (or is removed and call sites repointed). Preserve the null-on-SSR contract as a "connecting" handle so client components still pre-render. `search-db.ts`/`pglite-dialect.ts`/`models.ts` no longer run in the tab.
8. **Rewire `lib/live.tsx` (the UI store stays; internals change).** Keep `WorkspaceSession` + `useSyncExternalStore`. `resume()`: `host.ensureWorkspace(id)` + `host.tree(id)` to seed, then `host.subscribe(id, onCommit)` for the live tail (store the unsubscribe; call it on dispose; start the `ping` heartbeat). `onCommit` uses `msg.tree`/`msg.affectedPageIds` to update the snapshot — no blind re-read. Collapse `usePage`/`usePageMutations` `h.page(id).describeMutations()` into single `host.describeMutations(ws,page)` / `host.toMarkdown(ws,page)` RPCs. `classify()` branches on the DTO `code`, not `instanceof`.
9. **Rewire `lib/search.ts` + `fsmOf` call sites.** `wiki.search(...)`/`listWorkspaces()` become `host.search(...)`/`host.listWorkspaces()`; the per-tab `ensureIndexed` priming moves into the worker (it primes the one shared index). Repoint `fsmOf` in `components/PageView.tsx` + `lib/terminal.ts` at the synchronous descriptor cache from the handshake so render stays sync. Add the unsupported-browser UI for the feature-detect failure.
10. **Verify.** `tsc --noEmit` (wiki-ui) + the existing vitest suites (`schema-form`, `fsm-graph`, `snippet`) + `next build` all green. Then the USER's multi-tab browser smoke check (no-browser-automation convention): two tabs open, one issues a transition, the other live-updates from the shared tail; exactly one PGlite/one connection in DevTools; a schema/unknown-type error still classifies as a schema error (not "Disconnected").

## Data models & interfaces
```typescript
// lib/wiki-host-api.ts — the FLAT RPC surface the SharedWorker exposes and tabs consume.
// No IWorkspaceHandle / IPageView proxies cross the port: every call is coarse and returns
// plain, structured-clone-safe data. The callback-based subscribe is inverted into a
// per-port broadcast of CommitMsg.
import type {
  FsmDescriptor, ITreeNode, IMutationDescriptor, IWorkspaceSummary,
  SearchHit, PageId, WorkspaceId,
} from "wiki";

export interface WikiHostApi {
  // returns the immutable FSM descriptors once, so fsmOf() stays SYNC in tab render
  handshake(): Promise<{ fsm: Record<string, FsmDescriptor> }>;

  listWorkspaces(): Promise<IWorkspaceSummary[]>;
  search(query: string, opts: { workspaces?: WorkspaceId[]; limit?: number }): Promise<SearchHit[]>;

  ensureWorkspace(ws: WorkspaceId): Promise<void>;   // open + fold + start tail (idempotent)
  tree(ws: WorkspaceId): Promise<ITreeNode>;
  toMarkdown(ws: WorkspaceId, page: PageId): Promise<string>;
  describeMutations(ws: WorkspaceId, page: PageId): Promise<IMutationDescriptor[]>;

  mutate(ws: WorkspaceId, page: PageId, command: string, args: Record<string, unknown>): Promise<void>;
  archivePage(ws: WorkspaceId, page: PageId): Promise<void>;
  unarchivePage(ws: WorkspaceId, page: PageId): Promise<void>;

  // register a Comlink-proxied callback; resolves to an unsubscribe fn
  subscribe(ws: WorkspaceId, onCommit: (msg: CommitMsg) => void): Promise<() => void>;
  ping(): Promise<void>;   // heartbeat: lets the worker reap dead ports (no port-closed event)
}

// FAT broadcast: the worker already folded the commit, so the tab re-pulls only what changed
// instead of re-reading tree()+toMarkdown()+describeMutations() on every event.
export interface CommitMsg {
  readonly workspace: WorkspaceId;
  readonly version: number;
  readonly affectedPageIds: readonly PageId[];
  readonly tree: ITreeNode;
}
```

```typescript
// Error protocol. structuredClone of an Error keeps only name/message/stack — it DROPS the
// subclass identity and the engine's own-prop fields (WikiError.code, UnknownPageTypeError.types,
// ValidationError.issues). classify() in lib/live.tsx already duck-types .code/.types, so we
// marshal a plain DTO at the worker edge and let it flow through unchanged.
import * as Comlink from "comlink";
import { WikiError, UnknownPageTypeError } from "wiki";

export interface WikiErrorDTO {
  readonly __wikiError: true;
  readonly code: string;                 // e.g. "UNKNOWN_PAGE_TYPE", "VALIDATION"
  readonly message: string;
  readonly types?: readonly string[];    // UnknownPageTypeError.types
  readonly issues?: unknown;             // ValidationError.issues
}

// Registered on BOTH the worker and the tab so a thrown WikiError survives the port as data.
Comlink.transferHandlers.set("wikiError", {
  canHandle: (v): v is WikiError => v instanceof WikiError,
  serialize: (e: WikiError) => {
    const dto: WikiErrorDTO = {
      __wikiError: true, code: e.code, message: e.message,
      types: e instanceof UnknownPageTypeError ? e.types : undefined,
      issues: (e as { issues?: unknown }).issues,
    };
    return [dto, []];
  },
  deserialize: (dto: WikiErrorDTO) => dto,   // classify() consumes { code, message, types } directly
});
```

```typescript
// lib/wiki-host.worker.ts — runs in SharedWorkerGlobalScope. ONE engine, ONE PGlite (one
// writer), ONE tail; fans each commit out to every connected port.
/// <reference lib="webworker" />
import * as Comlink from "comlink";
import { createWiki, type IWorkspaceHandle } from "wiki";
// PGlite + PGliteDialect + migrateSearchToLatest + pageTypes are RELOCATED here from lib/*

const db = makeSearchDb();                  // new PGlite("idb://wiki-ui-search") — the sole writer
const wiki = createWiki({ stream, pageTypes, search: { db } });
const handles = new Map<WorkspaceId, Promise<IWorkspaceHandle>>();
const ports = new Set<MessagePort>();                       // connected tabs (for reaping)
const subs = new Map<WorkspaceId, Set<(m: CommitMsg) => void>>();
const lastSeen = new WeakMap<MessagePort, number>();        // heartbeat bookkeeping

const api: WikiHostApi = {
  async ensureWorkspace(ws) {
    if (handles.has(ws)) return;
    const h = wiki.openWorkspace(ws);
    handles.set(ws, h);
    const handle = await h;
    await handle.subscribe(async () => {
      const tree = await handle.tree();
      for (const cb of subs.get(ws) ?? []) cb({ workspace: ws, version: -1, affectedPageIds: [], tree });
    });
  },
  // ... tree / toMarkdown / describeMutations / mutate / search wrap the handle + marshal errors
} as WikiHostApi;

(self as unknown as SharedWorkerGlobalScope).onconnect = (e: MessageEvent) => {
  const port = e.ports[0];
  ports.add(port);
  Comlink.expose(api, port);
  port.start();
};
// a timer reaps ports whose lastSeen ping is stale; wiki.close() runs when ports is empty.
```

## Open questions
_None._

## Resolved questions
_None._

## References
_None._

## Child pages
_None._
