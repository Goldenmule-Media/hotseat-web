/**
 * The per-workspace tail loop — the slim, single-sink analog of wiki-mcp's `ProjectionService`,
 * built entirely on `wiki`'s PUBLIC surface (it imports no wiki-mcp internals). It opens a
 * workspace handle, subscribes to the live stream, and on each commit folds the history to
 * {@link IWorkspaceState}, renders every page to {@link SearchDoc}s, and hands them to the
 * {@link MarkdownDiskProjector} as a whole-workspace rebuild.
 *
 * v1 re-folds the full history on every change (simplest + correct): the projector
 * content-hashes each page, so a re-render that produces identical bytes writes nothing — a
 * rebuild is idempotent and a no-op when nothing changed. (Incremental `applyWorkspace` +
 * affected-only deltas are a later optimization if large workspaces show tail lag.)
 */
import { foldWorkspace, renderSearchDocs } from "wiki";
import type { IWorkspaceHandle, Unsubscribe, WorkspaceId } from "wiki";
import { Registry } from "wiki/registry";

import type { Logger } from "./logger.js";
import type { MarkdownDiskProjector } from "./markdown-projection.js";

/** A point-in-time health snapshot of one workspace's tail loop, surfaced over the health endpoint. */
export interface MirrorWorkspaceStatus {
  readonly workspaceId: string;
  /** Absolute on-disk mirror root. */
  readonly root: string;
  /** The version this mirror has written to disk (0 if never applied). */
  readonly appliedVersion: number;
  /** Epoch ms of the last successful reconcile, or null if none has completed. */
  readonly lastReconcileAt: number | null;
  /** Message of the most recent reconcile failure, cleared on the next success; null when healthy. */
  readonly lastReconcileError: string | null;
  /** Whether the loop is subscribed to (tailing) the live stream. */
  readonly connected: boolean;
}

export class WorkspaceMirror {
  /** Serializes reconciles so overlapping triggers never interleave manifest/tree writes. */
  private chain: Promise<void> = Promise.resolve();
  private unsub?: Unsubscribe;
  private stopped = false;
  private lastReconcileAt: number | null = null;
  private lastReconcileError: string | null = null;
  private connected = false;

  constructor(
    private readonly handle: IWorkspaceHandle,
    private readonly registry: Registry,
    private readonly sink: MarkdownDiskProjector,
    private readonly workspaceId: WorkspaceId,
    private readonly logger: Logger,
  ) {}

  /** Load + self-heal the manifest, back-fill from head, then tail the stream for live commits. */
  async start(): Promise<void> {
    await this.sink.init();
    await this.sync(); // boot back-fill from the workspace head
    this.unsub = await this.handle.subscribe(() => this.kick());
    this.connected = true;
  }

  /** A point-in-time health snapshot of this tail loop (for the health endpoint). */
  async status(): Promise<MirrorWorkspaceStatus> {
    return {
      workspaceId: this.workspaceId,
      root: this.sink.root,
      appliedVersion: await this.sink.appliedVersion(this.workspaceId),
      lastReconcileAt: this.lastReconcileAt,
      lastReconcileError: this.lastReconcileError,
      connected: this.connected,
    };
  }

  /** Stop tailing and drain any in-flight reconcile. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    this.unsub?.();
    // Drain the in-flight reconcile but ABSORB a prior failed one: a kick()-driven reconcile
    // that rejected left its rejection on `this.chain` (kick's `.catch` rides a derived promise,
    // not `this.chain`), and a clean shutdown must not re-throw it.
    await this.chain.catch(() => {});
  }

  /**
   * Reconcile the mirror to the workspace head now, serialized behind any in-flight reconcile.
   * Used for the boot back-fill, the live-tail trigger, and as an awaitable manual sync.
   */
  sync(): Promise<void> {
    this.chain = this.chain.then(
      () => this.reconcile(),
      () => this.reconcile(),
    );
    return this.chain;
  }

  /** Live-tail trigger: best-effort sync; a failure is surfaced but never kills the loop. */
  private kick(): void {
    if (this.stopped) return;
    void this.sync().catch((err) => this.sink.fail(this.workspaceId, -1, err));
  }

  /** Reconcile once, recording the outcome for {@link status}. Re-throws so callers (sync/kick) still see failures. */
  private async reconcile(): Promise<void> {
    try {
      await this.reconcileOnce();
      this.lastReconcileAt = Date.now(); // host wall-clock; the determinism rule binds reducers/renderers, not the tail loop
      this.lastReconcileError = null;
    } catch (err) {
      this.lastReconcileError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  private async reconcileOnce(): Promise<void> {
    const events = await this.handle.history();
    if (events.length === 0) return;
    const head = events[events.length - 1].version + 1;
    if ((await this.sink.appliedVersion(this.workspaceId)) >= head) return; // already current
    const state = foldWorkspace(events, this.registry);
    const docs = renderSearchDocs(state, this.registry, {
      onRenderError: (pageId, err) =>
        this.logger.warn("render: page failed to render (mirrored with empty body)", {
          workspace: this.workspaceId,
          pageId,
          error: err instanceof Error ? err.message : String(err),
        }),
    });
    await this.sink.rebuild(this.workspaceId, state.version, docs, state);
  }
}
