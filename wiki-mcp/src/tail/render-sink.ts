/**
 * A render-side projection fed by the tailer's SINGLE per-commit Markdown render.
 *
 * The projection tailer renders each affected page exactly ONCE per commit (ADR-M3) and
 * fans the resulting {@link SearchDoc}s out to every sink — the full-text search index and
 * (later) the Markdown-disk mirror both consume the same docs instead of each re-rendering.
 * A {@link SearchDoc} already carries everything a disk mirror needs per page (`pageId`,
 * `type`, `status`, `archived`, `title`, and `body` = the deterministic Markdown); the full
 * folded {@link IWorkspaceState} rides alongside for sinks that need the tree (path mapping,
 * orphan reconciliation).
 *
 * Sinks are BEST-EFFORT: a sink failure is caught by the tailer, surfaced via {@link fail}
 * (so token-gated waiters fast-fail rather than time out), and NEVER halts projection — the
 * durable write already committed.
 */
import { decodeToken } from "wiki";
import type { ISearchIndex, IWorkspaceState, PageId, SearchDoc, WorkspaceId } from "wiki";

export interface RenderSink {
  /** A short name for the tailer's log lines (e.g. `"search"`, `"markdown-disk"`). */
  readonly name: string;
  /**
   * When `true`, the tailer feeds this sink a WHOLE-workspace render (via {@link rebuild})
   * for any STRUCTURAL commit — one that can move a page's title/existence/tree position —
   * instead of the affected-only delta. A path-mapping sink (the Markdown-disk mirror) needs
   * this because a structural change can move a whole subtree's paths beyond the directly
   * touched pages. A doc-only sink (search, keyed by page id) leaves this falsy and always
   * takes the cheaper {@link applyDelta}. @default false
   */
  readonly rebuildOnStructural?: boolean;
  /** The sink's applied version for `workspace` (0 / the zero position if unknown). */
  appliedVersion(workspace: WorkspaceId): Promise<number>;
  /**
   * Apply a commit's rendered delta: upsert `docs` (the pages re-rendered this commit) and
   * drop `removed` (pages that left the workspace), advancing to `version`. `state` is the
   * full folded workspace at `version` — used by sinks that need the tree (path mapping,
   * orphan reconcile); doc-only sinks (search) ignore it.
   */
  applyDelta(
    workspace: WorkspaceId,
    version: number,
    docs: readonly SearchDoc[],
    removed: readonly PageId[],
    state: IWorkspaceState,
  ): Promise<void>;
  /**
   * Rebuild from a WHOLE-workspace render — used when the sink has fallen behind the commit
   * (a dropped best-effort update, a fresh/rebuilt sink). `docs` is every live page; `state`
   * is the matching folded workspace.
   */
  rebuild(
    workspace: WorkspaceId,
    version: number,
    docs: readonly SearchDoc[],
    state: IWorkspaceState,
  ): Promise<void>;
  /** Surface a best-effort failure to `version` so token-gated waiters fast-fail. */
  fail(workspace: WorkspaceId, version: number, err: unknown): void;
}

/**
 * The full-text search index as a {@link RenderSink}. A thin adapter over {@link ISearchIndex}:
 * it consumes the shared per-commit render (ignoring `state`, which it does not need) and maps
 * the sink contract onto the index's `update` (delta) / `reconcile` (rebuild) / `fail` surface.
 */
export class SearchRenderSink implements RenderSink {
  readonly name = "search";

  constructor(private readonly index: ISearchIndex) {}

  async appliedVersion(workspace: WorkspaceId): Promise<number> {
    return decodeToken(await this.index.appliedToken(workspace)).version;
  }

  async applyDelta(
    workspace: WorkspaceId,
    version: number,
    docs: readonly SearchDoc[],
    removed: readonly PageId[],
  ): Promise<void> {
    await this.index.update(workspace, version, docs, removed);
  }

  async rebuild(workspace: WorkspaceId, version: number, docs: readonly SearchDoc[]): Promise<void> {
    await this.index.reconcile(workspace, version, docs);
  }

  fail(workspace: WorkspaceId, version: number, err: unknown): void {
    this.index.fail(workspace, version, err);
  }
}
