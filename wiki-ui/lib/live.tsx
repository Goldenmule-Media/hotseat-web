"use client";

/**
 * Live, read-only workspace store + React hooks. This is what makes the UI live-update
 * without polling — but the engine no longer runs in this tab. It runs in the shared worker
 * (lib/wiki-host.worker.ts), which owns the single tail + probe and pushes a
 * {@link WorkspaceSnapshot} (the freshly-folded tree + classified connection/error) on every
 * commit. This module is now a thin MIRROR of those pushes:
 *
 *   getHost() → host.subscribe(id, onSnapshot)   register, seed-on-subscribe, then live
 *   each pushed snapshot → re-project the React store (no tab-side re-read of tree())
 *
 * One {@link WorkspaceSession} per workspace, shared across the switcher / tree / page via a
 * module-level cache and exposed to React through `useSyncExternalStore`. Sessions live for
 * the tab's lifetime; the worker's heartbeat reaper cleans up this tab's subscriptions when
 * the tab closes.
 *
 * The per-page reads (`toMarkdown`, `describeMutations`) and the write path (`mutate`,
 * archive/unarchive) are coarse RPCs to the worker, keyed off the live snapshot's
 * `lastEventAt` so the open page re-projects on every commit.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { IMutationDescriptor, IWorkspaceSummary, PageId, WorkspaceId } from "wiki";
import { notifyUnauthorized, serverBaseUrl } from "./auth";
import { useAuth } from "./auth-context";
import { getHost, UnsupportedBrowserError, type WikiHost } from "./host-client";
import { classifyError, type LoadError, type WorkspaceSnapshot } from "./wiki-host-api";

// Re-exported so existing consumers (LiveIndicator, WorkspaceError) keep importing from here.
export type { ConnectionState, LoadError, LoadErrorKind } from "./wiki-host-api";

/** The tab's view of one workspace: its id plus the worker's authoritative snapshot. */
export type LiveWorkspace = { readonly id: WorkspaceId } & WorkspaceSnapshot;

// ── per-workspace live session (mirror of the worker's push) ─────────────────────

class WorkspaceSession {
  private listeners = new Set<() => void>();
  private snap: LiveWorkspace;
  private unsub: (() => void) | null = null;
  private disposed = false;
  /** True once the worker's seed-on-subscribe snapshot has been delivered. */
  private seeded = false;

  constructor(readonly id: WorkspaceId) {
    this.snap = { id, tree: null, connection: "connecting", version: null, lastEventAt: null, error: null };
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

  private emit(snapshot: WorkspaceSnapshot): void {
    this.snap = { id: this.id, ...snapshot };
    for (const l of this.listeners) l();
  }

  private async start(): Promise<void> {
    try {
      const host = await getHost();
      if (this.disposed) return;
      this.unsub = await host.subscribe(this.id, (snap) => {
        if (this.disposed) return;
        // A 401 pushed through the live tail (token expired mid-session) must also fall
        // back to login — RPC rejections are guarded in host-client, pushes are here.
        // Only on a TRANSITION into unauthorized, though: the seed-on-subscribe replay of
        // a snapshot cached before sign-in must not clear a freshly-minted valid token
        // (the worker drops 401-poisoned hosts on a new token; this guards the race).
        const wasUnauthorized = this.snap.error?.kind === "unauthorized";
        if (this.seeded && !wasUnauthorized && snap.error?.kind === "unauthorized") notifyUnauthorized();
        this.seeded = true;
        this.emit(snap);
      });
    } catch (e) {
      if (this.disposed) return;
      // The worker is unreachable before we could subscribe: an unsupported browser (no
      // engine at all), or a connect/handshake failure (transport). Surface it so the view
      // explains why — the worker owns recovery once it is reachable.
      const kind = e instanceof UnsupportedBrowserError ? "unsupported" : classifyError(e).kind;
      const message = e instanceof Error ? e.message : String(e);
      this.emit({ tree: null, connection: "error", version: null, lastEventAt: null, error: { kind, message, unknownTypes: [] } });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unsub?.();
    this.unsub = null;
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── session cache ─────────────────────────────────────────────────────────────

const sessions = new Map<string, WorkspaceSession>();

function sessionFor(id: WorkspaceId): WorkspaceSession | null {
  if (typeof window === "undefined") return null; // server render — the worker is client-only
  let s = sessions.get(id);
  if (s === undefined) {
    s = new WorkspaceSession(id);
    sessions.set(id, s);
  }
  return s;
}

// Stable per-id placeholder snapshot for the server / pre-mount render.
const pendingSnaps = new Map<string, LiveWorkspace>();
function pendingSnap(id: WorkspaceId): LiveWorkspace {
  let s = pendingSnaps.get(id);
  if (s === undefined) {
    s = { id, tree: null, connection: "connecting", version: null, lastEventAt: null, error: null };
    pendingSnaps.set(id, s);
  }
  return s;
}

// ── hooks ─────────────────────────────────────────────────────────────────────

export function useLiveWorkspace(id: WorkspaceId): LiveWorkspace {
  // Defer session creation to an effect so the worker never instantiates on the server.
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
  /** The server has a page type this build's bundle does not know. */
  readonly unknownType: boolean;
}

const PAGE_PENDING: PageContent = { markdown: null, loading: true, error: null, unknownType: false };

export function usePage(workspaceId: WorkspaceId, pageId: PageId): PageContent {
  const ws = useLiveWorkspace(workspaceId);
  const [content, setContent] = useState<PageContent>(PAGE_PENDING);

  // Re-read the page markdown on mount and whenever a new commit lands (ws.lastEventAt).
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    setContent((c) => ({ ...c, loading: true }));
    getHost()
      .then((h) => h.toMarkdown(workspaceId, pageId))
      .then((md) => {
        if (!cancelled) setContent({ markdown: md, loading: false, error: null, unknownType: false });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const err = classifyError(e);
        setContent({ markdown: null, loading: false, error: err.message, unknownType: err.kind === "unknown-page-type" });
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
  const { me, serverReachable } = useAuth();
  const [state, setState] = useState<{
    items: readonly IWorkspaceSummary[];
    loading: boolean;
    error: string | null;
  }>({ items: [], loading: true, error: null });
  const [nonce, setNonce] = useState(0);

  // The auth-config probe is the one bounded reachability check at mount. If it proved the
  // server unreachable, surface that with the URL instead of waiting on listWorkspaces() —
  // a down server makes the catalog fetch hang/retry, leaving the list stuck on "Loading…".
  useEffect(() => {
    if (!serverReachable) {
      setState({ items: [], loading: false, error: `No response from the wiki-server at ${serverBaseUrl()}.` });
    }
  }, [serverReachable]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    getHost()
      .then((h) => h.listWorkspaces())
      .then((items) => {
        // Hide archived workspaces from default listings (the landing page + switcher); they
        // are restored via the `unarchiveWorkspace` MCP tool, not the UI.
        const active = items.filter((w) => w.status === "active");
        if (!cancelled) setState({ items: active, loading: false, error: null });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ items: [], loading: false, error: errMsg(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  // The workspace registry has no cross-workspace stream, so refresh it on demand and when
  // the tab regains focus rather than polling.
  useEffect(() => {
    const onFocus = (): void => setNonce((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // When auth is on, hide workspaces the server marked restricted (owned by someone else,
  // caller not a member). Filtered here — the single point every consumer (landing list,
  // switcher, title) already reads — and reactive to /auth/me refreshes after ACL changes.
  const restricted = me?.workspaces.restricted;
  const items = useMemo(
    () =>
      restricted === undefined || restricted.length === 0
        ? state.items
        : state.items.filter((w) => !restricted.includes(w.id)),
    [state.items, restricted],
  );

  return { items, loading: state.loading, error: state.error, refresh: () => setNonce((n) => n + 1) };
}

export interface PageMutations {
  /** Per-command descriptors from the engine (name, available, unmet, target, …). */
  readonly descriptors: readonly IMutationDescriptor[];
  readonly loading: boolean;
}

const MUTATIONS_PENDING: PageMutations = { descriptors: [], loading: true };

/**
 * The open page's live mutation descriptors — its precondition-aware transition availability
 * (each command's `available` + `unmet`). Re-read on mount and whenever a new commit lands
 * (`ws.lastEventAt`), so the model-inspection overlay tracks status and precondition changes
 * without polling. Empty on a read failure.
 */
export function usePageMutations(workspaceId: WorkspaceId, pageId: PageId): PageMutations {
  const ws = useLiveWorkspace(workspaceId);
  const [state, setState] = useState<PageMutations>(MUTATIONS_PENDING);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    getHost()
      .then((h) => h.describeMutations(workspaceId, pageId))
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

export interface PageMutator {
  /** Run a page-scoped command; resolves `true` on commit, `false` on a rejected write (with
   *  {@link PageMutator.error} set). The committed event flows back through the worker's tail,
   *  re-projecting this page in every open tab, so the caller refreshes no view itself. */
  run(command: string, args: Record<string, unknown>): Promise<boolean>;
  readonly pending: boolean;
  /** The engine's `ValidationError` / precondition message, formatted; `null` when clear. */
  readonly error: string | null;
  reset(): void;
}

/**
 * The page's WRITE path. The single place a page command is sent to the worker (`host.mutate`),
 * which runs it on the one engine handle. On success the worker's tail receives the commit and
 * re-projects this page (status + descriptors) in every tab, so this hook never touches view
 * state beyond clearing `pending`. A rejected write is classified to a readable `error`.
 */
export function usePageMutator(workspaceId: WorkspaceId, pageId: PageId): PageMutator {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (command: string, args: Record<string, unknown>): Promise<boolean> => {
      setPending(true);
      setError(null);
      try {
        const h = await getHost();
        await h.mutate(workspaceId, pageId, command, args);
        setPending(false);
        return true;
      } catch (e) {
        setError(classifyError(e).message);
        setPending(false);
        return false;
      }
    },
    [workspaceId, pageId],
  );

  const reset = useCallback(() => {
    setError(null);
    setPending(false);
  }, []);

  return { run, pending, error, reset };
}

export interface StructuralMutator {
  /** Archive a page — hides it (and its subtree) from default tree views. Resolves `true` on commit. */
  archive: (pageId: PageId) => Promise<boolean>;
  /** Unarchive a page — restores it to default tree views. */
  unarchive: (pageId: PageId) => Promise<boolean>;
  readonly pending: boolean;
  /** The engine's error message, formatted; `null` when clear. */
  readonly error: string | null;
}

/**
 * Structural writes for the sidebar (archive / unarchive). Like {@link usePageMutator}, these
 * go to the worker; the committed event flows back through the tail and re-projects the tree,
 * so callers never refresh a view themselves.
 */
export function useStructuralMutator(workspaceId: WorkspaceId): StructuralMutator {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const call = useCallback(
    async (fn: (h: WikiHost) => Promise<unknown>): Promise<boolean> => {
      setPending(true);
      setError(null);
      try {
        const h = await getHost();
        await fn(h);
        setPending(false);
        return true;
      } catch (e) {
        setError(classifyError(e).message);
        setPending(false);
        return false;
      }
    },
    [],
  );

  const archive = useCallback((pageId: PageId) => call((h) => h.archivePage(workspaceId, pageId)), [call, workspaceId]);
  const unarchive = useCallback((pageId: PageId) => call((h) => h.unarchivePage(workspaceId, pageId)), [call, workspaceId]);

  return { archive, unarchive, pending, error };
}
