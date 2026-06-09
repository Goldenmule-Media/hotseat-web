"use client";

/**
 * The tab side of the SharedWorker seam (feature: shared engine in a SharedWorker). Replaces
 * the old per-tab `getWiki()`: instead of constructing the engine + PGlite in this tab, it
 * connects to the ONE shared worker and exposes a small typed {@link WikiHost} facade over the
 * Comlink proxy. The facade hides Comlink entirely from the rest of the UI.
 *
 * SharedWorker-only, no fallback (deliberate scope): where it (or module-worker support) is
 * absent we throw {@link UnsupportedBrowserError} and the app shows an unsupported-browser
 * message — no Web-Locks leader-tab, no per-tab dedicated worker.
 *
 * `fsmOf` stays SYNCHRONOUS: {@link getHost} awaits the worker's `handshake()` (which carries
 * every page type's FSM descriptor) before resolving, and the live store only pushes a tree
 * snapshot AFTER subscribing through `getHost`. So by the time any page renders a tree node,
 * the descriptor cache is populated — `fsmOf` never becomes a per-render RPC.
 *
 * Browser-only: `getHost` constructs the worker lazily and throws on the server; the live
 * store calls it from an effect, preserving the null-on-SSR contract.
 */
import * as Comlink from "comlink";
import type { FsmDescriptor, IMutationDescriptor, IWorkspaceSummary, PageId, SearchHit, WorkspaceId } from "wiki";
import type { HostSearchOpts, SnapshotCallback, WikiHostApi } from "./wiki-host-api";

/** Thrown when SharedWorker (or its module-worker form) is unavailable. The app renders a
 *  clear unsupported-browser notice rather than degrading. */
export class UnsupportedBrowserError extends Error {
  readonly kind = "unsupported" as const;
  constructor(
    message = "This browser doesn't support module SharedWorkers, which wiki-ui requires (Chrome/Edge, Firefox 114+, or Safari 16+).",
  ) {
    super(message);
    this.name = "UnsupportedBrowserError";
  }
}

/** Cheap synchronous capability check (client-side). The actual `{type:"module"}` support is
 *  confirmed by a guarded construction in {@link connect}. */
export function isHostSupported(): boolean {
  return typeof window !== "undefined" && typeof SharedWorker !== "undefined";
}

/** The typed host facade the UI consumes. Mirrors {@link WikiHostApi} minus the Comlink
 *  plumbing: `subscribe` takes a plain callback and returns a plain unsubscribe. */
export interface WikiHost {
  listWorkspaces(): Promise<readonly IWorkspaceSummary[]>;
  search(query: string, opts: HostSearchOpts): Promise<readonly SearchHit[]>;
  primeSearchIndex(): Promise<void>;
  ensureWorkspace(ws: WorkspaceId): Promise<void>;
  toMarkdown(ws: WorkspaceId, page: PageId): Promise<string>;
  describeMutations(ws: WorkspaceId, page: PageId): Promise<readonly IMutationDescriptor[]>;
  mutate(ws: WorkspaceId, page: PageId, command: string, args: Record<string, unknown>): Promise<void>;
  archivePage(ws: WorkspaceId, page: PageId): Promise<void>;
  unarchivePage(ws: WorkspaceId, page: PageId): Promise<void>;
  renameWorkspace(ws: WorkspaceId, name: string): Promise<void>;
  subscribe(ws: WorkspaceId, onSnapshot: SnapshotCallback): Promise<() => void>;
}

/** Heartbeat cadence — must stay well under the worker's PING_TIMEOUT_MS so a live tab is
 *  never reaped. */
const PING_INTERVAL_MS = 10_000;

// Immutable FSM descriptors pushed at handshake; `fsmOf` reads this synchronously in render.
const fsmCache = new Map<string, FsmDescriptor>();
let fsmReadyFlag = false;

let hostP: Promise<WikiHost> | null = null;

/** Connect to (and, on first call, construct) the shared worker. Memoised — one worker per
 *  tab. Awaits the handshake so the FSM cache is populated before the caller proceeds. */
export function getHost(): Promise<WikiHost> {
  if (hostP === null) {
    hostP = connect().catch((e: unknown) => {
      hostP = null; // allow a later retry (e.g. probe recovery) to reconnect
      throw e;
    });
  }
  return hostP;
}

async function connect(): Promise<WikiHost> {
  if (!isHostSupported()) throw new UnsupportedBrowserError();

  let worker: SharedWorker;
  try {
    // STATIC literal — webpack only detects the worker entry from this exact
    // `new URL(<literal>, import.meta.url)` form (a hoisted variable defeats it).
    worker = new SharedWorker(new URL("./wiki-host.worker.ts", import.meta.url), {
      type: "module",
      name: "wiki-host",
    });
  } catch (e) {
    throw new UnsupportedBrowserError(
      `Failed to start the wiki SharedWorker (module workers unsupported?): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  worker.port.start();
  const remote = Comlink.wrap<WikiHostApi>(worker.port);

  const { fsm } = await remote.handshake();
  for (const [type, descriptor] of Object.entries(fsm)) fsmCache.set(type, descriptor);
  fsmReadyFlag = true;

  // One heartbeat per tab (not per workspace): the worker reaps THIS port's subscriptions if
  // the pings stop (tab closed), and closes the engine when the last port goes silent.
  const ping = (): void => void remote.ping().catch(() => {});
  setInterval(ping, PING_INTERVAL_MS);
  ping();

  return {
    listWorkspaces: () => remote.listWorkspaces(),
    search: (query, opts) => remote.search(query, opts),
    primeSearchIndex: () => remote.primeSearchIndex(),
    ensureWorkspace: (ws) => remote.ensureWorkspace(ws),
    toMarkdown: (ws, page) => remote.toMarkdown(ws, page),
    describeMutations: (ws, page) => remote.describeMutations(ws, page),
    mutate: (ws, page, command, args) => remote.mutate(ws, page, command, args),
    archivePage: (ws, page) => remote.archivePage(ws, page),
    unarchivePage: (ws, page) => remote.unarchivePage(ws, page),
    renameWorkspace: (ws, name) => remote.renameWorkspace(ws, name),
    subscribe: async (ws, onSnapshot) => {
      // Comlink.proxy lets the worker invoke this tab-side callback across the port.
      const subId = await remote.subscribe(ws, Comlink.proxy(onSnapshot));
      return () => void remote.unsubscribe(ws, subId).catch(() => {});
    },
  };
}

/** True once the handshake has populated the FSM cache. */
export function fsmReady(): boolean {
  return fsmReadyFlag;
}

/**
 * The page TYPE's status FSM, synchronously — from the handshake cache, so it is safe to call
 * in render. Returns `null` for an unknown type or before the handshake completes (callers
 * treat `null` as "no model view / not terminal", matching the old SSR behaviour).
 */
export function fsmOf(type: string | undefined): FsmDescriptor | null {
  if (type === undefined) return null;
  return fsmCache.get(type) ?? null;
}
