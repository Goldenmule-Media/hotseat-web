/**
 * The full-text search index — types + Kysely schema (the engine's first
 * content-bearing read projection). The engine depends ONLY on Kysely; the container
 * injects a `Kysely<WikiSearchDatabase>` over a Postgres-compatible database (pg or
 * PGlite). One `search_doc` row per page holds the page's deterministic Markdown
 * render and a generated `tsvector`; `search_offset` is the per-workspace consistency
 * cursor. Full-text uses Postgres FTS (`to_tsvector` / `websearch_to_tsquery` /
 * `ts_rank` / `ts_headline`) pinned to {@link SEARCH_CONFIG} so pg and PGlite agree.
 */
import type { GeneratedAlways } from "kysely";

import type { ConsistencyToken, WorkspaceId } from "../api";

/**
 * The pinned text-search configuration (regconfig). MUST match the literal baked into
 * the generated `tsv` column in the search migration — change both together, behind a
 * new migration, so the index stays self-consistent.
 */
export const SEARCH_CONFIG = "english";

/** One indexed document per page: its rendered Markdown body + a generated tsvector. */
export interface SearchDocTable {
  workspace_id: string;
  page_id: string;
  type: string;
  status: string;
  archived: boolean;
  title: string;
  /** The page's deterministic `renderPage` Markdown — the indexed document. The render
   *  already emits the title as its H1, so the title is searchable through `body` alone. */
  body: string;
  /** The workspace version this row was indexed at. */
  version: number;
  /** Generated `to_tsvector(SEARCH_CONFIG, body)`; never written from JS. The title is NOT
   *  concatenated separately — it is already the H1 of `body`, so concatenating it would
   *  double-count it AND desync the match from the `ts_headline` snippet (also over body). */
  tsv: GeneratedAlways<string>;
}

/** The per-workspace applied cursor (mirrors the read model's `projection_offsets`). */
export interface SearchOffsetTable {
  workspace_id: string;
  applied_version: number;
}

/** The Kysely database shape the engine's search index owns. */
export interface WikiSearchDatabase {
  search_doc: SearchDocTable;
  search_offset: SearchOffsetTable;
}

/** A page's indexable projection, handed to {@link ISearchIndex.reconcile}. */
export interface SearchDoc {
  readonly pageId: string;
  readonly type: string;
  readonly status: string;
  readonly archived: boolean;
  readonly title: string;
  /** The rendered Markdown body. */
  readonly body: string;
  readonly version: number;
}

/** One ranked search result: a page plus a highlighted snippet. */
export interface SearchHit {
  readonly workspaceId: string;
  readonly pageId: string;
  readonly title: string;
  readonly type: string;
  readonly status: string;
  /** A `ts_headline` excerpt of the body with the match terms wrapped in `**`. */
  readonly snippet: string;
  /** The `ts_rank` relevance score (higher = better). */
  readonly rank: number;
}

/** Options for a search query. */
export interface SearchQueryOpts {
  /** Max hits to return. @default 20 */
  readonly limit?: number;
  /** Read-your-writes: wait for the index to apply this write token before querying. */
  readonly consistentWith?: ConsistencyToken;
  /** Override the default `waitFor` timeout (ms) when `consistentWith` is set. */
  readonly timeoutMs?: number;
}

/**
 * The engine's search-index seam. Maintenance is driven off the fold via two paths:
 * `reconcile` rebuilds a workspace wholesale (initial index / catch-up after a gap),
 * `update` applies a per-commit delta (re-index only the pages a commit affected, the
 * steady-state path). `query` answers ranked full-text searches; `appliedToken`/`waitFor`
 * give the same token-gated read-your-writes the rest of the read side has.
 */
export interface ISearchIndex {
  /** The index's applied position for a workspace (the zero token if unknown). */
  appliedToken(workspace: WorkspaceId): Promise<ConsistencyToken>;
  /** Resolve once the index has applied ≥ `token`; reject on timeout. */
  waitFor(token: ConsistencyToken, opts?: { timeoutMs?: number }): Promise<void>;
  /** Replace a workspace's indexed documents with exactly `docs`, advancing to `version`. */
  reconcile(workspace: WorkspaceId, version: number, docs: readonly SearchDoc[]): Promise<void>;
  /**
   * Apply a per-commit delta: upsert `docs` (the pages this commit re-rendered) and
   * delete `removed` (pages that left the workspace), advancing to `version`. Unlike
   * {@link reconcile} it does NOT touch untouched rows, so the cost is O(affected),
   * not O(workspace). Advances the cursor even when both lists are empty.
   */
  update(
    workspace: WorkspaceId,
    version: number,
    docs: readonly SearchDoc[],
    removed: readonly string[],
  ): Promise<void>;
  /** Full-text search across `workspaces`, ranked, with highlighted snippets. */
  query(workspaces: readonly WorkspaceId[], query: string, opts?: SearchQueryOpts): Promise<readonly SearchHit[]>;
  /**
   * Signal that a best-effort reindex to `version` FAILED. Rejects token-gated waiters the
   * failed target would have satisfied (fast-fail vs a silent timeout) and remembers it so a
   * `waitFor` arriving later also fails fast — until the next successful `reconcile`/`update`
   * (recovery) or `forget`. The durable write itself succeeded; an eventually-consistent
   * (token-less) search still works, so callers should retry without a token.
   */
  fail(workspace: WorkspaceId, version: number, err: unknown): void;
  /** Drop a workspace's in-memory waiters (on handle teardown). */
  forget(workspace: WorkspaceId): void;
}

/** Injected search configuration on {@link IWikiConfig.search}. */
export interface IWikiSearchConfig {
  /** The container-provided Kysely handle (pg or PGlite). Migrate it before use. */
  readonly db: import("kysely").Kysely<WikiSearchDatabase>;
  /** Default `waitFor` timeout (ms) for token-gated search; falls back to the read timeout. */
  readonly readConsistencyTimeoutMs?: number;
  /**
   * Optional observation hook invoked (best-effort) when a page fails to render during
   * indexing — the page is still indexed, but with an EMPTY body (so it drops out of
   * full-text search until its next successful re-index). Surfaces an otherwise-silent
   * drift between the search index and the fold. Must not throw; if it does, the throw is
   * swallowed so it can never abort indexing.
   */
  readonly onRenderError?: (pageId: string, err: unknown) => void;
}
