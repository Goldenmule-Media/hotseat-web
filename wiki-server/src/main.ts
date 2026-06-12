#!/usr/bin/env node
/**
 * wiki-server entrypoint. One deployable that hosts BOTH
 * planes in a single lifecycle:
 *
 *   1. build the **consolidating logger**;
 *   2. start the **stream host** ({@link DurableStreamTestServer}), wiring its
 *      `onStreamCreated`/`onStreamDeleted` hooks into the logger (`source: stream`);
 *   3. start **`wiki-mcp`** in-process via `createWikiMcp({ baseUrl: server.url,
 *      namespace, db, logger })` (`source: mcp`) — the hosted engine + SQL read
 *      model + MCP surface;
 *   4. start the **control listener** (log/health/info API) on
 *      `controlPort`; and
 *   5. trap signals for a graceful `stop()` of **all three**.
 *
 * `wiki-server` stays thin wiring (G1/G2): it imports
 * `@durable-streams/server` and `wiki-mcp` — **never `wiki` directly** — and owns no
 * engine/read-model/MCP logic of its own.
 *
 * The wiring is factored into {@link startWikiServer} so a host/test can boot the
 * same three subsystems and `stop()` them as a unit; the `bin` guard at the bottom
 * resolves config, starts them, and traps signals.
 */
import type { IncomingMessage } from "node:http";
import { join } from "node:path";

import { DurableStreamTestServer, type StreamLifecycleEvent } from "@durable-streams/server";
import { createWikiMcp, resolveConfig as resolveMcpConfig, type McpAuth, type McpTransport, type WikiMcp, type WikiMcpConfig } from "wiki-mcp";

// NOTE: `.js` extensions are required because wiki-server is COMPILED and run via
// `node dist/main.js` (raw Node ESM needs explicit extensions). This differs from
// `wiki/`, which is consumed as TS source and so imports extensionless. The
// `wiki-mcp` / `@durable-streams/server` imports above are bare package specifiers.
import { applyDotEnv, configWarnings, discoverModelBundles, resolveConfig, type WikiServerConfig } from "./config.js";
import { createLogger, type IConsolidatingLogger } from "./logger.js";
import { startControlServer, type ControlServer } from "./control.js";
import { AccessStore } from "./auth/access.js";
import { startGateway, type Gateway } from "./auth/gateway.js";
import { protectedResourceMetadata } from "./auth/oauth.js";
import { ensureSessionSecret, ephemeralSessionSecret } from "./auth/secret.js";
import { bearerSession } from "./auth/tokens.js";

/**
 * Build the stream-host options, selecting storage mode by `dataDir` presence.
 * In auth mode the host binds `bind` (an internal loopback ephemeral port — the
 * gateway owns the public address); otherwise `bind` is the public config address.
 */
function serverOptions(c: WikiServerConfig, bind: { host: string; port: number }, streamLog: IConsolidatingLogger) {
  return {
    host: bind.host,
    port: bind.port,
    longPollTimeout: c.longPollTimeout,
    // The stream host's own lifecycle hooks feed the consolidating logger
    // — the operationally meaningful stream events.
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
 * Injectable seams for {@link startWikiServer}. Production passes
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
    auth?: McpAuth,
  ) => Promise<{ readonly mcp?: WikiMcp; readonly config: WikiMcpConfig }>;
  /** Process start time (ms epoch) for `uptimeMs`; defaults to "now". */
  readonly startedAt?: number;
}

/** A fully-wired, running wiki-server — both planes plus the control listener. */
export interface RunningWikiServer {
  /** The stream host's base URL clients point at (read back from `server.url`). */
  readonly baseUrl: string;
  /** The control listener's base URL (log/health/info API). */
  readonly controlUrl: string;
  /** The embedded MCP server's streamable-HTTP endpoint clients connect to. */
  readonly mcpUrl: string;
  /** The consolidating logger backing the log API. */
  readonly logger: IConsolidatingLogger;
  /** The hosted `wiki-mcp`, if one was started. */
  readonly mcp: WikiMcp | undefined;
  /** Drain `wiki-mcp`, the control listener, and the stream host as a unit. */
  stop(): Promise<void>;
}

/** Default `startMcp`: resolve wiki-mcp's config from flags/env and boot it. */
async function defaultStartMcp(
  baseUrl: string,
  logger: IConsolidatingLogger,
  transport: McpTransport,
  auth?: McpAuth,
): Promise<{ mcp: WikiMcp; config: WikiMcpConfig }> {
  // Derive wiki-mcp's wire config from env/flags via its own resolver, then point its
  // `streamBaseUrl` at THIS host's localhost URL (read back from `server.url`, robust
  // when `port: 0` auto-assigns). wiki-server supplies NO page types of its own
  // (it imports `wiki-mcp`, never `wiki`); a real host injects its set here. The
  // `transport` (streamable HTTP, built from cfg) makes the MCP endpoint network-
  // reachable — an embedded host can't use stdio (that's its own terminal).
  const config: WikiMcpConfig = { ...resolveMcpConfig(process.argv.slice(2), process.env), streamBaseUrl: baseUrl };
  const mcp = await createWikiMcp({ config, pageTypes: [], logger, transport, ...(auth !== undefined ? { auth } : {}) });
  return { mcp, config };
}

/**
 * Boot the whole wiki-server wiring and return handles for
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
  const authEnabled = cfg.auth === "github";

  // ── 1. the consolidating logger ──
  const logger = createLogger({ bufferSize: cfg.logBuffer, format: cfg.logFormat });
  const serverLog = logger.forSource("server");
  const streamLog = logger.forSource("stream");

  for (const warning of configWarnings(cfg)) serverLog.warn(warning);

  // ── 2. start the stream host ──
  // Auth mode: the host hides on an internal loopback ephemeral port and the auth
  // gateway (started below) takes the PUBLIC `cfg.host:cfg.port` in its place. The
  // in-process consumers (wiki-mcp's engine) keep talking to the internal URL — they
  // enforce the same ledger at their own surface, so no request loops back through
  // the gateway.
  const streamBind = authEnabled ? { host: "127.0.0.1", port: 0 } : { host: cfg.host, port: cfg.port };
  const server = new DurableStreamTestServer(serverOptions(cfg, streamBind, streamLog));
  const internalBaseUrl = await server.start();
  serverLog.info("stream host up", {
    baseUrl: internalBaseUrl,
    internal: authEnabled,
    storage: cfg.storage,
    dataDir: cfg.storage === "file" ? cfg.dataDir : undefined,
  });

  // ── 2b. the auth plane (github mode): session secret, access ledger, McpAuth ──
  // `storage=memory` keeps auth state ephemeral too (no disk writes): a persisted
  // ledger over vanished streams would hold claims on workspace ids that no longer
  // exist, and dataDir is documented as ignored in memory mode.
  const authDir = join(cfg.dataDir, "auth");
  const persistAuth = cfg.storage === "file";
  const sessionSecret = authEnabled
    ? (cfg.sessionSecret ?? (persistAuth ? ensureSessionSecret(authDir) : ephemeralSessionSecret()))
    : undefined;
  const store = authEnabled ? new AccessStore(authDir, { persist: persistAuth }) : undefined;
  const nowSeconds = (): number => Math.floor(Date.now() / 1000);
  const mcpAuth: McpAuth | undefined =
    authEnabled && sessionSecret !== undefined && store !== undefined
      ? {
          authenticate: (headers) => {
            const session = bearerSession(sessionSecret, headers.authorization, nowSeconds());
            return session !== undefined
              ? { login: session.login, ...(session.name !== undefined ? { name: session.name } : {}) }
              : undefined;
          },
          canAccess: (user, workspaceId) => store.canAccess(user.login, workspaceId),
          // Unclaimed workspaces have NO owner, and member-level users can already
          // rewrite their content — so admin verbs stay open there too (mirrors the
          // gateway's open-until-claimed policy; claiming then locks them down).
          canAdmin: (user, workspaceId) => store.isOwner(user.login, workspaceId) || store.record(workspaceId) === undefined,
          onWorkspaceCreated: (user, workspaceId) => {
            if (store.claim(user.login, workspaceId)) {
              logger.forSource("auth").info("workspace created and claimed", { workspace: workspaceId, owner: user.login });
            }
          },
        }
      : undefined;

  // ── 3. start wiki-mcp in-process over streamable HTTP ──
  // The embedded MCP is served over HTTP — NOT stdio — on its own listener so a
  // networked MCP client connects to `mcpUrl`. (stdio would bind the host process's
  // own terminal, unreachable by a separate client.)
  const mcpUrl = `http://${cfg.host}:${cfg.mcpPort}/mcp`;
  // Auth mode injects OAuth discovery (RFC 9728) into the MCP transport: the 401
  // names the gateway's resource-metadata URL, and the MCP listener serves its
  // own protected-resource document for origin-based discovery. Both are opaque
  // values to wiki-mcp — it learns no OAuth concepts.
  const mcpTransport: McpTransport = {
    kind: "http",
    host: cfg.host,
    port: cfg.mcpPort,
    path: "/mcp",
    ...(authEnabled
      ? {
          authDiscovery: {
            resourceMetadataUrl: `${cfg.publicUrl}/.well-known/oauth-protected-resource`,
            protectedResourceDocument: protectedResourceMetadata(mcpUrl, cfg.publicUrl),
          },
        }
      : {}),
  };
  const started = await startMcp(internalBaseUrl, logger.forSource("mcp"), mcpTransport, mcpAuth);
  const mcp = started.mcp;
  if (authEnabled && (started.config.namespace === "auth" || started.config.namespace === ".well-known")) {
    throw new Error(
      `the MCP namespace may not be "${started.config.namespace}" when --auth is on (it would shadow the gateway's /auth/* or /.well-known/* routes)`,
    );
  }
  serverLog.info("wiki-mcp up", {
    namespace: started.config.namespace,
    streamBaseUrl: started.config.streamBaseUrl,
    mcpUrl,
  });

  // Load boot-time model bundles (ADR-M6) so the engine gains its page types via dynamic
  // import; `mcp.models.load` awaits the rebind + reproject. (Absent when a test stubs the
  // hosted module out.) Bundles discovered under `--models-dir` load alongside the explicit
  // `--models`; an explicit entry of the same id wins. Discovered loads are RESILIENT — a
  // file that isn't a bundle (e.g. a shared chunk in a built tree, or a sourcemap) is skipped
  // with a warning rather than aborting boot; an explicit `--models` entry still hard-fails.
  const models = mcp?.models;
  if (models !== undefined) {
    const explicit = new Set(cfg.models.map((m) => m.id));
    const discovered = cfg.modelsDir !== undefined ? discoverModelBundles(cfg.modelsDir) : [];
    if (cfg.modelsDir !== undefined) {
      serverLog.info("model bundles discovered", { dir: cfg.modelsDir, ids: discovered.map((m) => m.id) });
      if (discovered.length === 0) serverLog.warn("no model bundles discovered", { dir: cfg.modelsDir });
    }
    for (const m of discovered) {
      if (explicit.has(m.id)) continue; // an explicit --models entry of the same id wins (loaded below)
      try {
        await models.load(m.id, m.specifier);
        serverLog.info("model bundle loaded", { id: m.id, specifier: m.specifier, source: "discovered" });
      } catch (err) {
        serverLog.warn("skipped unloadable discovered bundle", {
          id: m.id,
          specifier: m.specifier,
          error: (err as Error).message,
        });
      }
    }
    for (const m of cfg.models) {
      await models.load(m.id, m.specifier);
      serverLog.info("model bundle loaded", { id: m.id, specifier: m.specifier, source: "explicit" });
    }
  }

  // ── 4. start the auth gateway (github mode) — the public stream address ──
  let gateway: Gateway | undefined;
  if (authEnabled && sessionSecret !== undefined && store !== undefined) {
    gateway = await startGateway({
      host: cfg.host,
      port: cfg.port,
      internalBaseUrl,
      publicUrl: cfg.publicUrl,
      uiOrigins: cfg.uiOrigins,
      github: {
        // resolveConfig guarantees both when `auth === "github"`.
        clientId: cfg.githubClientId ?? "",
        clientSecret: cfg.githubClientSecret ?? "",
        callbackUrl: `${cfg.publicUrl}/auth/github/callback`,
      },
      ...(cfg.authUsers !== undefined ? { allowedUsers: cfg.authUsers } : {}),
      sessionSecret,
      sessionTtlSeconds: cfg.sessionTtlDays * 86_400,
      accessTokenTtlSeconds: cfg.accessTokenTtlSeconds,
      refreshTokenTtlSeconds: cfg.refreshTokenTtlDays * 86_400,
      store,
      logger,
    });
  }
  /** What clients point at: the gateway when auth is on, the raw host otherwise. */
  const baseUrl = gateway?.url ?? internalBaseUrl;

  // ── 5. start the control listener ──
  // Auth mode binds it LOOPBACK-ONLY regardless of cfg.host: its privileged
  // surface (model loads = arbitrary dynamic import, unregisters, full logs) is
  // host administration, and "holds any valid session" is not "operator". The
  // bearer gate below stays as defense in depth for local processes.
  const control: ControlServer = await startControlServer({
    host: authEnabled ? "127.0.0.1" : cfg.host,
    port: cfg.controlPort,
    logger,
    info: { version: serverVersion(), storage: cfg.storage, baseUrl, mcpUrl },
    startedAt,
    models,
    ...(authEnabled && sessionSecret !== undefined
      ? { authenticate: (req: IncomingMessage) => bearerSession(sessionSecret, req.headers.authorization, nowSeconds()) !== undefined }
      : {}),
  });
  serverLog.info("control listener up", { url: control.url });

  serverLog.info("wiki-server ready", {
    baseUrl,
    controlUrl: control.url,
    mcpUrl,
    storage: cfg.storage,
    namespace: started.config.namespace,
    auth: cfg.auth,
  });

  return {
    baseUrl,
    controlUrl: control.url,
    mcpUrl,
    logger,
    mcp,
    /**
     * Stop wiki-mcp, the control listener, the gateway, and the stream host.
     * wiki-mcp drains its tailer + MCP server and closes the engine + read-model
     * store; the stream host drains connections, cancels long-polls/SSE, and closes
     * the store (each append is already fsynced in file mode, so there is no
     * final-flush window to lose). Surfaces the first failure once all have settled.
     */
    async stop(): Promise<void> {
      const results = await Promise.allSettled([mcp?.close(), control.stop(), gateway?.stop(), server.stop(), store?.flush()]);
      const failed = results.find((r) => r.status === "rejected");
      if (failed !== undefined) throw (failed as PromiseRejectedResult).reason;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// bin entry (standalone) — resolve config, start the wiring, trap signals
// ────────────────────────────────────────────────────────────────────────────

/** Run as the standalone host: boot everything and shut down cleanly on SIGINT/SIGTERM. */
async function main(): Promise<void> {
  // Seed unset env keys from a `.env` BEFORE any resolution, so both this
  // resolver and the embedded wiki-mcp's (`WIKI_MCP_*`) see the same file. Two
  // candidates: the script cwd (wiki-server/ under npm workspaces) AND npm's
  // INIT_CWD — the directory `npm start` was typed in, which is where the
  // repo-root `.env` documented by `.env.example` actually lives. Unset-keys-only
  // semantics make the double application safe.
  applyDotEnv(process.env);
  if (process.env.INIT_CWD !== undefined) applyDotEnv(process.env, join(process.env.INIT_CWD, ".env"));
  const cfg = resolveConfig(process.argv.slice(2), process.env);
  const running = await startWikiServer(cfg);

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    running.logger.forSource("server").info("shutting down", { signal });
    // Backstop: if a subsystem's stop() never resolves (e.g. an external listener waiting
    // on a socket that won't drain), force-exit rather than hang the terminal forever.
    // `unref()` so it never keeps the loop alive when a clean stop DOES finish first.
    const watchdog = setTimeout(() => {
      console.error(`[wiki-server] shutdown timed out after 5s — forcing exit`);
      process.exit(1);
    }, 5000);
    watchdog.unref();
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
