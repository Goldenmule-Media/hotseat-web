# Testing plan

**Status:** ready

## Planned
_None._

## Passed
- Engine/index unit: over an in-memory PGlite, indexing a `feature-brief` then querying a word that appears only in the body (e.g. a constraint phrase) returns that page; a word in no page returns nothing; a title+body match ranks above a body-only match. (vitest, wiki)
- Engine/incremental: editing a page (`setSummary`) reindexes its `search_doc` row — a term added to the body becomes findable and a removed term stops matching — and `search_offset` advances. (vitest, wiki)
- Engine/visibility: archiving a page removes it from results; deleting a page removes its row; unarchiving reindexes it. (vitest, wiki)
- Engine/rebuild + read-your-writes: a cold/empty index rebuilt from `foldWorkspace` matches a live index; `handle.search(…, { consistentWith: token })` waits on the indexed cursor so a just-written term is immediately findable by the same caller. (vitest, wiki)
- Engine/dialect parity: the same query over the same state returns identical hits and ranking on PGlite and on node-postgres, with the pinned `SEARCH_CONFIG`. (vitest, wiki / wiki-mcp)
- wiki-mcp/search tool: the `search` MCP tool returns full-text content hits (not just title) with `ts_headline` snippets and rank, fans out across workspaces, and is read-your-writes (token-gated); a title-only query still matches because the H1 is indexed. (vitest, wiki-mcp)
- Typecheck gate: `npm run typecheck` passes across the workspace with `kysely` added to wiki, the `IWikiConfig.search` seam, the `ISearchIndex` / `SearchHit` exports, and the rewritten `search` tool.
- App smoke-check (wiki-ui against the local server): a search box finds a page by body text, shows a highlighted snippet, and clicking a hit opens the page scrolled to the matching section. Verified in a real browser.

## Failed
_None._

## References
_None._

## Child pages
_None._
