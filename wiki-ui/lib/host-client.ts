"use client";

/**
 * The tab side of the SharedWorker seam (feature: shared engine in a SharedWorker). Instead of
 * constructing a per-tab engine + PGlite, it connects to the ONE shared worker and exposes a
 * small typed {@link WikiHost} facade over the Comlink proxy. The facade hides Comlink
 * entirely from the rest of the UI.
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
import { getToken, notifyUnauthorized } from "./auth";
import * as perf from "./perf";
import {
  classifyError,
  type HostSearchOpts,
  type RenderedElement,
  type SectionElementSummary,
  type SnapshotCallback,
  type WikiHostApi,
} from "./wiki-host-api";

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
  createWorkspace(name: string): Promise<{ readonly workspaceId: WorkspaceId }>;
  search(query: string, opts: HostSearchOpts): Promise<readonly SearchHit[]>;
  primeSearchIndex(): Promise<void>;
  ensureWorkspace(ws: WorkspaceId): Promise<void>;
  toMarkdown(ws: WorkspaceId, page: PageId): Promise<string>;
  describeMutations(ws: WorkspaceId, page: PageId): Promise<readonly IMutationDescriptor[]>;
  renderElement(ws: WorkspaceId, page: PageId, sectionKey: string, elementId: string): Promise<string>;
  renderSectionElements(ws: WorkspaceId, page: PageId, sectionKey: string): Promise<readonly RenderedElement[]>;
  listSectionElements(ws: WorkspaceId, page: PageId, sectionKey: string): Promise<readonly SectionElementSummary[]>;
  mutate(ws: WorkspaceId, page: PageId, command: string, args: Record<string, unknown>): Promise<void>;
  createPage(ws: WorkspaceId, type: string, title: string, parentId: PageId | null): Promise<PageId>;
  setPageTitle(ws: WorkspaceId, page: PageId, title: string): Promise<void>;
  archivePage(ws: WorkspaceId, page: PageId): Promise<void>;
  unarchivePage(ws: WorkspaceId, page: PageId): Promise<void>;
  reparentPage(ws: WorkspaceId, page: PageId, newParentId: PageId | null, position?: number): Promise<void>;
  renameWorkspace(ws: WorkspaceId, name: string): Promise<void>;
  subscribe(ws: WorkspaceId, onSnapshot: SnapshotCallback): Promise<() => void>;
  /** Close the shared worker so the next page load starts a fresh one (new code, cold
   *  engine). Fire-and-forget by design: the worker dies before it can reply. */
  restart(): void;
}

/** Heartbeat cadence — must stay well under the worker's PING_TIMEOUT_MS so a live tab is
 *  never reaped. A hidden tab's timers are throttled well past that, so the heartbeat also
 *  heals a reaped port ({@link PingResult.resubscribe}) rather than relying on cadence alone. */
const PING_INTERVAL_MS = 10_000;

/** One live snapshot subscription, remembered so a heartbeat that finds this port reaped can
 *  register it again on the worker's fresh state. */
interface ActiveSub {
  readonly ws: WorkspaceId;
  /** The Comlink-proxied callback — re-usable across re-subscribes. */
  readonly cb: SnapshotCallback & Comlink.ProxyMarked;
  subId: number;
  cancelled: boolean;
}

// Immutable FSM descriptors pushed at handshake; `fsmOf` reads this synchronously in render.
const fsmCache = new Map<string, FsmDescriptor>();
let fsmReadyFlag = false;

let hostP: Promise<WikiHost> | null = null;

// The raw Comlink remote of this tab's connection — kept so a token change can be pushed
// to the (shared, possibly already-booted) worker without re-connecting.
let remoteRef: Comlink.Remote<WikiHostApi> | null = null;

/**
 * Push a refreshed/cleared bearer token to an ALREADY-connected worker (it is shared
 * across tabs, so any tab may re-supply it). No-op when this tab has no worker connection
 * yet — the next {@link getHost} passes the stored token before its handshake.
 */
export function pushAuthToken(token: string | null): void {
  void remoteRef?.setAuthToken(token).catch(() => {});
}

/** Funnel an RPC rejection past the 401 check: a dead/expired bearer token anywhere
 *  (engine handle, search, mutate) flips the AuthProvider back to the login page. */
function guard<T>(p: Promise<T>): Promise<T> {
  return p.catch((e: unknown) => {
    if (classifyError(e).kind === "unauthorized") notifyUnauthorized();
    throw e;
  });
}

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
  perf.installBridge();
  perf.bootMark("connectStart");
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

  perf.bootMark("workerCtorAt");
  worker.port.start();
  const remote = Comlink.wrap<WikiHostApi>(worker.port);
  remoteRef = remote;

  // Supply the stored bearer token BEFORE the handshake (which boots the engine), so the
  // first boot's stream config already carries the authorization header. Auth disabled →
  // no token in storage → the worker keeps its header-less config, exactly as before.
  const token = getToken();
  if (token !== null) await remote.setAuthToken(token);

  perf.bootMark("handshakeStart");
  const { fsm } = await remote.handshake();
  perf.bootMark("handshakeEnd");
  for (const [type, descriptor] of Object.entries(fsm)) fsmCache.set(type, descriptor);
  fsmReadyFlag = true;

  // One heartbeat per tab (not per workspace): the worker reaps THIS port's subscriptions if
  // the pings stop (tab closed), and closes the engine when the last port goes silent. A tab
  // that was only HIDDEN can be reaped too (throttled/frozen timers), so a ping that finds the
  // port re-admitted registers every subscription again — otherwise the tab stays silently
  // stale: its RPCs keep working while no snapshot ever arrives again.
  const subs = new Set<ActiveSub>();
  let resubscribeNeeded = false;

  const resubscribeAll = async (): Promise<void> => {
    for (const sub of [...subs]) {
      try {
        const subId = await remote.subscribe(sub.ws, sub.cb);
        if (sub.cancelled) {
          void remote.unsubscribe(sub.ws, subId).catch(() => {});
          continue;
        }
        sub.subId = subId;
      } catch {
        return; // leave the flag set — the next heartbeat retries
      }
    }
    resubscribeNeeded = false;
  };

  const ping = async (): Promise<void> => {
    try {
      const { resubscribe } = await remote.ping();
      if (resubscribe) resubscribeNeeded = true;
      if (resubscribeNeeded) await resubscribeAll();
    } catch {
      /* the next heartbeat retries */
    }
  };
  setInterval(() => void ping(), PING_INTERVAL_MS);
  void ping();
  // A hidden tab's heartbeat is throttled (or stopped outright); ping the moment it comes
  // back so a reaped port heals on the same frame the user looks at it.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void ping();
  });

  return {
    listWorkspaces: () => guard(remote.listWorkspaces()),
    createWorkspace: (name) => guard(remote.createWorkspace(name)),
    search: (query, opts) => guard(remote.search(query, opts)),
    primeSearchIndex: () => guard(remote.primeSearchIndex()),
    ensureWorkspace: (ws) => guard(remote.ensureWorkspace(ws)),
    toMarkdown: (ws, page) => perf.rpc("toMarkdown", page, guard(remote.toMarkdown(ws, page))),
    describeMutations: (ws, page) => perf.rpc("describeMutations", page, guard(remote.describeMutations(ws, page))),
    renderElement: (ws, page, sectionKey, elementId) =>
      perf.rpc("renderElement", page, guard(remote.renderElement(ws, page, sectionKey, elementId))),
    renderSectionElements: (ws, page, sectionKey) =>
      perf.rpc("renderSectionElements", page, guard(remote.renderSectionElements(ws, page, sectionKey))),
    listSectionElements: (ws, page, sectionKey) =>
      perf.rpc("listSectionElements", page, guard(remote.listSectionElements(ws, page, sectionKey))),
    mutate: (ws, page, command, args) => guard(remote.mutate(ws, page, command, args)),
    createPage: (ws, type, title, parentId) => guard(remote.createPage(ws, type, title, parentId)),
    setPageTitle: (ws, page, title) => guard(remote.setPageTitle(ws, page, title)),
    archivePage: (ws, page) => guard(remote.archivePage(ws, page)),
    unarchivePage: (ws, page) => guard(remote.unarchivePage(ws, page)),
    reparentPage: (ws, page, newParentId, position) => guard(remote.reparentPage(ws, page, newParentId, position)),
    renameWorkspace: (ws, name) => guard(remote.renameWorkspace(ws, name)),
    restart: () => {
      // Not awaited: the worker closes as it answers, so the promise may never settle.
      void remote.restart().catch(() => {});
      // This tab's connection dies with the worker — force a fresh one.
      hostP = null;
      remoteRef = null;
    },
    subscribe: async (ws, onSnapshot) => {
      // Comlink.proxy lets the worker invoke this tab-side callback across the port.
      const cb = Comlink.proxy(onSnapshot);
      const sub: ActiveSub = { ws, cb, subId: -1, cancelled: false };
      sub.subId = await guard(remote.subscribe(ws, cb));
      subs.add(sub);
      return () => {
        sub.cancelled = true;
        subs.delete(sub);
        void remote.unsubscribe(ws, sub.subId).catch(() => {});
      };
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
