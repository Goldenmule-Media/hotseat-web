/**
 * The SQL-backed {@link IReadModel} (DESIGN §3.3, §5). Implements the engine's
 * read-side seam against `projection_offsets` + the projected tables.
 *
 * - `appliedToken(ws)` reads `projection_offsets.applied_version` and encodes it
 *   with the engine's PUBLIC token codec, so it is comparable to a write's token.
 * - `waitFor(token)` resolves once `applied_version >= token.version`. In the v1
 *   single-process topology the tailer that writes SQL and the reader that serves
 *   `waitFor` share one process, so an **in-process notify-on-commit** wakes waiters
 *   with a short **poll** as backstop (§5.2). It rejects with the engine's
 *   `ConsistencyTimeoutError` after `timeoutMs`, and with a non-retryable error if
 *   the workspace's projection has **halted** (§3.3, §9).
 *
 * Plus the typed read queries the MCP surface serves (§5): page, tree, links,
 * events, workspace summaries — current state, token-gated by the caller via
 * `waitFor` first.
 */
import {
  ConsistencyTimeoutError,
  decodeToken,
  encodeToken,
  type ConsistencyToken,
  type IReadModel,
  type WorkspaceId,
} from "wiki";
import type { Kysely, Selectable } from "kysely";

import type {
  EventsTable,
  LinksTable,
  OutlineTable,
  PagesTable,
  ReadModelDatabase,
  ReferenceIndexTable,
  SymbolIndexTable,
  TreeEdgesTable,
  WorkspacesTable,
} from "./schema.js";

/** Selectable row shapes (JSONB columns come back parsed by the dialect/our reads). */
export type WorkspaceRow = Selectable<WorkspacesTable>;
export type PageRow = Selectable<PagesTable>;
export type TreeEdgeRow = Selectable<TreeEdgesTable>;
export type LinkRow = Selectable<LinksTable>;
export type EventRow = Selectable<EventsTable>;
export type OutlineRow = Selectable<OutlineTable>;
export type SymbolRow = Selectable<SymbolIndexTable>;
export type ReferenceRow = Selectable<ReferenceIndexTable>;

/** Tuning knobs for the read model's `waitFor` backstop poll + default timeout. */
export interface ReadModelOptions {
  /** Default `waitFor` timeout (ms) (§3.3). */
  readonly defaultTimeoutMs: number;
  /** Backstop poll interval (ms) for `waitFor` when no notify fires (§5.2). */
  readonly pollMs: number;
}

/**
 * SQL read model. Constructed over an open Kysely store; the projection tailer
 * calls {@link notifyApplied} after each committed apply so parked `waitFor`s wake
 * immediately, and {@link halt} marks a workspace whose projection failed closed.
 */
export class SqlReadModel implements IReadModel {
  /** Workspaces whose projection has halted → `waitFor` rejects non-retryably (§9). */
  private readonly halted = new Map<WorkspaceId, Error>();

  constructor(
    private readonly db: Kysely<ReadModelDatabase>,
    private readonly options: ReadModelOptions,
  ) {}

  // ── IReadModel ──────────────────────────────────────────────────────────────

  async appliedToken(workspace: WorkspaceId): Promise<ConsistencyToken> {
    const version = await this.readAppliedVersion(workspace);
    // An unknown workspace is the zero token (§3.3).
    return encodeToken(workspace, version < 0 ? 0 : version);
  }

  async waitFor(token: ConsistencyToken, opts?: { timeoutMs?: number }): Promise<void> {
    const { workspaceId, version } = decodeToken(token);
    const timeoutMs = opts?.timeoutMs ?? this.options.defaultTimeoutMs;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const halt = this.halted.get(workspaceId);
      if (halt !== undefined) throw halt;

      const applied = await this.readAppliedVersion(workspaceId);
      if (applied >= version) return;

      if (Date.now() >= deadline) {
        throw new ConsistencyTimeoutError(token, timeoutMs);
      }
      // Backstop poll: in v1 the tailer shares this process, but we still poll so a
      // missed in-process notify can't hang the waiter past the deadline (§5.2).
      const remaining = deadline - Date.now();
      await delay(Math.min(this.options.pollMs, Math.max(1, remaining)));
    }
  }

  // ── feed side (called by the projection tailer) ──────────────────────────────

  /**
   * Hook for an in-process notify-on-commit (§5.2). The poll loop already converges,
   * so this is a latency optimization, not a correctness requirement; kept as a
   * no-op seam the tailer may call after each commit. (A future revision can wake
   * parked promises directly.)
   */
  notifyApplied(_workspace: WorkspaceId, _version: number): void {
    // Intentionally a no-op: `waitFor` re-reads `applied_version` on its next poll.
  }

  /** Mark a workspace's projection as halted; pending/future `waitFor`s reject (§9). */
  halt(workspace: WorkspaceId, cause: Error): void {
    this.halted.set(workspace, cause);
  }

  /** Clear a halt (e.g. after registering a missing page type and rebuilding). */
  resume(workspace: WorkspaceId): void {
    this.halted.delete(workspace);
  }

  // ── typed read queries (§5) ──────────────────────────────────────────────────

  /** All workspace summaries (for `listWorkspaces`). */
  async listWorkspaces(): Promise<WorkspaceRow[]> {
    return this.db.selectFrom("workspaces").selectAll().orderBy("id").execute();
  }

  /** One page row, or `undefined` if unknown. */
  async getPage(workspace: WorkspaceId, pageId: string): Promise<PageRow | undefined> {
    return this.db
      .selectFrom("pages")
      .selectAll()
      .where("workspace_id", "=", workspace)
      .where("id", "=", pageId)
      .executeTakeFirst();
  }

  /** All pages in a workspace. */
  async listPages(workspace: WorkspaceId): Promise<PageRow[]> {
    return this.db.selectFrom("pages").selectAll().where("workspace_id", "=", workspace).orderBy("id").execute();
  }

  /** The ordered tree edges for a workspace (parent → child, by `ord`). */
  async treeEdges(workspace: WorkspaceId): Promise<TreeEdgeRow[]> {
    return this.db
      .selectFrom("tree_edges")
      .selectAll()
      .where("workspace_id", "=", workspace)
      .orderBy("parent_id")
      .orderBy("ord")
      .execute();
  }

  /** The links for a workspace. */
  async links(workspace: WorkspaceId): Promise<LinkRow[]> {
    return this.db.selectFrom("links").selectAll().where("workspace_id", "=", workspace).execute();
  }

  /** The event log for a workspace, in version order. */
  async events(workspace: WorkspaceId): Promise<EventRow[]> {
    return this.db.selectFrom("events").selectAll().where("workspace_id", "=", workspace).orderBy("version").execute();
  }

  // ── derived projections (§6) ──────────────────────────────────────────────────

  /**
   * The outline rows for a page (the section tree, §6.1) — ordered by `(parent, ord)`
   * so a caller can rebuild the nested tree deterministically.
   */
  async outline(workspace: WorkspaceId, pageId: string): Promise<OutlineRow[]> {
    return this.db
      .selectFrom("outline")
      .selectAll()
      .where("workspace_id", "=", workspace)
      .where("page_id", "=", pageId)
      .orderBy("parent_section_id")
      .orderBy("ord")
      .execute();
  }

  /**
   * Symbols in a workspace (§6.2), optionally scoped to one page and/or filtered by
   * exact `name` / `kind`. Stub (analyzer-less) rows have null `name`/`kind`, so a
   * name/kind filter naturally excludes them. Ordered for determinism.
   */
  async symbols(
    workspace: WorkspaceId,
    filter?: { pageId?: string; name?: string; kind?: string },
  ): Promise<SymbolRow[]> {
    let q = this.db.selectFrom("symbol_index").selectAll().where("workspace_id", "=", workspace);
    if (filter?.pageId !== undefined) q = q.where("page_id", "=", filter.pageId);
    if (filter?.name !== undefined) q = q.where("name", "=", filter.name);
    if (filter?.kind !== undefined) q = q.where("kind", "=", filter.kind);
    return q
      .orderBy("page_id")
      .orderBy("section_id")
      .orderBy("field")
      .orderBy("def_start")
      .execute();
  }

  /**
   * In-source references to identifier `name` in a workspace (§6.2), optionally scoped
   * to one page. Resolution to a specific declaration is Phase 3; this is the
   * by-name where-used index. Ordered for determinism.
   */
  async references(
    workspace: WorkspaceId,
    name: string,
    filter?: { pageId?: string },
  ): Promise<ReferenceRow[]> {
    let q = this.db
      .selectFrom("reference_index")
      .selectAll()
      .where("workspace_id", "=", workspace)
      .where("name", "=", name);
    if (filter?.pageId !== undefined) q = q.where("page_id", "=", filter.pageId);
    return q
      .orderBy("page_id")
      .orderBy("section_id")
      .orderBy("field")
      .orderBy("ref_start")
      .execute();
  }

  // ── internals ────────────────────────────────────────────────────────────────

  /** Applied version for a workspace, or `-1` if it has never been projected. */
  private async readAppliedVersion(workspace: WorkspaceId): Promise<number> {
    const row = await this.db
      .selectFrom("projection_offsets")
      .select("applied_version")
      .where("workspace_id", "=", workspace)
      .executeTakeFirst();
    return row?.applied_version ?? -1;
  }
}

/** Promise-based delay (host timer; not determinism-sensitive). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}
