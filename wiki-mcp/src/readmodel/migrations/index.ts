/**
 * A static {@link MigrationProvider} (DESIGN §5.3 — Kysely migrations). The
 * read model is a rebuildable cache, so migrations are few and additive; we list
 * them in code (rather than `FileMigrationProvider`) because `wiki-mcp` is
 * compiled to `dist/` and a bundled list avoids a runtime filesystem dependency.
 */
import type { Migration, MigrationProvider } from "kysely";

import * as initial from "./001-initial.js";

/** All read-model migrations, keyed by name (Kysely sorts by key, ascending). */
const MIGRATIONS: Record<string, Migration> = {
  "001-initial": { up: initial.up, down: initial.down },
};

/** A provider that returns the bundled {@link MIGRATIONS}. */
export const migrationProvider: MigrationProvider = {
  async getMigrations(): Promise<Record<string, Migration>> {
    return MIGRATIONS;
  },
};
