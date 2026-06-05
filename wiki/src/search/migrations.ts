/**
 * Search-index migrations (Kysely). Bundled in code (no filesystem) and run under a
 * SEPARATE migration table so a host can run this migrator on the SAME database as its
 * own read-model migrator without the two colliding. The `tsv` column is a STORED
 * generated column over `body` (the render already carries the title as its H1), so the
 * tsvector is always consistent with `body` and is never written from application code.
 * The `'english'` literal here MUST match {@link SEARCH_CONFIG}.
 */
import { Migrator, sql, type Kysely, type Migration, type MigrationProvider } from "kysely";

import type { WikiSearchDatabase } from "./schema";

async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table if not exists search_doc (
      workspace_id text not null,
      page_id text not null,
      type text not null,
      status text not null,
      archived boolean not null default false,
      title text not null,
      body text not null,
      version integer not null,
      tsv tsvector generated always as (
        to_tsvector('english', coalesce(body, ''))
      ) stored,
      primary key (workspace_id, page_id)
    )
  `.execute(db);
  await sql`create index if not exists search_doc_tsv_idx on search_doc using gin (tsv)`.execute(db);
  await sql`
    create table if not exists search_offset (
      workspace_id text primary key,
      applied_version integer not null
    )
  `.execute(db);
}

async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists search_doc_tsv_idx`.execute(db);
  await sql`drop table if exists search_doc`.execute(db);
  await sql`drop table if exists search_offset`.execute(db);
}

/** All search migrations, keyed by name (Kysely sorts ascending). */
const MIGRATIONS: Record<string, Migration> = {
  "001-search": { up, down },
};

/** A provider that returns the bundled search {@link MIGRATIONS}. */
export const searchMigrationProvider: MigrationProvider = {
  async getMigrations(): Promise<Record<string, Migration>> {
    return MIGRATIONS;
  },
};

/**
 * Run the search migrations to latest against the injected database. Uses dedicated
 * migration bookkeeping tables (`wiki_search_migration*`) so it coexists with any
 * other migrator on the same database. Throws on the first failed migration.
 */
export async function migrateSearchToLatest(db: Kysely<WikiSearchDatabase>): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: searchMigrationProvider,
    migrationTableName: "wiki_search_migration",
    migrationLockTableName: "wiki_search_migration_lock",
  });
  const { error } = await migrator.migrateToLatest();
  if (error !== undefined) {
    throw error instanceof Error ? error : new Error(`search migration failed: ${String(error)}`);
  }
}
