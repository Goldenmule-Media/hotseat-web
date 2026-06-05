/**
 * Build a migrated, PGlite-backed `Kysely<WikiSearchDatabase>` for engine search tests
 * — the in-process stand-in for the DB a real container (wiki-server / browser) injects.
 */
import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";

import { migrateSearchToLatest, type WikiSearchDatabase } from "../../src/search";
import { PGliteDialect } from "./pglite-dialect";

export interface SearchTestDb {
  readonly db: Kysely<WikiSearchDatabase>;
  close(): Promise<void>;
}

/** A fresh in-memory PGlite database with the search schema migrated to latest. */
export async function makeSearchDb(): Promise<SearchTestDb> {
  const pglite = new PGlite();
  const db = new Kysely<WikiSearchDatabase>({ dialect: new PGliteDialect(pglite) });
  await migrateSearchToLatest(db);
  return { db, close: () => db.destroy() };
}
