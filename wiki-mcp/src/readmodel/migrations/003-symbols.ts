/**
 * Symbol-index analyzer columns + the reference index (Phase 2). Phase 1's
 * `002-sections` shipped `symbol_index` as a STUB (`name`/`kind`/`range` for the future
 * analyzer). Phase 2 makes it real: a `range` jsonb is replaced by explicit
 * `def_start`/`def_end` offset columns (one row per declaration), a `container` column
 * is added, and a sibling `reference_index` table records in-source identifier
 * occurrences. Pure additive/altering DDL on a rebuildable cache; a reproject
 * repopulates both tables from canonical source.
 */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Replace the stub `range` jsonb with explicit declaration-offset columns.
  await db.schema.alterTable("symbol_index").dropColumn("range").execute();
  await db.schema
    .alterTable("symbol_index")
    .addColumn("container", "text")
    .execute();
  await db.schema
    .alterTable("symbol_index")
    .addColumn("def_start", "integer")
    .execute();
  await db.schema
    .alterTable("symbol_index")
    .addColumn("def_end", "integer")
    .execute();

  // Index by name so a workspace/page symbol lookup is cheap.
  await db.schema
    .createIndex("symbol_index_name_idx")
    .ifNotExists()
    .on("symbol_index")
    .columns(["workspace_id", "name"])
    .execute();

  // The in-source identifier reference index.
  await db.schema
    .createTable("reference_index")
    .ifNotExists()
    .addColumn("workspace_id", "text", (col) => col.notNull())
    .addColumn("page_id", "text", (col) => col.notNull())
    .addColumn("section_id", "text", (col) => col.notNull())
    .addColumn("field", "text", (col) => col.notNull())
    .addColumn("block_id", "text")
    .addColumn("lang", "text", (col) => col.notNull())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("ref_start", "integer", (col) => col.notNull())
    .addColumn("ref_end", "integer", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("reference_index_name_idx")
    .ifNotExists()
    .on("reference_index")
    .columns(["workspace_id", "name"])
    .execute();

  await db.schema
    .createIndex("reference_index_page_idx")
    .ifNotExists()
    .on("reference_index")
    .columns(["workspace_id", "page_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("reference_index").ifExists().execute();
  await db.schema.alterTable("symbol_index").dropColumn("def_end").execute();
  await db.schema.alterTable("symbol_index").dropColumn("def_start").execute();
  await db.schema.alterTable("symbol_index").dropColumn("container").execute();
  await db.schema.alterTable("symbol_index").addColumn("range", sql`jsonb`).execute();
}
