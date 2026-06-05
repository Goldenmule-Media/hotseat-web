/**
 * A Kysely {@link Dialect} backed by embedded {@link PGlite}, for the BROWSER. Ported
 * from wiki-mcp's server-side dialect (it lives there as an internal, so the UI can't
 * import it across the package boundary) — same thin driver over PGlite's single
 * in-process connection, reusing Kysely's Postgres adapter/compiler/introspector.
 *
 * One addition over the server copy: an optional `gate` promise the driver awaits in
 * `init()`. The engine's search index starts reconciling a workspace the moment its
 * handle folds, but the `idb://` PGlite has to be migrated first (the `search_doc`
 * table must exist). Kysely calls `driver.init()` once, lazily, before the first query
 * and awaits it — so gating it on "migrations are done" guarantees no engine query ever
 * races ahead of the schema, without making {@link getWiki} async. The migrator itself
 * runs on a SEPARATE, ungated Kysely handle over the same PGlite, so it isn't blocked by
 * its own gate.
 */
import type { PGlite } from "@electric-sql/pglite";
import {
  type DatabaseConnection,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type Kysely,
  type QueryCompiler,
  type QueryResult,
  CompiledQuery,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely";

/** A live PGlite instance the dialect drives. */
export type PGliteLike = PGlite;

/** One {@link DatabaseConnection} over a PGlite instance (object row-mode → Kysely's
 *  {@link QueryResult}). PGlite buffers, so `streamQuery` is unsupported. */
class PGliteConnection implements DatabaseConnection {
  constructor(private readonly db: PGliteLike) {}

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const result = await this.db.query<R>(
      compiledQuery.sql,
      // PGlite mutates its params array internally; hand it a fresh copy.
      [...compiledQuery.parameters],
      { rowMode: "object" },
    );
    const affected = result.affectedRows;
    return {
      rows: result.rows,
      ...(affected !== undefined ? { numAffectedRows: BigInt(affected) } : {}),
    };
  }

  // eslint-disable-next-line require-yield
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("PGliteDialect does not support streaming queries.");
  }
}

/**
 * A Kysely {@link Driver} over a single PGlite connection. `init()` waits for PGlite to
 * be ready and (optionally) for `gate` to resolve before any query runs.
 */
class PGliteDriver implements Driver {
  private connection: PGliteConnection | undefined;

  constructor(
    private readonly db: PGliteLike,
    private readonly gate?: Promise<unknown>,
  ) {}

  async init(): Promise<void> {
    await this.db.waitReady;
    if (this.gate !== undefined) await this.gate;
    this.connection = new PGliteConnection(this.db);
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    if (this.connection === undefined) {
      this.connection = new PGliteConnection(this.db);
    }
    return this.connection;
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("begin"));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("commit"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("rollback"));
  }

  async releaseConnection(): Promise<void> {
    // Single shared connection — nothing to release.
  }

  async destroy(): Promise<void> {
    await this.db.close();
  }
}

/** A Kysely dialect that runs Postgres SQL against an embedded PGlite instance. The
 *  optional `gate` blocks the first query until it resolves (used to wait out migrations). */
export class PGliteDialect implements Dialect {
  constructor(
    private readonly db: PGliteLike,
    private readonly gate?: Promise<unknown>,
  ) {}

  createDriver(): Driver {
    return new PGliteDriver(this.db, this.gate);
  }

  createQueryCompiler(): QueryCompiler {
    return new PostgresQueryCompiler();
  }

  createAdapter(): DialectAdapter {
    return new PostgresAdapter();
  }

  createIntrospector(db: Kysely<unknown>): PostgresIntrospector {
    return new PostgresIntrospector(db);
  }
}
