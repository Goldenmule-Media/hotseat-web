# Implementation plan

**Status:** ready

## Steps
- [ ] Engine — search schema + migration (new `wiki/src/search/` module; add `kysely` as a `wiki` dependency — the engine's only new dep). Define a typed `WikiSearchDatabase` with `search_doc` (PK `(workspace_id, page_id)`; `type`, `status`, `archived`, `title`, `body` = the rendered Markdown, `tsv` tsvector, `version`), a GIN index on `tsv`, and `search_offset` (`workspace_id` PK, `applied_version`) as the token-gating cursor. Ship it as a Kysely `Migrator` `migrationProvider` mirroring `wiki-mcp/src/readmodel/store.ts` + `readmodel/migrations/`, and export a `migrateSearchToLatest(db)` so any container runs it. `tsv` is `to_tsvector(SEARCH_CONFIG, title || ' ' || body)`, maintained in the upsert; pin `SEARCH_CONFIG` to one constant — the versioned determinism knob (constraint #6). The engine depends on Kysely only; it never imports pg or PGlite.
- [ ] Engine — `ISearchIndex` + `SqlSearchIndex` over the injected Kysely (`wiki/src/search/search-index.ts`). `ISearchIndex` extends the existing `IReadModel` shape (`appliedToken(ws)` / `waitFor(token)`, from `api.ts:80`) and adds `indexPages(state, pageIds)`, `removePages(ws, pageIds)`, and `query(workspaces, q, opts) → SearchHit[]`. Implement `SqlSearchIndex` against `Kysely<WikiSearchDatabase>`: `indexPages` renders each page via `renderPage(state, id, registry)` (`wiki/src/render/read-model.ts:194`) and upserts its `search_doc` row, then bumps `search_offset`; `query` compiles `q` with `websearch_to_tsquery(SEARCH_CONFIG, q)` and runs `ORDER BY ts_rank(tsv, q) DESC`, returning id/title/type/status/rank plus a `ts_headline(SEARCH_CONFIG, body, q)` snippet, filtered to non-archived rows in the given workspaces. Pure Postgres SQL — identical on pg and PGlite. Unit-test the index in isolation over an in-memory PGlite.
- [ ] Engine — injection seam + query API (`wiki/src/api.ts`, `core/wiki.ts`). Extend `IWikiConfig` (`api.ts:280`) with optional `search?: { db: Kysely<WikiSearchDatabase> }` — the container injects the DB; when absent, wire a disabled no-op index so the engine still runs with search off. In `createWiki` (`core/wiki.ts:130`) build a `SqlSearchIndex` from `config.search.db` and pass it into `Wiki` alongside the existing `InMemoryReadModel`. Add token-gated `IWorkspaceHandle.search(query, opts?)` and a cross-workspace `IWiki.search(query, opts?)` that fans out and `waitFor`s each workspace's applied token before querying (the read-your-writes seam both wiki-ui and wiki-mcp call). Re-export `ISearchIndex`, `SearchHit`, `WikiSearchDatabase`, `SEARCH_CONFIG` from `wiki/src/index.ts`.
- [ ] Engine — drive the index off the fold (`core/wiki.ts`). At each site where the handle advances its projection and calls `readModel.notifyApplied(...)` — open/catch-up (`:324`), live tail (`:406`), post-commit (`:562`) — also hand the search index the pages whose `version` changed since its `search_offset`: `indexPages` (render + upsert) for changed/added pages, `removePages` for deleted pages, and treat `archived` the same visibility flag the tree uses. This runs after the durable append, on the read side, so it never gates the write (constraint #4). A cold or empty index triggers a full reindex by folding the stream with `foldWorkspace(events, registry)` (constraint #3: derived, rebuildable). Unit-test against `feature-brief`: editing the summary reindexes the row; archiving drops it; a query matches body text that is absent from the title.
- [ ] wiki-mcp — inject the DB and migrate (no new tail). Pass the existing `buildStore(config).db` Kysely (`wiki-mcp/src/readmodel/store.ts`) into `createWiki({ …, search: { db } })` so the engine's `search_doc`/`search_offset` tables live beside the read-model tables in the SAME PGlite/pg instance, and call the engine's `migrateSearchToLatest(db)` next to the existing `migrateToLatest`. The projection tailer (`wiki-mcp/src/tail/projection.ts`) already folds each commit through the engine handle, so indexing rides the same advance — there is no second event loop. One Kysely, one database; the index logic is the engine's, the host only owns the connection (the ADR-M5 line).
- [ ] wiki-mcp `search` tool + wiki-ui + verify. Rewrite `searchTool` (`wiki-mcp/src/mcp/tools.ts:650`) from title-substring to engine full-text: keep the signature (`{ query, workspaceId? }`) and the `awaitAllConsistency` fan-out + token gating (`tools.ts:116`/`:125`); call the engine `search`/read-model `query` and return ranked hits `{ workspaceId, pageId, title, type, status, snippet, rank }` with the `ts_headline` snippet inline; update the tool description. In wiki-ui, construct a PGlite-on-IndexedDB Kysely and pass it as `search.db` to the in-browser `createWiki`; add a search box that calls `handle.search`, lists ranked snippet hits, and on click opens the page and scrolls to the match (its nearest preceding heading in the render). Verify: `npm run typecheck` clean; `npm run test -w wiki` and `-w wiki-mcp` green; app smoke-check (a content-only query returns a body hit with a highlighted snippet that navigates to its section).

## Data models & interfaces
```typescript
// ── Engine: injected Kysely schema (wiki/src/search/schema.ts) ──
// One document per page = its deterministic renderPage() Markdown, plus a tsvector.
export interface SearchDocTable {
  workspace_id: string;
  page_id: string;            // (workspace_id, page_id) is the PK
  type: string;
  status: string;
  archived: boolean;
  title: string;
  body: string;               // the rendered Markdown — the indexed document
  tsv: string;                // tsvector: to_tsvector(SEARCH_CONFIG, title || ' ' || body)
  version: number;            // page version last indexed
}
export interface SearchOffsetTable {
  workspace_id: string;       // PK — token-gating cursor (mirrors projection_offsets)
  applied_version: number;
}
export interface WikiSearchDatabase {
  search_doc: SearchDocTable;
  search_offset: SearchOffsetTable;
}
export const SEARCH_CONFIG = 'english';   // pinned regconfig — the determinism knob (constraint #6)

// ── Engine: the index seam, bundled in wiki/ (wiki/src/search/search-index.ts) ──
export interface SearchHit {
  readonly workspaceId: string;
  readonly pageId: string;
  readonly title: string;
  readonly type: string;
  readonly status: string;
  readonly snippet: string;   // ts_headline over body, match terms highlighted
  readonly rank: number;      // ts_rank
}
export interface SearchQueryOpts { readonly limit?: number; readonly consistentWith?: ConsistencyToken }
export interface ISearchIndex extends IReadModel {        // adds query + maintenance to appliedToken/waitFor
  indexPages(state: IWorkspaceState, pageIds: readonly PageId[]): Promise<void>;
  removePages(workspace: WorkspaceId, pageIds: readonly PageId[]): Promise<void>;
  query(workspaces: readonly WorkspaceId[], q: string, opts?: SearchQueryOpts): Promise<readonly SearchHit[]>;
}

// ── Engine: container injects the DB; absent => disabled (wiki/src/api.ts) ──
interface IWikiConfig {
  // ...stream, pageTypes, clock, ids, ...
  readonly search?: { readonly db: Kysely<WikiSearchDatabase> };   // pg / PGlite, injected by the container
}
interface IWorkspaceHandle { search(query: string, opts?: SearchQueryOpts): Promise<readonly SearchHit[]>; }
interface IWiki { search(query: string, opts?: { workspaces?: WorkspaceId[]; limit?: number }): Promise<readonly SearchHit[]>; }

// ── Core query SQL (uniform on pg and PGlite) ──
//   const q = websearch_to_tsquery(SEARCH_CONFIG, query);
//   select ..., ts_rank(tsv, q) as rank,
//          ts_headline(SEARCH_CONFIG, body, q, 'MaxFragments=2,MinWords=5,MaxWords=18') as snippet
//     from search_doc
//    where tsv @@ q and workspace_id = any(workspaces) and not archived
//    order by rank desc limit (opts.limit ?? 20);
```

## Open questions
_None._

## Resolved questions
_None._

## References
_None._

## Child pages
_None._
