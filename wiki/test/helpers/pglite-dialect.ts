/**
 * A Kysely {@link Dialect} backed by embedded {@link PGlite} — a TEST helper so the
 * engine's search index can run real Postgres FTS in-process. PGlite speaks Postgres,
 * so we reuse Kysely's Postgres adapter/compiler/introspector and supply a thin
 * single-connection driver. (Mirrors wiki-mcp's production dialect; the engine itself
 * never bundles a driver — the container injects one.)
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

class PGliteConnection implements DatabaseConnection {
  constructor(private readonly db: PGlite) {}

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const result = await this.db.query<R>(compiledQuery.sql, [...compiledQuery.parameters], { rowMode: "object" });
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

class PGliteDriver implements Driver {
  private connection: PGliteConnection | undefined;

  constructor(private readonly db: PGlite) {}

  async init(): Promise<void> {
    await this.db.waitReady;
    this.connection = new PGliteConnection(this.db);
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    if (this.connection === undefined) this.connection = new PGliteConnection(this.db);
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
  constructor(private readonly db: PGlite) {}

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
