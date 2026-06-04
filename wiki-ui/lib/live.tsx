"use client";

/**
 * Live, read-only workspace store + React hooks (plan step 4). This is what makes the
 * UI live-update without polling (constraint #3):
 *
 *   openWorkspace(id) → handle.tree()        seed the view
 *   handle.subscribe(handler)                the engine's G6 live primitive
 *   on each committed event → re-read tree() and bump `lastEventAt`, which re-projects
 *   the page body (usePage re-reads toMarkdown when lastEventAt changes).
 *
 * One {@link WorkspaceSession} per workspace, shared across the switcher / tree / page
 * via a module-level cache, exposed to React through `useSyncExternalStore`. Sessions
 * live for the tab's lifetime (a browser app keeps few open); there is no ref-counted
 * teardown in v1.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type {
  IEventEnvelope,
  IMutationDescriptor,
  ITreeNode,
  IWiki,
  IWorkspaceHandle,
  IWorkspaceSummary,
  PageId,
  Unsubscribe,
  WorkspaceId,
} from "wiki";
import { UnknownPageTypeError, WikiError } from "wiki";
import { getConfig } from "./config";
import { getWiki } from "./engine";

/** Transport (live-tail) health. Distinct from a {@link LoadError}: a workspace can be
 *  fully reachable yet still fail to load because of a schema problem. */
export type ConnectionState = "connecting" | "live" | "reconnecting" | "error";

/**
 * Why a workspace view could not be built. The crucial distinction the UI was missing:
 * - `connection` — the wiki-server is unreachable (network/fetch failure). Retryable;
 *   the probe keeps trying and the view recovers on its own.
 * - `unknown-page-type` / `engine` — the server WAS reached and returned data, but this
 *   build's bundled page types can't fold it. Not a connection problem; polling won't
 *   fix it (only rebuilding wiki-ui with the matching wiki-models bundle will).
 */
export type LoadErrorKind = "connection" | "unknown-page-type" | "engine";

export interface LoadError {
  readonly kind: LoadErrorKind;
  /** Raw engine/network message — logged to the console and shown as fallback detail. */
  readonly message: string;
  /** For `unknown-page-type`: the page/event types the engine could not resolve. */
  readonly unknownTypes: readonly string[];
}

export interface LiveWorkspace {
  readonly id: WorkspaceId;
  readonly tree: ITreeNode | null;
  readonly connection: ConnectionState;
  /** Wall-clock ms of the last applied event — drives the "live" pulse. */
  readonly lastEventAt: number | null;
  readonly error: LoadError | null;
}

// ── per-workspace live session ────────────────────────────────────────────────

class WorkspaceSession {
  private listeners = new Set<() => void>();
  private handleP: Promise<IWorkspaceHandle> | null = null;
  private unsub: Unsubscribe | null = null;
  private disposed = false;
  private snap: LiveWorkspace;
  // Connection health probe (drives the indicator; the engine's tail catches content
  // up on its own, but does not surface connection state, so we probe reachability).
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private down = false;

  constructor(
    private readonly wiki: IWiki,
    readonly id: WorkspaceId,
  ) {
    this.snap = { id, tree: null, connection: "connecting", lastEventAt: null, error: null };
    void this.start();
  }

  /** useSyncExternalStore subscribe. */
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  /** useSyncExternalStore getSnapshot — returns a cached, stable object reference. */
  getSnapshot = (): LiveWorkspace => this.snap;

  /** Shared handle; opened once and reused by tree + page reads. A failed open clears
   *  the cache so a later retry (probe recovery) can re-open instead of replaying a
   *  permanently-rejected promise. */
  handle(): Promise<IWorkspaceHandle> {
    if (this.handleP === null) {
      this.handleP = this.wiki.openWorkspace(this.id).catch((e: unknown) => {
        this.handleP = null;
        throw e;
      });
    }
    return this.handleP;
  }

  private set(patch: Partial<LiveWorkspace>): void {
    this.snap = { ...this.snap, ...patch };
    for (const l of this.listeners) l();
  }

  private async start(): Promise<void> {
    try {
      await this.resume();
      this.scheduleProbe(PROBE_INTERVAL_MS);
    } catch (e) {
      this.fail(e, "error");
      // A transport failure can recover — keep probing. A content/schema error is
      // deterministic for this build, so polling would never clear it.
      if (this.snap.error?.kind === "connection") this.scheduleProbe(PROBE_BACKOFF_MS);
    }
  }

  /** Seed (or re-seed) the tree and ensure we are tailing. Shared by initial start and
   *  probe-detected recovery, so a connection that drops before the first subscribe
   *  still establishes the live tail once the server returns. */
  private async resume(): Promise<void> {
    const h = await this.handle();
    const tree = await h.tree();
    if (this.disposed) return;
    this.down = false;
    this.set({ tree, connection: "live", error: null });
    if (this.unsub === null) {
      this.unsub = await h.subscribe((_e: IEventEnvelope) => void this.onEvent());
    }
  }

  private async onEvent(): Promise<void> {
    // An event arriving is itself proof of liveness.
    this.down = false;
    try {
      const h = await this.handle();
      const tree = await h.tree();
      if (this.disposed) return;
      this.set({ tree, connection: "live", lastEventAt: Date.now(), error: null });
    } catch (e) {
      this.fail(e, "reconnecting");
    }
  }

  /**
   * Classify a failure, log it once, and update state. `lostTransport` is the connection
   * state to show when the cause is a network problem; a content/schema failure leaves
   * the transport reported as reachable (the indicator surfaces it as a schema error,
   * not as "Disconnected") so we don't mislead about why the workspace won't load.
   */
  private fail(e: unknown, lostTransport: ConnectionState): void {
    if (this.disposed) return;
    const error = classify(e);
    // Log on entering a new error (don't spam on every probe/event while still broken).
    if (this.snap.error?.message !== error.message) {
      const tag = error.kind === "connection" ? "unreachable" : error.kind;
      console.error(`[wiki-ui] workspace ${this.id}: ${tag} — ${error.message}`);
    }
    if (error.kind === "connection") {
      this.down = true;
      this.set({ connection: lostTransport, error });
    } else {
      this.set({ connection: "live", error });
    }
  }

  private scheduleProbe(delayMs: number): void {
    if (this.disposed) return;
    this.probeTimer = setTimeout(() => void this.probe(), delayMs);
  }

  /**
   * Reachability probe: a HEAD to the workspace stream. A network rejection means the
   * server is unreachable → "reconnecting" (retried with backoff). On recovery we
   * re-seed the tree and (re)establish the tail; the engine's tail independently
   * replays missed commits, so content also catches up.
   */
  private async probe(): Promise<void> {
    if (this.disposed) return;
    const cfg = getConfig();
    const url = `${cfg.streamBaseUrl.replace(/\/+$/, "")}/${cfg.namespace}/workspace/${encodeURIComponent(this.id)}`;
    try {
      await fetch(url, { method: "HEAD" }); // any HTTP response = reachable
      if (this.down || this.unsub === null || this.snap.connection !== "live") {
        try {
          await this.resume();
        } catch (e) {
          this.fail(e, "reconnecting");
        }
      }
      this.scheduleProbe(PROBE_INTERVAL_MS);
    } catch (e) {
      this.fail(e, "reconnecting");
      this.scheduleProbe(PROBE_BACKOFF_MS);
    }
  }
}

/** Healthy-state probe cadence and the faster retry cadence while disconnected. */
const PROBE_INTERVAL_MS = 10_000;
const PROBE_BACKOFF_MS = 2_000;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Map a thrown value to a {@link LoadError}. The engine throws typed {@link WikiError}s
 * (with a stable `code`) when it reaches the server but can't fold the data; anything
 * else (a `fetch` rejection) is a transport/connection failure. The `code` fallback
 * guards against an `instanceof` miss if the class identity is ever duplicated across
 * bundles.
 */
function classify(e: unknown): LoadError {
  const code = e instanceof WikiError ? e.code : (e as { code?: unknown } | null)?.code;
  if (e instanceof UnknownPageTypeError || code === "UNKNOWN_PAGE_TYPE") {
    const types = e instanceof UnknownPageTypeError ? e.types : [];
    return { kind: "unknown-page-type", message: errMsg(e), unknownTypes: types };
  }
  if (typeof code === "string") {
    return { kind: "engine", message: errMsg(e), unknownTypes: [] };
  }
  return { kind: "connection", message: errMsg(e), unknownTypes: [] };
}

// ── session cache ─────────────────────────────────────────────────────────────

const sessions = new Map<string, WorkspaceSession>();

function sessionFor(id: WorkspaceId): WorkspaceSession | null {
  const wiki = getWiki();
  if (wiki === null) return null; // server render — not ready
  let s = sessions.get(id);
  if (s === undefined) {
    s = new WorkspaceSession(wiki, id);
    sessions.set(id, s);
  }
  return s;
}

// Stable per-id placeholder snapshot for the server / pre-mount render.
const pendingSnaps = new Map<string, LiveWorkspace>();
function pendingSnap(id: WorkspaceId): LiveWorkspace {
  let s = pendingSnaps.get(id);
  if (s === undefined) {
    s = { id, tree: null, connection: "connecting", lastEventAt: null, error: null };
    pendingSnaps.set(id, s);
  }
  return s;
}

// ── hooks ─────────────────────────────────────────────────────────────────────

export function useLiveWorkspace(id: WorkspaceId): LiveWorkspace {
  // Defer session creation to an effect so the engine never instantiates on the server.
  const [session, setSession] = useState<WorkspaceSession | null>(null);
  useEffect(() => {
    setSession(sessionFor(id));
  }, [id]);

  const subscribe = session?.subscribe ?? (() => () => {});
  const getSnapshot = session?.getSnapshot ?? (() => pendingSnap(id));
  return useSyncExternalStore(subscribe, getSnapshot, () => pendingSnap(id));
}

export interface PageContent {
  readonly markdown: string | null;
  readonly loading: boolean;
  readonly error: string | null;
  /** The server has a page type this build's bundle does not know (Q6 limitation). */
  readonly unknownType: boolean;
}

const PAGE_PENDING: PageContent = { markdown: null, loading: true, error: null, unknownType: false };

export function usePage(workspaceId: WorkspaceId, pageId: PageId): PageContent {
  const ws = useLiveWorkspace(workspaceId);
  const [content, setContent] = useState<PageContent>(PAGE_PENDING);

  // Re-read the page markdown on mount and whenever a new event lands (ws.lastEventAt).
  useEffect(() => {
    const session = sessionFor(workspaceId);
    if (session === null) return;
    let cancelled = false;
    setContent((c) => ({ ...c, loading: true }));
    session
      .handle()
      .then((h) => h.toMarkdown(pageId))
      .then((md) => {
        if (!cancelled) setContent({ markdown: md, loading: false, error: null, unknownType: false });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const err = classify(e);
        setContent({
          markdown: null,
          loading: false,
          error: err.message,
          unknownType: err.kind === "unknown-page-type",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, pageId, ws.lastEventAt]);

  return content;
}

export interface WorkspaceList {
  readonly items: readonly IWorkspaceSummary[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

export function useWorkspaces(): WorkspaceList {
  const [state, setState] = useState<{
    items: readonly IWorkspaceSummary[];
    loading: boolean;
    error: string | null;
  }>({ items: [], loading: true, error: null });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const wiki = getWiki();
    if (wiki === null) return;
    let cancelled = false;
    wiki
      .listWorkspaces()
      .then((items) => {
        if (!cancelled) setState({ items, loading: false, error: null });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ items: [], loading: false, error: errMsg(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  // The workspace registry has no cross-workspace stream, so refresh it on demand and
  // when the tab regains focus rather than polling.
  useEffect(() => {
    const onFocus = (): void => setNonce((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  return { ...state, refresh: () => setNonce((n) => n + 1) };
}

export interface PageMutations {
  /** Per-command descriptors from the engine (name, available, unmet, target, …). */
  readonly descriptors: readonly IMutationDescriptor[];
  readonly loading: boolean;
}

const MUTATIONS_PENDING: PageMutations = { descriptors: [], loading: true };

/**
 * The open page's live mutation descriptors — its precondition-aware transition
 * availability (each command's `available` + `unmet`). Re-read on mount and whenever a
 * new event lands (`ws.lastEventAt`), so the model-inspection overlay tracks status and
 * precondition changes without polling (constraint #3). Empty on a read failure.
 */
export function usePageMutations(workspaceId: WorkspaceId, pageId: PageId): PageMutations {
  const ws = useLiveWorkspace(workspaceId);
  const [state, setState] = useState<PageMutations>(MUTATIONS_PENDING);

  useEffect(() => {
    const session = sessionFor(workspaceId);
    if (session === null) return;
    let cancelled = false;
    session
      .handle()
      .then((h) => h.page(pageId))
      .then((view) => view.describeMutations())
      .then((descriptors) => {
        if (!cancelled) setState({ descriptors, loading: false });
      })
      .catch(() => {
        if (!cancelled) setState({ descriptors: [], loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, pageId, ws.lastEventAt]);

  return state;
}
