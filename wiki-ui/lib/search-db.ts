/**
 * The browser-side full-text search database. The wiki engine's FTS is a content read
 * projection backed by Kysely over a Postgres-compatible DB; in the browser that DB is
 * {@link PGlite} persisted to IndexedDB (`idb://`), so the index survives reloads and a
 * workspace indexed in a previous session is searchable immediately on the next visit.
 *
 * Sequencing matters: the engine begins reconciling a workspace into this index as soon
 * as its handle folds (open/catch-up), but the `search_doc`/`search_offset` tables must
 * exist first. We solve it without making {@link getWiki} async:
 *   - a SEPARATE, ungated Kysely handle runs {@link migrateSearchToLatest} once,
 *   - the engine-facing handle uses a {@link PGliteDialect} whose driver `init()` awaits
 *     that migration (the `gate`) before issuing the first query.
 * Both handles wrap the SAME single-connection PGlite, which serializes statements, so
 * the migration fully lands before any reconcile/query touches the engine handle.
 *
 * Browser-only: callers must guard on `typeof window` (see {@link getWiki}); PGlite is
 * only instantiated here, never at module load.
 */
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { migrateSearchToLatest, type WikiSearchDatabase } from "wiki";
import { PGliteDialect } from "./pglite-dialect";

/** IndexedDB store name for the persisted index. Bump to invalidate a bad local index. */
const IDB_NAME = "idb://wiki-ui-search";

let handle: Kysely<WikiSearchDatabase> | undefined;

/**
 * The engine-facing search DB handle. Synchronous (Kysely connects lazily); the first
 * query waits for the one-time migration via the dialect gate. Singleton per tab.
 */
export function getSearchDb(): Kysely<WikiSearchDatabase> {
  if (handle !== undefined) return handle;
  const pglite = new PGlite(IDB_NAME);
  // Migrate on its own ungated handle so the migrator isn't blocked by the gate it sets.
  const migrationDb = new Kysely<WikiSearchDatabase>({ dialect: new PGliteDialect(pglite) });
  const ready = migrateSearchToLatest(migrationDb).catch((err: unknown) => {
    // A failed migration leaves an unusable index, but must never crash the app — search
    // just returns nothing. Surface it for diagnosis; the gate still resolves so queries
    // fail fast (empty) instead of hanging forever.
    console.error("[wiki-ui] search index migration failed:", err);
  });
  handle = new Kysely<WikiSearchDatabase>({ dialect: new PGliteDialect(pglite, ready) });
  return handle;
}
