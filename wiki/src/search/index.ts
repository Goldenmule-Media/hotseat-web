/**
 * The engine's full-text search index (the first content-bearing read projection).
 * Bundled in `wiki/` and depends ONLY on Kysely; a container injects the database
 * (pg or PGlite). See {@link SqlSearchIndex} for the SQL, {@link renderSearchDocs} for
 * what is indexed, and {@link migrateSearchToLatest} for the schema.
 */
export { SqlSearchIndex } from "./sql-search-index";
export { migrateSearchToLatest, searchMigrationProvider } from "./migrations";
export { renderSearchDocs, renderAffectedDocs, affectedPageIds } from "./render-docs";
export { SEARCH_CONFIG } from "./schema";
export type {
  ISearchIndex,
  IWikiSearchConfig,
  SearchDoc,
  SearchDocTable,
  SearchHit,
  SearchOffsetTable,
  SearchQueryOpts,
  WikiSearchDatabase,
} from "./schema";
