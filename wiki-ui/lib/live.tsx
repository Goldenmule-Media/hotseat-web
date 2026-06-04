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
  ITreeNode,
  IWiki,
  IWorkspaceHandle,
  IWorkspaceSummary,
  PageId,
  Unsubscribe,
  WorkspaceId,
} from "wiki";
import { getConfig } from "./config";
import { getWiki } from "./engine";

export type ConnectionState = "connecting" | "live" | "reconnecting" | "error";

export interface LiveWorkspace {
  readonly id: WorkspaceId;
  readonly tree: ITreeNode | null;
  readonly connection: ConnectionState;
  /** Wall-clock ms of the last applied event — drives the "live" pulse. */
  readonly lastEventAt: number | null;
  readonly error: string | null;
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

  /** Shared handle; opened once and reused by tree + page reads. */
  handle(): Promise<IWorkspaceHandle> {
    if (this.handleP === null) this.handleP = this.wiki.openWorkspace(this.id);
    return this.handleP;
  }

  private set(patch: Partial<LiveWorkspace>): void {
    this.snap = { ...this.snap, ...patch };
    for (const l of this.listeners) l();
  }

  private async start(): Promise<void> {
    try {
      const h = await this.handle();
      const tree = await h.tree();
      if (this.disposed) return;
      this.set({ tree, connection: "live", error: null });
      this.unsub = await h.subscribe((_e: IEventEnvelope) => void this.onEvent());
      this.scheduleProbe(PROBE_INTERVAL_MS);
    } catch (e) {
      if (!this.disposed) this.set({ connection: "error", error: errMsg(e) });
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
      if (!this.disposed) this.set({ connection: "reconnecting", error: errMsg(e) });
    }
  }

  private scheduleProbe(delayMs: number): void {
    if (this.disposed) return;
    this.probeTimer = setTimeout(() => void this.probe(), delayMs);
  }

  /**
   * Reachability probe: a HEAD to the workspace stream. A network rejection means the
   * server is unreachable → "reconnecting" (retried with backoff). On recovery we
   * re-seed the tree immediately; the engine's tail independently replays missed
   * commits, so content also catches up.
   */
  private async probe(): Promise<void> {
    if (this.disposed) return;
    const cfg = getConfig();
    const url = `${cfg.streamBaseUrl.replace(/\/+$/, "")}/${cfg.namespace}/workspace/${encodeURIComponent(this.id)}`;
    try {
      await fetch(url, { method: "HEAD" }); // any HTTP response = reachable
      if (this.down) {
        this.down = false;
        try {
          const h = await this.handle();
          const tree = await h.tree();
          this.set({ tree, connection: "live", lastEventAt: Date.now(), error: null });
        } catch {
          this.set({ connection: "live", error: null });
        }
      } else if (this.snap.connection !== "live") {
        this.set({ connection: "live", error: null });
      }
      this.scheduleProbe(PROBE_INTERVAL_MS);
    } catch (e) {
      this.down = true;
      this.set({ connection: "reconnecting", error: errMsg(e) });
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
        const msg = errMsg(e);
        setContent({
          markdown: null,
          loading: false,
          error: msg,
          unknownType: /unknown page type/i.test(msg),
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
