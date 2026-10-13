/**
 * Cross-workspace links: a link row names its target's workspace (equal to `workspace_id`
 * for a local edge) and, for a cross-workspace edge, the title snapshot it renders with.
 * The target workspace joins the primary key, and an index serves inbound-edge lookups.
 */
import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("links").addColumn("to_workspace_id", "text").execute();
  await db.schema.alterTable("links").addColumn("to_title", "text").execute();
  await sql`UPDATE links SET to_workspace_id = workspace_id`.execute(db);
  await db.schema.alterTable("links").alterColumn("to_workspace_id", (col) => col.setNotNull()).execute();
  await db.schema.alterTable("links").dropConstraint("links_pk").execute();
  await db.schema
    .alterTable("links")
    .addPrimaryKeyConstraint("links_pk", ["workspace_id", "from_id", "to_workspace_id", "to_id", "role"])
    .execute();
  await db.schema
    .createIndex("links_target_idx")
    .ifNotExists()
    .on("links")
    .columns(["to_workspace_id", "to_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("links_target_idx").ifExists().execute();
  await sql`DELETE FROM links WHERE to_workspace_id <> workspace_id`.execute(db);
  await db.schema.alterTable("links").dropConstraint("links_pk").execute();
  await db.schema
    .alterTable("links")
    .addPrimaryKeyConstraint("links_pk", ["workspace_id", "from_id", "to_id", "role"])
    .execute();
  await db.schema.alterTable("links").dropColumn("to_title").execute();
  await db.schema.alterTable("links").dropColumn("to_workspace_id").execute();
}
