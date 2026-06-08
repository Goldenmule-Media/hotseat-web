/**
 * Section-model read-side projections: the `outline` tree, the `symbol_index`
 * stub (canonical code locations; name/kind/range filled in Phase 3), and the
 * `xref_index` of every `ref` (field + inline, harvested deep). Pure additive DDL.
 */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("outline")
    .ifNotExists()
    .addColumn("workspace_id", "text", (col) => col.notNull())
    .addColumn("page_id", "text", (col) => col.notNull())
    .addColumn("section_id", "text", (col) => col.notNull())
    .addColumn("parent_section_id", "text")
    .addColumn("key", "text", (col) => col.notNull())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("ord", "integer", (col) => col.notNull())
    .addPrimaryKeyConstraint("outline_pk", ["workspace_id", "page_id", "section_id"])
    .execute();

  await db.schema
    .createIndex("outline_page_idx")
    .ifNotExists()
    .on("outline")
    .columns(["workspace_id", "page_id"])
    .execute();

  await db.schema
    .createTable("symbol_index")
    .ifNotExists()
    .addColumn("workspace_id", "text", (col) => col.notNull())
    .addColumn("page_id", "text", (col) => col.notNull())
    .addColumn("section_id", "text", (col) => col.notNull())
    .addColumn("field", "text", (col) => col.notNull())
    .addColumn("block_id", "text")
    .addColumn("lang", "text", (col) => col.notNull())
    .addColumn("source_hash", "text", (col) => col.notNull())
    .addColumn("name", "text")
    .addColumn("kind", "text")
    .addColumn("range", sql`jsonb`)
    .execute();

  await db.schema
    .createIndex("symbol_index_page_idx")
    .ifNotExists()
    .on("symbol_index")
    .columns(["workspace_id", "page_id"])
    .execute();

  await db.schema
    .createTable("xref_index")
    .ifNotExists()
    .addColumn("workspace_id", "text", (col) => col.notNull())
    .addColumn("from_page", "text", (col) => col.notNull())
    .addColumn("from_section", "text", (col) => col.notNull())
    .addColumn("from_field", "text", (col) => col.notNull())
    .addColumn("target_kind", "text", (col) => col.notNull())
    .addColumn("target_page", "text")
    .addColumn("target_section", "text")
    .addColumn("target_block", "text")
    .addColumn("target_name", "text")
    .execute();

  await db.schema
    .createIndex("xref_index_from_idx")
    .ifNotExists()
    .on("xref_index")
    .columns(["workspace_id", "from_page"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("xref_index").ifExists().execute();
  await db.schema.dropTable("symbol_index").ifExists().execute();
  await db.schema.dropTable("outline").ifExists().execute();
}
