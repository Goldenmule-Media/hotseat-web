/**
 * The `wiki-mcp` library API (DESIGN §6, §7, §8, ADR-M5). The standalone `bin`
 * wrapper lives in `./bin` — kept SEPARATE so a host that bundles this module
 * (`wiki-server` inlines it from source, DESIGN §10) does not drag in a self-exec
 * guard that would auto-boot a second, rogue server.
 *
 * `createWikiMcp(config)` assembles the whole runtime: the embedded write-side
 * engine (hot-handle LRU, DESIGN §7), the durable SQL read model + its migrations
 * (DESIGN §5), the projection tailer that keeps SQL current off the engine's live
 * tail (DESIGN §5.1), and the MCP server (tools + resources + per-session token
 * management, DESIGN §6). The host (`wiki-server`) calls this and injects its
 * consolidating {@link Logger} (DESIGN §8/§9); a `child` scope is used per subsystem
 * so logs are attributable.
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
import { WikiMcpServer, type McpTransport } from "./mcp/server.js";

export type { Logger } from "./logger.js";
export { consoleLogger, silentLogger } from "./logger.js";
export type { WikiMcpConfig, DbConfig } from "./config.js";
export { resolveConfig, resolveRuntime } from "./config.js";
export type { McpTransport } from "./mcp/server.js";

/**
 * Everything `createWikiMcp` needs: the resolved wire {@link WikiMcpConfig}, the
 * engine-shaped extras the host supplies directly (page types + deterministic
 * services), the injected {@link Logger}, and the MCP transport (DESIGN §6.1).
 */
export interface CreateWikiMcpOptions {
  readonly config: WikiMcpConfig;
  /** The page types this instance understands (DESIGN §5.1, ADR-M3). */
  readonly pageTypes: EngineConfig["pageTypes"];
  /** Injected ISO-8601 clock (determinism/testing); engine-defaulted otherwise. */
  readonly clock?: () => string;
  /** Injected id factory (determinism/testing); engine-defaulted otherwise. */
  readonly ids?: () => string;
  /** Default `actor` stamped on event metadata. */
  readonly actor?: string;
  /** Hot-handle LRU bound (`IWikiConfig.cache.maxWorkspaces`, DESIGN §7). */
  readonly cache?: EngineConfig["cache"];
  /** The injected host logger (DESIGN §9); defaults to a console logger standalone. */
  readonly logger?: Logger;
  /** Where the MCP server listens (DESIGN §6.1). @default stdio */
  readonly transport?: McpTransport;
  /**
   * Catalog discovery poll interval (ms): the live tail subscribes per workspace for
   * data, and polls the catalog at this cadence only to attach workspaces created
   * later by other clients (DESIGN §5.1, §9.3). @default 1000
   */
  readonly discoverPollMs?: number;
}

/** A running wiki-mcp instance — its parts, plus a `close()` that tears everything down. */
export interface WikiMcp {
  readonly engine: EmbeddedEngine;
  readonly readModel: SqlReadModel;
  readonly projection: ProjectionService;
  readonly server: WikiMcpServer;
  /** Drain the projection once now (await read-your-writes before a read in tests). */
  drainOnce(): Promise<void>;
  /** Stop the tailer + MCP server and close the engine + store. */
  close(): Promise<void>;
}

/**
 * Assemble and start a wiki-mcp runtime (DESIGN §7): open + migrate the SQL store,
 * build the read model, build the embedded engine, start the projection tailer
 * (event-driven live tail — subscribe + notify + discovery poll), and start the MCP
 * server on the chosen transport.
 */
export async function createWikiMcp(options: CreateWikiMcpOptions): Promise<WikiMcp> {
  const { config, pageTypes } = options;
  const logger = options.logger ?? consoleLogger();
  const transport: McpTransport = options.transport ?? { kind: "stdio" };

  // ── read model (durable SQL) ──
  const store: ReadModelStore = await openStore(config.db, logger.child?.({ subsystem: "readmodel" }) ?? logger);
  const readModel = new SqlReadModel(store.db, {
    defaultTimeoutMs: config.readConsistencyTimeoutMs,
    pollMs: config.waitForPollMs,
  });

  // ── write-side engine (hot LRU) ──
  const engine = new EmbeddedEngine(
    {
      streamBaseUrl: config.streamBaseUrl,
      namespace: config.namespace,
      pageTypes,
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
    pageTypes,
    readModel,
    logger.child?.({ subsystem: "projection" }) ?? logger,
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

  // Start the EVENT-DRIVEN live tail (DESIGN §5.1): per-workspace `subscribe` for
  // external events + the host's `notify` for local writes (wired into the MCP server
  // below) + a low-frequency catalog discovery poll. `start` does the initial catch-up.
  const stopTail = await projection.start(source, {
    ...(options.discoverPollMs !== undefined ? { discoverPollMs: options.discoverPollMs } : {}),
  });

  // ── MCP server ──
  const server = new WikiMcpServer({
    engine,
    readModel,
    namespace: config.namespace,
    logger: logger.child?.({ subsystem: "mcp" }) ?? logger,
    // A local commit doesn't fan out to its own handle's subscribers, so push each
    // write tool's workspace to the tailer for prompt read-your-writes (DESIGN §5.1/§6.2).
    onWrite: (workspace) => projection.notify(workspace),
  });
  await server.start(transport);

  return {
    engine,
    readModel,
    projection,
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
 * library into a host never auto-starts it (DESIGN §10).
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
