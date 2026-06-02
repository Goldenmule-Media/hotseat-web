#!/usr/bin/env node
/**
 * wiki-server entrypoint (DESIGN §3.1, §8.1, §8.5). One deployable that hosts BOTH
 * planes in a single lifecycle:
 *
 *   1. build the **consolidating logger** (DESIGN §8.5);
 *   2. start the **stream host** ({@link DurableStreamTestServer}), wiring its
 *      `onStreamCreated`/`onStreamDeleted` hooks into the logger (`source: stream`);
 *   3. start **`wiki-mcp`** in-process via `createWikiMcp({ baseUrl: server.url,
 *      namespace, db, logger })` (`source: mcp`) — the hosted engine + SQL read
 *      model + MCP surface (DESIGN §3.1);
 *   4. start the **control listener** (log/health/info API, DESIGN §8.5) on
 *      `controlPort`; and
 *   5. trap signals for a graceful `stop()` of **all three**.
 *
 * `wiki-server` stays thin wiring (DESIGN §3, G1/G2): it imports
 * `@durable-streams/server` and `wiki-mcp` — **never `wiki` directly** — and owns no
 * engine/read-model/MCP logic of its own.
 *
 * The wiring is factored into {@link startWikiServer} so a host/test can boot the
 * same three subsystems and `stop()` them as a unit; the `bin` guard at the bottom
 * resolves config, starts them, and traps signals (DESIGN §8.1).
 */
import { DurableStreamTestServer, type StreamLifecycleEvent } from "@durable-streams/server";
import { createWikiMcp, resolveConfig as resolveMcpConfig, type McpTransport, type WikiMcp, type WikiMcpConfig } from "wiki-mcp";

// NOTE: `.js` extensions are required because wiki-server is COMPILED and run via
// `node dist/main.js` (raw Node ESM needs explicit extensions). This differs from
// `wiki/`, which is consumed as TS source and so imports extensionless. The
// `wiki-mcp` / `@durable-streams/server` imports above are bare package specifiers.
import { configWarnings, resolveConfig, type WikiServerConfig } from "./config.js";
import { createLogger, type IConsolidatingLogger } from "./logger.js";
import { startControlServer, type ControlServer } from "./control.js";

/** Build the stream-host options, selecting storage mode by `dataDir` presence (DESIGN §4/§7). */
function serverOptions(c: WikiServerConfig, streamLog: IConsolidatingLogger) {
  return {
    host: c.host,
    port: c.port,
    longPollTimeout: c.longPollTimeout,
    // The stream host's own lifecycle hooks feed the consolidating logger
    // (DESIGN §8.5) — the operationally meaningful stream events.
    onStreamCreated: (e: StreamLifecycleEvent) =>
      streamLog.info("stream created", { path: e.path, contentType: e.contentType }),
    onStreamDeleted: (e: StreamLifecycleEvent) => streamLog.info("stream deleted", { path: e.path }),
    ...(c.storage === "file" ? { dataDir: c.dataDir } : {}),
  };
}

/** Resolve the package version without importing the manifest (keeps `rootDir: src` clean). */
function serverVersion(): string {
  return process.env.npm_package_version ?? "0.1.0";
}

/**
 * Injectable seams for {@link startWikiServer} (DESIGN §11). Production passes
 * nothing — the defaults boot the real stream host, `wiki-mcp`, and control
 * listener. A wiring smoke test overrides {@link WikiServerDeps.startMcp} to boot the
 * stream host + control listener without standing up the full engine/read model,
 * and may override {@link WikiServerDeps.now} for determinism.
 */
export interface WikiServerDeps {
  /**
   * Start `wiki-mcp` against the given stream `baseUrl`, injecting the host's
   * `mcp`-sourced logger. Defaults to {@link createWikiMcp} with config resolved
   * from flags/env. Return `undefined` to skip the hosted module entirely.
   */
  readonly startMcp?: (
    baseUrl: string,
    logger: IConsolidatingLogger,
    transport: McpTransport,
  ) => Promise<{ readonly mcp?: WikiMcp; readonly config: WikiMcpConfig }>;
  /** Process start time (ms epoch) for `uptimeMs`; defaults to "now". */
  readonly startedAt?: number;
}

/** A fully-wired, running wiki-server — both planes plus the control listener. */
export interface RunningWikiServer {
  /** The stream host's base URL clients point at (read back from `server.url`). */
  readonly baseUrl: string;
  /** The control listener's base URL (log/health/info API, DESIGN §8.5). */
  readonly controlUrl: string;
  /** The embedded MCP server's streamable-HTTP endpoint clients connect to (DESIGN §8.5). */
  readonly mcpUrl: string;
  /** The consolidating logger backing the log API (DESIGN §8.5). */
  readonly logger: IConsolidatingLogger;
  /** The hosted `wiki-mcp`, if one was started (DESIGN §3.1). */
  readonly mcp: WikiMcp | undefined;
  /** Drain `wiki-mcp`, the control listener, and the stream host as a unit. */
  stop(): Promise<void>;
}

/** Default `startMcp`: resolve wiki-mcp's config from flags/env and boot it (DESIGN §3.1). */
async function defaultStartMcp(
  baseUrl: string,
  logger: IConsolidatingLogger,
  transport: McpTransport,
): Promise<{ mcp: WikiMcp; config: WikiMcpConfig }> {
  // Derive wiki-mcp's wire config from env/flags via its own resolver, then point its
  // `streamBaseUrl` at THIS host's localhost URL (read back from `server.url`, robust
  // when `port: 0` auto-assigns). wiki-server supplies NO page types of its own
  // (it imports `wiki-mcp`, never `wiki`); a real host injects its set here. The
  // `transport` (streamable HTTP, built from cfg) makes the MCP endpoint network-
  // reachable — an embedded host can't use stdio (that's its own terminal, DESIGN §8.5).
  const config: WikiMcpConfig = { ...resolveMcpConfig(process.argv.slice(2), process.env), streamBaseUrl: baseUrl };
  const mcp = await createWikiMcp({ config, pageTypes: [], logger, transport });
  return { mcp, config };
}

/**
 * Boot the whole wiki-server wiring (DESIGN §3.1, §8.1, §8.5) and return handles for
 * a graceful shutdown. Order matters: stream host first (so its `baseUrl` is known),
 * then `wiki-mcp` pointed at that URL, then the control listener (so `/_server/info`
 * can report the live `baseUrl`).
 */
export async function startWikiServer(
  cfg: WikiServerConfig,
  deps: WikiServerDeps = {},
): Promise<RunningWikiServer> {
  const startedAt = deps.startedAt ?? Date.now();
  const startMcp = deps.startMcp ?? defaultStartMcp;

  // ── 1. the consolidating logger (DESIGN §8.5) ──
  const logger = createLogger({ bufferSize: cfg.logBuffer, format: cfg.logFormat });
  const serverLog = logger.forSource("server");
  const streamLog = logger.forSource("stream");

  for (const warning of configWarnings(cfg)) serverLog.warn(warning);

  // ── 2. start the stream host ──
  const server = new DurableStreamTestServer(serverOptions(cfg, streamLog));
  const baseUrl = await server.start();
  serverLog.info("stream host up", {
    baseUrl,
    storage: cfg.storage,
    dataDir: cfg.storage === "file" ? cfg.dataDir : undefined,
  });

  // ── 3. start wiki-mcp in-process over streamable HTTP (DESIGN §3.1, §6.1) ──
  // The embedded MCP is served over HTTP — NOT stdio — on its own listener so a
  // networked MCP client connects to `mcpUrl`. (stdio would bind the host process's
  // own terminal, unreachable by a separate client.)
  const mcpTransport: McpTransport = { kind: "http", host: cfg.host, port: cfg.mcpPort, path: "/mcp" };
  const mcpUrl = `http://${cfg.host}:${cfg.mcpPort}/mcp`;
  const started = await startMcp(baseUrl, logger.forSource("mcp"), mcpTransport);
  const mcp = started.mcp;
  serverLog.info("wiki-mcp up", {
    namespace: started.config.namespace,
    streamBaseUrl: started.config.streamBaseUrl,
    mcpUrl,
  });

  // Load boot-time model bundles (ADR-M6) so the engine gains its page types via dynamic
  // import; `mcp.models.load` awaits the rebind + reproject. (Absent when a test stubs the
  // hosted module out.)
  const models = mcp?.models;
  if (models !== undefined) {
    for (const m of cfg.models) {
      await models.load(m.id, m.specifier);
      serverLog.info("model bundle loaded", { id: m.id, specifier: m.specifier });
    }
  }

  // ── 4. start the control listener (DESIGN §8.5) ──
  const control: ControlServer = await startControlServer({
    host: cfg.host,
    port: cfg.controlPort,
    logger,
    info: { version: serverVersion(), storage: cfg.storage, baseUrl, mcpUrl },
    startedAt,
    models,
  });
  serverLog.info("control listener up", { url: control.url });

  serverLog.info("wiki-server ready", {
    baseUrl,
    controlUrl: control.url,
    mcpUrl,
    storage: cfg.storage,
    namespace: started.config.namespace,
  });

  return {
    baseUrl,
    controlUrl: control.url,
    mcpUrl,
    logger,
    mcp,
    /**
     * Stop wiki-mcp, the control listener, and the stream host. wiki-mcp drains its
     * tailer + MCP server and closes the engine + read-model store; the stream host
     * drains connections, cancels long-polls/SSE, and closes the store (each append
     * is already fsynced in file mode, so there is no final-flush window to lose).
     * Surfaces the first failure once all three have settled.
     */
    async stop(): Promise<void> {
      const results = await Promise.allSettled([mcp?.close(), control.stop(), server.stop()]);
      const failed = results.find((r) => r.status === "rejected");
      if (failed !== undefined) throw (failed as PromiseRejectedResult).reason;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// bin entry (standalone) — resolve config, start the wiring, trap signals (DESIGN §8.1)
// ────────────────────────────────────────────────────────────────────────────

/** Run as the standalone host: boot everything and shut down cleanly on SIGINT/SIGTERM. */
async function main(): Promise<void> {
  const cfg = resolveConfig(process.argv.slice(2), process.env);
  const running = await startWikiServer(cfg);

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    running.logger.forSource("server").info("shutting down", { signal });
    running
      .stop()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        console.error(`[wiki-server] shutdown error:`, err);
        process.exit(1);
      });
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => shutdown(signal));
  }
}

// Run only when invoked directly as the bin (not when imported by a test/host).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(`[wiki-server] failed to start:`, err);
    process.exit(1);
  });
}
