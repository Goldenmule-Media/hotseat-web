/**
 * {@link SqlSearchIndex} — the engine's Kysely-backed full-text search index. Pure
 * Postgres SQL (`to_tsquery` / `websearch_to_tsquery` / `ts_rank` / `ts_headline`),
 * identical on pg and PGlite. `reconcile` replaces a workspace's documents wholesale;
 * `update` applies a per-commit delta (only the pages a commit touched); `query` answers
 * ranked searches with highlighted snippets. Consistency mirrors the default read model:
 * an in-memory applied-version map + parked `waitFor`s, released as the index advances —
 * so token-gated search is read-your-writes. The map is durable across restarts: it is
 * hydrated lazily from `search_offset` (written in the same transaction as the docs), so
 * a token threaded after a restart resolves from the persisted cursor instead of hanging.
 */
import { sql, type Kysely, type RawBuilder, type SqlBool, type Transaction } from "kysely";

import type { ConsistencyToken, WorkspaceId } from "../api";
import { SearchIndexUnavailableError } from "../core/errors";
import { decodeToken, ZERO_VERSION } from "../core/readmodel";
import { VersionWaiterRegistry } from "../core/version-waiters";
import {
  SEARCH_CONFIG,
  type ISearchIndex,
  type SearchDoc,
  type SearchHit,
  type SearchQueryOpts,
  type WikiSearchDatabase,
} from "./schema";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_LIMIT = 20;

export class SqlSearchIndex implements ISearchIndex {
  /** Applied-version + parked-waiter machinery, shared with the in-memory read model. */
  private readonly registry: VersionWaiterRegistry;
  /**
   * In-flight `search_offset` hydration per workspace (memoised). Concurrent first-readers
   * await the SAME promise, so none reads a stale empty cursor before the row lands; a
   * rejected read deletes its entry so a transient DB blip can re-hydrate.
   */
  private readonly hydrating = new Map<string, Promise<void>>();

  // Build the registry in the CONSTRUCTOR BODY, never as a field initializer (a field
  // initializer runs before the parameter-property is assigned → captures undefined).
  constructor(
    private readonly db: Kysely<WikiSearchDatabase>,
    private readonly defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {
    this.registry = new VersionWaiterRegistry(defaultTimeoutMs);
  }

  // ── consistency (shared registry; durable via search_offset) ──────────────────

  async appliedToken(workspace: WorkspaceId): Promise<ConsistencyToken> {
    await this.ensureHydrated(workspace);
    return this.registry.appliedToken(workspace);
  }

  async waitFor(token: ConsistencyToken, opts?: { timeoutMs?: number }): Promise<void> {
    const { workspaceId } = decodeToken(token);
    await this.ensureHydrated(workspaceId);
    return this.registry.waitFor(token, opts);
  }

  /**
   * Seed the registry's applied version for `workspace` from its persisted `search_offset`
   * the first time it is consulted — so a process that restarts (in-memory state empty)
   * still reports the durable cursor and doesn't park `waitFor`s already satisfied on disk.
   * The in-flight read is MEMOISED ({@link hydrating}) so concurrent first-readers await
   * the SAME promise and none reads a stale empty cursor before the row lands; a rejected
   * read deletes its entry so a transient DB error can re-hydrate. The maintenance paths
   * advance applied via `registry.notifyApplied` (without touching `hydrating`), so
   * `appliedVersion > 0` is the correct short-circuit. A workspace with no offset row leaves
   * applied at zero: the resolved promise is cached and returned (a version-0 token is
   * trivially satisfied, so this is correct, not a leak).
   */
  private ensureHydrated(workspace: string): Promise<void> {
    if (this.registry.appliedVersion(workspace as WorkspaceId) > ZERO_VERSION) return Promise.resolve();
    const existing = this.hydrating.get(workspace);
    if (existing !== undefined) return existing;
    const p = (async (): Promise<void> => {
      try {
        const row = await this.db
          .selectFrom("search_offset")
          .select("applied_version")
          .where("workspace_id", "=", workspace)
          .executeTakeFirst();
        if (row !== undefined) {
          // Seed the durable cursor. notifyApplied clears any stale failure the cursor COVERS
          // (version >= the marker); a failure recorded for a LATER version (a newer reindex
          // that failed during this in-flight read) survives, so its token still fast-fails.
          this.registry.notifyApplied(workspace as WorkspaceId, row.applied_version);
        }
      } catch (err) {
        this.hydrating.delete(workspace); // transient DB blip → allow a later re-hydrate
        throw err;
      }
    })();
    this.hydrating.set(workspace, p);
    return p;
  }

  // ── maintenance ─────────────────────────────────────────────────────────────

  /** Replace a workspace's documents with exactly `docs` (whole-workspace rebuild). */
  async reconcile(workspace: WorkspaceId, version: number, docs: readonly SearchDoc[]): Promise<void> {
    const ids = docs.map((d) => d.pageId);
    await this.db.transaction().execute(async (trx) => {
      // Drop any indexed page that no longer exists in the workspace (delete/reparent-away).
      // NOTE: `not in (ids)` inlines one bound param per surviving page_id — safe at wiki
      // scale (tens of pages). Past pg's ~65535-param ceiling, switch to a chunked delete /
      // anti-join / delete-all-then-insert in this same transaction.
      let del = trx.deleteFrom("search_doc").where("workspace_id", "=", workspace);
      if (ids.length > 0) del = del.where("page_id", "not in", ids);
      await del.execute();
      await this.writeDocs(trx, workspace, docs);
      await this.writeOffset(trx, workspace, version);
    });
    this.registry.notifyApplied(workspace, version);
  }

  /** Apply a per-commit delta: upsert `docs`, delete `removed`, advance to `version`. */
  async update(
    workspace: WorkspaceId,
    version: number,
    docs: readonly SearchDoc[],
    removed: readonly string[],
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      if (removed.length > 0) {
        await trx
          .deleteFrom("search_doc")
          .where("workspace_id", "=", workspace)
          .where("page_id", "in", removed as readonly string[])
          .execute();
      }
      await this.writeDocs(trx, workspace, docs);
      // Advance the cursor even with no doc changes, so token-gated reads still release.
      await this.writeOffset(trx, workspace, version);
    });
    this.registry.notifyApplied(workspace, version);
  }

  /**
   * Upsert the docs in ONE multi-row statement (shared by `reconcile` + `update`). On
   * conflict each column is copied from the `excluded` pseudo-table — which also
   * regenerates the STORED `tsv` column from the new `body`.
   *
   * NOTE: one multi-row INSERT binds (columns × rows) parameters, so pg's ~65535
   * bound-param ceiling caps this at ~8191 pages per call on a wholesale reconcile. Past
   * that, chunk `values` into batches (e.g. 1000 rows) inside this same transaction.
   */
  private async writeDocs(
    trx: Transaction<WikiSearchDatabase>,
    workspace: WorkspaceId,
    docs: readonly SearchDoc[],
  ): Promise<void> {
    if (docs.length === 0) return; // Kysely `.values([])` builds an invalid empty INSERT (throws)
    const values = docs.map((d) => ({
      workspace_id: workspace,
      page_id: d.pageId,
      type: d.type,
      status: d.status,
      archived: d.archived,
      title: d.title,
      body: d.body,
      version: d.version,
    }));
    await trx
      .insertInto("search_doc")
      .values(values)
      .onConflict((oc) =>
        oc.columns(["workspace_id", "page_id"]).doUpdateSet((eb) => ({
          type: eb.ref("excluded.type"),
          status: eb.ref("excluded.status"),
          archived: eb.ref("excluded.archived"),
          title: eb.ref("excluded.title"),
          body: eb.ref("excluded.body"),
          version: eb.ref("excluded.version"),
        })),
      )
      .execute();
  }

  /** Persist the per-workspace applied cursor (read back by {@link ensureHydrated}). */
  private async writeOffset(
    trx: Transaction<WikiSearchDatabase>,
    workspace: WorkspaceId,
    version: number,
  ): Promise<void> {
    await trx
      .insertInto("search_offset")
      .values({ workspace_id: workspace, applied_version: version })
      .onConflict((oc) => oc.column("workspace_id").doUpdateSet({ applied_version: version }))
      .execute();
  }

  // ── query ─────────────────────────────────────────────────────────────────────

  async query(
    workspaces: readonly WorkspaceId[],
    query: string,
    opts?: SearchQueryOpts,
  ): Promise<readonly SearchHit[]> {
    if (workspaces.length === 0) return [];
    if (opts?.consistentWith !== undefined) {
      await this.waitFor(
        opts.consistentWith,
        opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : undefined,
      );
    }
    // Clamp the limit to a positive integer: a 0 / negative / fractional limit must never
    // reach SQL (`LIMIT 0` silently returns nothing; a negative or float LIMIT errors).
    const rawLimit = opts?.limit;
    const limit = typeof rawLimit === "number" && Number.isFinite(rawLimit) ? Math.max(1, Math.floor(rawLimit)) : DEFAULT_LIMIT;

    const tsquery = this.tsQuery(query);
    const match = sql<SqlBool>`tsv @@ ${tsquery}`;
    const rank = sql<number>`ts_rank(tsv, ${tsquery})`;
    const snippet = sql<string>`ts_headline(${SEARCH_CONFIG}::regconfig, body, ${tsquery}, 'StartSel=**,StopSel=**,MaxFragments=2,MinWords=4,MaxWords=18,FragmentDelimiter= … ')`;

    const rows = await this.db
      .selectFrom("search_doc")
      .select(["workspace_id", "page_id", "title", "type", "status"])
      .select(rank.as("rank"))
      .select(snippet.as("snippet"))
      .where("workspace_id", "in", workspaces as readonly string[])
      .where("archived", "=", false)
      .where(match)
      // Deterministic order: rank first, then the (workspace_id, page_id) PK as a TOTAL
      // tiebreaker so equal-rank rows never reorder run-to-run (or pg vs PGlite) and the
      // LIMIT cut keeps the same hits. workspace_id leads because a query can span many.
      .orderBy(sql`rank`, "desc")
      .orderBy("workspace_id")
      .orderBy("page_id")
      .limit(limit)
      .execute();

    return rows.map((r) => ({
      workspaceId: r.workspace_id,
      pageId: r.page_id,
      title: r.title,
      type: r.type,
      status: r.status,
      snippet: r.snippet,
      rank: Number(r.rank),
    }));
  }

  /**
   * Build the `tsquery` for a user query. Full-text matching (via the `english` config) is
   * always case-insensitive. A SIMPLE query (only words/numbers/spaces — the common case)
   * becomes a case-insensitive PREFIX match per term (`foo:* & bar:*`), so typing part of
   * a word still finds it ("concur" → "concurrency"), restoring the forgiving feel of the
   * old substring search. A query using web operators (quoted "phrases", OR, -excluded)
   * is handed to `websearch_to_tsquery` to honor that syntax.
   */
  private tsQuery(query: string): RawBuilder<unknown> {
    const trimmed = query.trim();
    const simple = trimmed.length > 0 && /^[\p{L}\p{N}\s]+$/u.test(trimmed);
    if (simple) {
      const prefixed = trimmed
        .split(/\s+/)
        .map((term) => `${term}:*`)
        .join(" & ");
      return sql`to_tsquery(${SEARCH_CONFIG}::regconfig, ${prefixed})`;
    }
    return sql`websearch_to_tsquery(${SEARCH_CONFIG}::regconfig, ${query})`;
  }

  // ── consistency failure signal (best-effort reindex failed; DESIGN — search seam) ──

  /**
   * A best-effort reindex to `version` FAILED. Reject token-gated waiters the failed
   * target would have satisfied (fast-fail vs a silent timeout) and remember it so a
   * later waiter also fails fast, wrapping the raw cause in a
   * {@link SearchIndexUnavailableError} (a `WikiError`, so the MCP boundary maps it by
   * `code`). The durable write succeeded; the next successful {@link reconcile}/{@link update}
   * clears the marker (recovery), as does {@link forget} and a hydrated durable cursor.
   */
  fail(workspace: WorkspaceId, version: number, err: unknown): void {
    this.registry.failWaiters(workspace, version, new SearchIndexUnavailableError(workspace, version, err));
  }

  // ── teardown ────────────────────────────────────────────────────────────────

  /** Forget a workspace: drop its in-flight hydration and REJECT any parked waiters. */
  forget(workspace: WorkspaceId): void {
    this.hydrating.delete(workspace);
    this.registry.forget(workspace);
  }
}
