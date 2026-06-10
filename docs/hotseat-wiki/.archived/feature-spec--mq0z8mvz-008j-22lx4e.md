# Spec

**Status:** sealed

## Overview
Full-text search over page content, delivered as a search index bundled in the engine (`wiki/`) and backed by a database the container injects. The engine depends only on Kysely; wiki-server hands it pg or PGlite, the browser hands it PGlite over IndexedDB, so one Kysely-based implementation runs everywhere a workspace is folded. The indexed document is each page's deterministic `renderPage` Markdown; Postgres full-text (`to_tsvector` / `websearch_to_tsquery` / `ts_rank` / `ts_headline`) does the tokenizing, ranking, and snippeting. The index is a derived, rebuildable read-side projection maintained off the same fold that already advances the in-memory read model — the engine's first content-bearing projection — and it is surfaced by upgrading the MCP `search` tool from title-substring to true full-text. The decisions below resolve each question raised on the brief.

## Design
## An injected, Kysely-backed index

The engine ships the schema, the queries, and the projection logic, but never a database driver. IWikiConfig gains an optional search field carrying a Kysely handle; createWiki builds a SqlSearchIndex over it, or a disabled no-op when it is absent. This is the exact seam wiki-mcp already uses for its SQL read model (PGliteDialect locally, PostgresDialect in prod), pulled one layer down so the browser can use it too. One search-document row per page holds the rendered Markdown and a tsvector; a GIN index backs the query, and a per-workspace search-offset row is the consistency cursor.

## Maintained off the fold

Wherever the workspace handle advances its projection and calls notifyApplied (catch-up, live tail, and post-commit) it also hands the index the pages whose version changed: render and upsert the changed ones, drop the deleted or archived ones. Indexing runs after the durable append, on the read side, so it never gates a write (CQRS). Because the index keeps its own search-offset cursor, a cold or wiped index rebuilds by folding the stream, and a query is token-gated (waitFor) for read-your-writes, exactly like the rest of the read side.

## Querying

IWorkspaceHandle.search and a cross-workspace IWiki.search compile the user query with the websearch query parser and order by rank, returning page-level hits each with a highlighted headline snippet. wiki-ui renders the snippet and, on click, scrolls to the match in the same render it already shows; through MCP the upgraded search tool returns the page plus snippet and rank, page-grained, because a character offset in the flat render does not map back to a structured section id.

```typescript
// The injected seam (wiki/src/api.ts + wiki/src/search/)
interface IWikiConfig {
  // ...stream, pageTypes, clock, ids
  readonly search?: { readonly db: Kysely<WikiSearchDatabase> };  // container injects pg / PGlite
}

interface ISearchIndex extends IReadModel {            // appliedToken / waitFor, plus:
  indexPages(state: IWorkspaceState, pageIds: readonly PageId[]): Promise<void>;
  removePages(workspace: WorkspaceId, pageIds: readonly PageId[]): Promise<void>;
  query(workspaces: readonly WorkspaceId[], q: string, opts?: SearchQueryOpts): Promise<readonly SearchHit[]>;
}

interface SearchHit {
  readonly workspaceId: string; readonly pageId: string;
  readonly title: string; readonly type: string; readonly status: string;
  readonly snippet: string;   // ts_headline, highlighted
  readonly rank: number;      // ts_rank
}

interface IWorkspaceHandle { search(query: string, opts?: SearchQueryOpts): Promise<readonly SearchHit[]>; }
```

## Decisions
The engine depends only on Kysely; the container injects the database (pg or PGlite) and full-text is Postgres FTS, not a pure-TS index and not a driver baked into the engine. One Kysely-based implementation serves every container, and ranking plus headline snippets come from the database. The "db" / index technology: a pure-TypeScript inverted index bundled in the engine (zero dependencies, loads identically in browser and Node, fully under our control — but we own ranking and scale ourselves), or an embedded SQL FTS — SQLite FTS5 or PGlite's Postgres `tsvector` (mature BM25 ranking and proven scale, but pulls an environment-specific WASM/native driver into the previously dependency-light, transport-free engine, with different drivers in browser vs Node)? Constraint #2 leans toward the pure-TS index; the trade is ranking quality and scale vs. keeping the engine light and uniform.

One implementation and one query contract; the container only chooses the DB. On the server the engine index can target the same Kysely/Postgres instance that already backs the SQL read model, so the full-text table lives beside the read-model tables rather than being a second backend. One backend or two: does the server reuse this engine index, or keep full-text in wiki-mcp's existing Postgres read model (`tsvector` over the page text it already stores) and let the engine index serve only the browser — i.e. one shared implementation, or two backends behind a single query contract? "Bundled in the engine because we want it on both" leans to one shared implementation; the counter is that the server already has Postgres and could get stronger FTS almost for free.

Index the page's deterministic renderPage Markdown, one search document per page, rather than a per-field extraction. The render is already canonical and already carries prose, code fences, and the title as its H1. What text is indexed: the page's deterministic Markdown render (simple — exactly what a human reads), or structured field-extraction (index prose / scalars / code / block-inlines per section, with field-level weighting, title boost, and code handled specially)? Field-extraction gives richer relevance and section-level hits at the cost of more index machinery.

Page-level hits, each with a headline snippet and a rank. wiki-ui re-finds the match in the render to scroll to its section (a client affordance); MCP stays page-grained because a flat-render offset does not map back to a section or field id. Section-grained hits would mean indexing per section, a later drop-in change to the indexer. Granularity and result shape: page-level hits only, or section/field-level hits with snippets and highlighted match spans? And how much ranking — title-boosted term frequency, or BM25-style scoring? In short, what should a `search` result return to an agent (ids + titles, vs. ranked snippets it can read without a second fetch)?

Evolve the existing search tool from title-substring to full-text (same name, signature, cross-workspace fan-out, and token gating) rather than adding a second searchText tool. Nothing is lost: the title is the H1 of every render, so title matches still match. Tool surface: evolve the existing `search` tool in place (title-substring → full-text, same name and fan-out), or add a separate `searchText` / `fullTextSearch` tool and keep `search` as the fast title-only finder? Evolving keeps one obvious entry point; adding preserves a cheap title lookup alongside the heavier content query.

Persistence is the injected database's job: PGlite to IndexedDB in the browser, pg or PGlite on the server. The index stays derived and rebuildable from the fold as the recovery path, but is durable in steady state and updated incrementally from its search-offset cursor. Persistence: keep the index purely in memory and rebuild from the fold on every boot/tab (simplest, always correct), or persist it (server: alongside the SQL read model; browser: IndexedDB/OPFS) and update incrementally from the applied cursor? Treat persistence as a deferred optimization until rebuild cost is shown to matter, or design for it from the start?

## References
_None._

## Child pages
_None._
