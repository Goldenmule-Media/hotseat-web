/**
 * The `wiki-mcp` library API (ADR-M5). The standalone `bin` wrapper lives in
 * `./bin` — kept SEPARATE so a host that bundles this module (`wiki-server`
 * inlines it from source) does not drag in a self-exec guard that would auto-boot
 * a second, rogue server.
 *
 * `createWikiMcp(config)` assembles the whole runtime: the embedded write-side
 * engine (hot-handle LRU), the durable SQL read model + its migrations, the
 * projection tailer that keeps SQL current off the engine's live tail, and the MCP
 * server (tools + resources + per-session token management). The host
 * (`wiki-server`) calls this and injects its consolidating {@link Logger}; a
 * `child` scope is used per subsystem so logs are attributable.
 *
 * The default `main()` resolves config from flags/env (a console logger) and starts
 * over stdio — the standalone path. A host normally builds {@link WikiMcpConfig} +
 * page types itself and chooses the transport.
 */
import { consoleLogger, type Logger } from "./logger.js";
import { resolveConfig, type WikiMcpConfig } from "./config.js";
import { EmbeddedEngine, type EngineConfig } from "./engine.js";
import { openStore, type ReadModelStore } from "./readmodel/store.js";
import { SqlReadModel } from "./readmodel/readmodel.js";
import { ProjectionService } from "./tail/projection.js";
import { engineEventSource } from "./tail/engine-source.js";
import { ModelRegistry } from "./models/registry.js";
import type { McpAuth } from "./mcp/auth.js";
import { WikiMcpServer, type McpTransport } from "./mcp/server.js";
import { SqlSearchIndex, migrateSearchToLatest, type ISearchIndex, type WikiSearchDatabase } from "wiki";
import type { Kysely } from "kysely";

export type { Logger } from "./logger.js";
export { consoleLogger, silentLogger } from "./logger.js";
export type { WikiMcpConfig, DbConfig } from "./config.js";
export { resolveConfig, resolveRuntime } from "./config.js";
export type { McpTransport } from "./mcp/server.js";
export type { McpAuth, AuthUser, AccessView } from "./mcp/auth.js";
export type { RenderSink } from "./tail/render-sink.js";
export { ModelRegistry } from "./models/registry.js";
export type { ModelRegistryEvent, BundleInfo, BundleSkillInfo } from "./models/registry.js";

/**
 * Everything `createWikiMcp` needs: the resolved wire {@link WikiMcpConfig}, the
 * engine-shaped extras the host supplies directly (page types + deterministic
 * services), the injected {@link Logger}, and the MCP transport.
 */
export interface CreateWikiMcpOptions {
  readonly config: WikiMcpConfig;
  /** The page types this instance understands (ADR-M3). */
  readonly pageTypes: EngineConfig["pageTypes"];
  /** Injected ISO-8601 clock (determinism/testing); engine-defaulted otherwise. */
  readonly clock?: () => string;
  /** Injected id factory (determinism/testing); engine-defaulted otherwise. */
  readonly ids?: () => string;
  /** Default `actor` stamped on event metadata. */
  readonly actor?: string;
  /** Hot-handle LRU bound (`IWikiConfig.cache.maxWorkspaces`). */
  readonly cache?: EngineConfig["cache"];
  /** The injected host logger; defaults to a console logger standalone. */
  readonly logger?: Logger;
  /** Where the MCP server listens. @default stdio */
  readonly transport?: McpTransport;
  /**
   * Catalog discovery poll interval (ms): the live tail subscribes per workspace for
   * data, and polls the catalog at this cadence only to attach workspaces created
   * later by other clients. @default 1000
   */
  readonly discoverPollMs?: number;
  /**
   * Host-injected auth + per-workspace access control (HTTP transport). When set,
   * unauthenticated MCP requests 401, workspace-scoped tools/resources are gated per
   * user, and `createWorkspace` attributes ownership. Absent → trusted (unchanged).
   */
  readonly auth?: McpAuth;
}

/** A running wiki-mcp instance — its parts, plus a `close()` that tears everything down. */
export interface WikiMcp {
  readonly engine: EmbeddedEngine;
  readonly readModel: SqlReadModel;
  /** The engine's full-text search index, backed by the same database as the read model. */
  readonly searchIndex: ISearchIndex;
  readonly projection: ProjectionService;
  /** The live model registry (ADR-M6) — load/reload/unregister page-type bundles at runtime. */
  readonly models: ModelRegistry;
  readonly server: WikiMcpServer;
  /** Drain the projection once now (await read-your-writes before a read in tests). */
  drainOnce(): Promise<void>;
  /** Stop the tailer + MCP server and close the engine + store. */
  close(): Promise<void>;
}

/**
 * Assemble and start a wiki-mcp runtime: open + migrate the SQL store,
 * build the read model, build the embedded engine, start the projection tailer
 * (event-driven live tail — subscribe + notify + discovery poll), and start the MCP
 * server on the chosen transport.
 */
export async function createWikiMcp(options: CreateWikiMcpOptions): Promise<WikiMcp> {
  const { config, pageTypes } = options;
  const logger = options.logger ?? consoleLogger();
  const transport: McpTransport = options.transport ?? { kind: "stdio" };

  // ── model registry (live page-type set, ADR-M6) ──
  // Seed the host-supplied page types as the initial bundle BEFORE wiring `onChange`,
  // so the seed itself does not trigger a reproject (engine/projection don't exist yet).
  const models = new ModelRegistry();
  await models.register("default", pageTypes);

  // ── read model (durable SQL) ──
  const store: ReadModelStore = await openStore(config.db, logger.child?.({ subsystem: "readmodel" }) ?? logger);
  const readModel = new SqlReadModel(store.db, {
    defaultTimeoutMs: config.readConsistencyTimeoutMs,
    pollMs: config.waitForPollMs,
  });

  // ── full-text search index (engine-owned, same database as the read model) ──
  // The engine ships the schema + queries; the host owns the connection. We run the
  // search migrations under their own bookkeeping tables (so they coexist with the
  // read-model migrator on the same DB) and feed the index from the projection tailer.
  const searchDb = store.db as unknown as Kysely<WikiSearchDatabase>;
  await migrateSearchToLatest(searchDb);
  const searchIndex: ISearchIndex = new SqlSearchIndex(searchDb, config.readConsistencyTimeoutMs);

  // ── write-side engine (hot LRU) ──
  const engine = new EmbeddedEngine(
    {
      streamBaseUrl: config.streamBaseUrl,
      namespace: config.namespace,
      pageTypes: models.pageTypes(),
      readConsistencyTimeoutMs: config.readConsistencyTimeoutMs,
      ...(options.clock !== undefined ? { clock: options.clock } : {}),
      ...(options.ids !== undefined ? { ids: options.ids } : {}),
      ...(options.actor !== undefined ? { actor: options.actor } : {}),
      ...(options.cache !== undefined ? { cache: options.cache } : {}),
    },
    logger.child?.({ subsystem: "engine" }) ?? logger,
  );

  // ── projection tailer (engine-backed source) ──
  const projection = new ProjectionService(
    store.db,
    models.pageTypes(),
    readModel,
    logger.child?.({ subsystem: "projection" }) ?? logger,
    undefined, // languages → built-in default
    searchIndex,
  );
  const source = engineEventSource(engine);

  const drainOnce = async (): Promise<void> => {
    try {
      await projection.drain(source);
    } catch (err) {
      // A halted workspace (UnknownPageTypeError) is already logged by the service.
      logger.warn("projection drain reported an error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Start the EVENT-DRIVEN live tail: per-workspace `subscribe` for external events
  // + the host's `notify` for local writes (wired into the MCP server below) + a
  // low-frequency catalog discovery poll. `start` does the initial catch-up.
  const discoverOpts = options.discoverPollMs !== undefined ? { discoverPollMs: options.discoverPollMs } : {};
  const stopTail = await projection.start(source, discoverOpts);

  // ── model hot-reload (ADR-M6) ──
  // On a registry change, STOP the live tail first — its per-workspace runners and the
  // discovery poll would otherwise re-project workspaces concurrently with the reproject
  // below, racing whole-tree rebuilds into the same render sinks (the boot-race bug that
  // corrupted Markdown mirrors). Then rebind the engine + the projection's registry,
  // reproject the read model, and re-attach a fresh tail (the old engine's stream
  // subscriptions died with its handles anyway). `models.load/reload/unregister` await
  // this whole reaction.
  const modelLogger = logger.child?.({ subsystem: "models" }) ?? logger;
  models.onChange = async (event) => {
    modelLogger.info("model registry changed", {
      reason: event.reason,
      bundleId: event.bundleId,
      generation: event.generation,
    });
    projection.stopLive();
    await engine.rebind(models.pageTypes());
    projection.rebind(models.current());
    await projection.reproject(source);
    await projection.start(source, discoverOpts);
  };

  // ── MCP server ──
  const server = new WikiMcpServer({
    engine,
    readModel,
    searchIndex,
    models,
    namespace: config.namespace,
    logger: logger.child?.({ subsystem: "mcp" }) ?? logger,
    // A local commit doesn't fan out to its own handle's subscribers, so push each
    // write tool's workspace to the tailer for prompt read-your-writes.
    onWrite: (workspace) => projection.notify(workspace),
    ...(options.auth !== undefined ? { auth: options.auth } : {}),
  });
  await server.start(transport);

  return {
    engine,
    readModel,
    searchIndex,
    projection,
    models,
    server,
    drainOnce,
    async close(): Promise<void> {
      stopTail();
      await server.stop();
      await engine.close();
      await store.close();
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// standalone runtime (invoked by the `./bin` wrapper)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Standalone runtime: resolve config from `process.argv`/`process.env`, build a
 * runtime with NO page types registered (a host injects real ones), and serve over
 * stdio. Invoked by the `./bin` entry; production runs through a host that supplies
 * its page-type set via {@link createWikiMcp}. NOTE: there is intentionally no
 * `import.meta.url` self-exec guard here — it lives in `./bin`, so bundling this
 * library into a host never auto-starts it.
 */
export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  const config = resolveConfig(argv, env);
  const logger = consoleLogger();
  const mcp = await createWikiMcp({ config, pageTypes: [], logger });

  const shutdown = (): void => {
    void mcp.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  logger.info("wiki-mcp started", { namespace: config.namespace });
}
