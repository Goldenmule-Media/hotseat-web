/**
 * A Kysely {@link Dialect} backed by embedded {@link PGlite} (DESIGN §5.3).
 *
 * PGlite has no published Kysely dialect, but it speaks Postgres, so we reuse
 * Kysely's Postgres **adapter**, **query compiler**, and **introspector**, and only
 * supply a thin driver that runs the compiled SQL through PGlite's single
 * in-process connection. PGlite is single-connection (no pool), so the driver hands
 * out one shared {@link DatabaseConnection} and serializes transactions with
 * `BEGIN`/`COMMIT`/`ROLLBACK` — sufficient for the v1 single-process topology
 * (§5.2). Object row-mode + result fields map straight onto Kysely's `QueryResult`.
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

/** A live (or lazily-created) PGlite instance the dialect drives. */
export type PGliteLike = PGlite;

/**
 * One {@link DatabaseConnection} over a PGlite instance. PGlite's
 * `query<T>(sql, params, { rowMode: "object" })` returns `{ rows, affectedRows }`,
 * which maps directly onto Kysely's {@link QueryResult}. Streaming is unsupported
 * (PGlite buffers), so `streamQuery` throws — the read model never streams.
 */
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
 * A Kysely {@link Driver} over a single PGlite connection. `acquireConnection`
 * always returns the same connection (PGlite is single-connection); transactions
 * are driven with explicit SQL statements on that connection.
 */
class PGliteDriver implements Driver {
  private connection: PGliteConnection | undefined;

  constructor(private readonly db: PGliteLike) {}

  async init(): Promise<void> {
    await this.db.waitReady;
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

/** A Kysely dialect that runs Postgres SQL against an embedded PGlite instance. */
export class PGliteDialect implements Dialect {
  constructor(private readonly db: PGliteLike) {}

  createDriver(): Driver {
    return new PGliteDriver(this.db);
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
