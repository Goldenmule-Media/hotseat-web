/**
 * Initial read-model schema (DESIGN §5.2). Core relational tables + JSONB for the
 * engine's pluggable, type-specific data. Pure Postgres DDL via Kysely's schema
 * builder, so it runs identically on PGlite (local) and pg (prod) — `jsonb` is a
 * raw `sql` type expression because Kysely has no first-class JSONB data-type tag.
 */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("workspaces")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createTable("pages")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("workspace_id", "text", (col) => col.notNull())
    .addColumn("type", "text", (col) => col.notNull())
    .addColumn("parent_id", "text")
    .addColumn("title", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("sections", sql`jsonb`, (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("pages_workspace_id_idx")
    .ifNotExists()
    .on("pages")
    .column("workspace_id")
    .execute();

  await db.schema
    .createTable("tree_edges")
    .ifNotExists()
    .addColumn("workspace_id", "text", (col) => col.notNull())
    .addColumn("parent_id", "text", (col) => col.notNull())
    .addColumn("child_id", "text", (col) => col.notNull())
    .addColumn("ord", "integer", (col) => col.notNull())
    .addPrimaryKeyConstraint("tree_edges_pk", ["workspace_id", "child_id"])
    .execute();

  await db.schema
    .createIndex("tree_edges_parent_idx")
    .ifNotExists()
    .on("tree_edges")
    .columns(["workspace_id", "parent_id"])
    .execute();

  await db.schema
    .createTable("links")
    .ifNotExists()
    .addColumn("workspace_id", "text", (col) => col.notNull())
    .addColumn("from_id", "text", (col) => col.notNull())
    .addColumn("to_id", "text", (col) => col.notNull())
    .addColumn("role", "text", (col) => col.notNull())
    .addPrimaryKeyConstraint("links_pk", ["workspace_id", "from_id", "to_id", "role"])
    .execute();

  await db.schema
    .createTable("events")
    .ifNotExists()
    .addColumn("workspace_id", "text", (col) => col.notNull())
    .addColumn("version", "integer", (col) => col.notNull())
    .addColumn("type", "text", (col) => col.notNull())
    .addColumn("page_id", "text")
    .addColumn("payload", sql`jsonb`, (col) => col.notNull())
    .addColumn("occurred_at", "text", (col) => col.notNull())
    .addPrimaryKeyConstraint("events_pk", ["workspace_id", "version"])
    .execute();

  await db.schema
    .createTable("projection_offsets")
    .ifNotExists()
    .addColumn("workspace_id", "text", (col) => col.primaryKey())
    .addColumn("applied_version", "integer", (col) => col.notNull())
    .addColumn("cursor", "text")
    .addColumn("fingerprint", "text", (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("projection_offsets").ifExists().execute();
  await db.schema.dropTable("events").ifExists().execute();
  await db.schema.dropTable("links").ifExists().execute();
  await db.schema.dropTable("tree_edges").ifExists().execute();
  await db.schema.dropTable("pages").ifExists().execute();
  await db.schema.dropTable("workspaces").ifExists().execute();
}
