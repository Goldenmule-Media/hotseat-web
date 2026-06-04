/**
 * Page archival (engine ADR-011): an orthogonal `archived` flag on `pages`, independent
 * of the lifecycle `status`. Additive — existing rows default to not-archived.
 */
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("pages")
    .addColumn("archived", "boolean", (col) => col.notNull().defaultTo(false))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("pages").dropColumn("archived").execute();
}
