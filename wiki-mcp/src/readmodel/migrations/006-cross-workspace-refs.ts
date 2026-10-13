/**
 * Cross-workspace content refs: an `xref_index` row names its target's workspace (equal to
 * `workspace_id` for a local ref) and, for a cross-workspace ref, its title snapshot. An
 * index on the target serves inbound-ref lookups.
 */
import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("xref_index").addColumn("target_workspace_id", "text").execute();
  await db.schema.alterTable("xref_index").addColumn("target_title", "text").execute();
  await sql`UPDATE xref_index SET target_workspace_id = workspace_id`.execute(db);
  await db.schema.alterTable("xref_index").alterColumn("target_workspace_id", (col) => col.setNotNull()).execute();
  await db.schema
    .createIndex("xref_index_target_idx")
    .ifNotExists()
    .on("xref_index")
    .columns(["target_workspace_id", "target_page"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("xref_index_target_idx").ifExists().execute();
  await db.schema.alterTable("xref_index").dropColumn("target_title").execute();
  await db.schema.alterTable("xref_index").dropColumn("target_workspace_id").execute();
}
