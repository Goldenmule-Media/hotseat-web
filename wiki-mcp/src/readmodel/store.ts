/**
 * Kysely store wiring. Builds a `Kysely<ReadModelDatabase>` over the
 * configured dialect — embedded {@link PGliteDialect} locally, the built-in
 * `PostgresDialect` (node-postgres) in production — and runs the bundled
 * migrations to latest. Same Postgres SQL both places (dev/prod parity); the choice
 * is one config knob (`db.kind`).
 */
import { PGlite } from "@electric-sql/pglite";
import { Kysely, Migrator, PostgresDialect } from "kysely";
import pg from "pg";

import type { DbConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { migrationProvider } from "./migrations/index.js";
import { PGliteDialect } from "./pglite-dialect.js";
import type { ReadModelDatabase } from "./schema.js";

/** A built store: the typed Kysely handle plus a teardown that closes the pool/PGlite. */
export interface ReadModelStore {
  readonly db: Kysely<ReadModelDatabase>;
  /** Close the underlying connection(s). Idempotent at the caller's discretion. */
  close(): Promise<void>;
}

/**
 * Build a `Kysely<ReadModelDatabase>` for the given {@link DbConfig}. For
 * `pglite`, an in-memory store is used unless `dataDir` is set (then it persists).
 * For `pg`, a node-postgres `Pool` is opened against `connectionString`.
 * Does NOT run migrations — call {@link migrateToLatest} after building.
 */
export function buildStore(config: DbConfig): ReadModelStore {
  if (config.kind === "pglite") {
    // `new PGlite()` with no args is an in-memory database (tests); a dataDir persists.
    const pglite = config.dataDir !== undefined ? new PGlite(config.dataDir) : new PGlite();
    const db = new Kysely<ReadModelDatabase>({ dialect: new PGliteDialect(pglite) });
    return { db, close: () => db.destroy() };
  }

  const pool = new pg.Pool({ connectionString: config.connectionString });
  const db = new Kysely<ReadModelDatabase>({ dialect: new PostgresDialect({ pool }) });
  return { db, close: () => db.destroy() };
}

/**
 * Run all bundled migrations to latest (migrations at startup).
 * Throws on the first failed migration so a bad schema fails closed rather than
 * serving a half-built read model.
 */
export async function migrateToLatest(
  db: Kysely<ReadModelDatabase>,
  logger: Logger,
): Promise<void> {
  const migrator = new Migrator({ db, provider: migrationProvider });
  const { error, results } = await migrator.migrateToLatest();

  for (const result of results ?? []) {
    if (result.status === "Success") {
      logger.info("read-model migration applied", { migration: result.migrationName });
    } else if (result.status === "Error") {
      logger.error("read-model migration failed", { migration: result.migrationName });
    }
  }

  if (error !== undefined) {
    throw error instanceof Error ? error : new Error(`read-model migration failed: ${String(error)}`);
  }
}

/**
 * Build a store AND migrate it to latest in one step (the common startup path).
 */
export async function openStore(config: DbConfig, logger: Logger): Promise<ReadModelStore> {
  const store = buildStore(config);
  await migrateToLatest(store.db, logger);
  return store;
}
