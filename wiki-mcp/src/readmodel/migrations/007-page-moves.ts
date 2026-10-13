/**
 * Cross-workspace page moves: `page_forwards` says where a page that left a workspace went,
 * and `pending_moves` lists moves out that haven't finished (boot recovery resumes them).
 */
import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("page_forwards")
    .ifNotExists()
    .addColumn("workspace_id", "text", (col) => col.notNull())
    .addColumn("page_id", "text", (col) => col.notNull())
    .addColumn("to_workspace_id", "text", (col) => col.notNull())
    .addColumn("title", "text", (col) => col.notNull())
    .addColumn("move_id", "text", (col) => col.notNull())
    .addPrimaryKeyConstraint("page_forwards_pk", ["workspace_id", "page_id"])
    .execute();
  await db.schema
    .createTable("pending_moves")
    .ifNotExists()
    .addColumn("workspace_id", "text", (col) => col.notNull())
    .addColumn("move_id", "text", (col) => col.notNull())
    .addColumn("to_workspace_id", "text", (col) => col.notNull())
    .addColumn("page_ids", sql`jsonb`, (col) => col.notNull())
    .addPrimaryKeyConstraint("pending_moves_pk", ["workspace_id", "move_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("pending_moves").ifExists().execute();
  await db.schema.dropTable("page_forwards").ifExists().execute();
}
