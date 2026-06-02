/**
 * The control listener (DESIGN §8.5). The wrapped `DurableStreamTestServer` hosts
 * no extra paths (DESIGN §4), so `wiki-server` runs its **own** small
 * `http.createServer` — SEPARATE from the stream host, on `--control-port`
 * (default stream port + 1) — to serve the log/health/info API:
 *
 * | Method · path | Purpose |
 * |---|---|
 * | `GET /_server/logs?since=&boot=&limit=&level=&source=` | log **history** (ring buffer) |
 * | `GET /_server/logs?follow=1&since=&boot=` | log **tail** (backlog then live SSE) |
 * | `GET /_server/health` | liveness/readiness |
 * | `GET /_server/info` | `{ version, boot, storage, baseUrl, mcpUrl?, pid, uptimeMs }` |
 *
 * It is NOT a durable stream — it reads from the consolidating logger's ring buffer
 * and subscribes to its live feed (DESIGN §8.5). It has no built-in auth, so for a
 * shared deploy it binds loopback-only behind the reverse proxy (DESIGN §9).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

// NOTE: `.js` extensions are required because wiki-server is COMPILED and run via
// `node dist/main.js` (raw Node ESM needs explicit extensions).
import type {
  IConsolidatingLogger,
  LogHistoryQuery,
  LogLevel,
  LogRecord,
  LogSource,
} from "./logger.js";

/** Server facts surfaced by `GET /_server/info` (DESIGN §8.5). Mutable bits are read live. */
export interface ControlInfo {
  /** Package version (from `wiki-server`'s manifest). */
  readonly version: string;
  /** "file" or "memory" — the resolved storage mode. */
  readonly storage: "file" | "memory";
  /** The stream host's base URL (read back from `server.url` after start). */
  readonly baseUrl: string;
  /** The embedded MCP server's streamable-HTTP endpoint, if one is hosted (DESIGN §6.1). */
  readonly mcpUrl?: string;
}

/** What {@link startControlServer} needs to wire the API to the running host. */
export interface ControlServerOptions {
  /** Bind host (loopback by default, DESIGN §9). */
  readonly host: string;
  /** Control port (DESIGN §6 `--control-port`). */
  readonly port: number;
  /** The consolidating logger backing `/_server/logs` (DESIGN §8.5). */
  readonly logger: IConsolidatingLogger;
  /** Static server facts for `/_server/info`. */
  readonly info: ControlInfo;
  /**
   * Liveness/readiness probe for `/_server/health`. Returns `true` when ready
   * (→ `200 {status:"ok"}`), `false` when not (→ `503`). Defaults to always-ready.
   */
  readonly isReady?: () => boolean;
  /** Process start time (ms epoch) for `uptimeMs`; defaults to "now". */
  readonly startedAt?: number;
}

/** A started control listener; `stop()` closes it and drains SSE tails. */
export interface ControlServer {
  /** The bound base URL (e.g. `http://127.0.0.1:4438`). */
  readonly url: string;
  /** Close the listener and end any open SSE tails. */
  stop(): Promise<void>;
}

/**
 * Start the control HTTP listener (DESIGN §8.5). Resolves once it is bound; the
 * returned {@link ControlServer} exposes its URL and a graceful `stop()`.
 */
export function startControlServer(options: ControlServerOptions): Promise<ControlServer> {
  const { host, port, logger, info } = options;
  const isReady = options.isReady ?? (() => true);
  const startedAt = options.startedAt ?? Date.now();

  /** Open SSE tails, tracked so `stop()` can end them. */
  const openTails = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    handle(req, res, { logger, info, isReady, startedAt, openTails });
  });

  return new Promise<ControlServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      // Read the ACTUAL bound port back from the listener — robust when `port: 0`
      // auto-assigns (mirrors the stream host reading back `server.url`, DESIGN §6).
      const address = server.address();
      const boundPort = typeof address === "object" && address !== null ? address.port : port;
      resolve({
        url: `http://${host}:${boundPort}`,
        stop(): Promise<void> {
          for (const tail of openTails) tail.end();
          openTails.clear();
          return new Promise((res2, rej) => server.close((err) => (err ? rej(err) : res2())));
        },
      });
    });
  });
}

interface HandlerCtx {
  readonly logger: IConsolidatingLogger;
  readonly info: ControlInfo;
  readonly isReady: () => boolean;
  readonly startedAt: number;
  readonly openTails: Set<ServerResponse>;
}

/** Route one request (DESIGN §8.5). Only `GET` on the documented paths is served. */
function handle(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed", method: req.method });
    return;
  }

  if (path === "/_server/health") {
    if (ctx.isReady()) sendJson(res, 200, { status: "ok" });
    else sendJson(res, 503, { status: "unavailable" });
    return;
  }

  if (path === "/_server/info") {
    sendJson(res, 200, {
      version: ctx.info.version,
      boot: ctx.logger.boot,
      storage: ctx.info.storage,
      baseUrl: ctx.info.baseUrl,
      ...(ctx.info.mcpUrl !== undefined ? { mcpUrl: ctx.info.mcpUrl } : {}),
      pid: process.pid,
      uptimeMs: Date.now() - ctx.startedAt,
    });
    return;
  }

  if (path === "/_server/logs") {
    if (url.searchParams.get("follow") === "1") tailLogs(url, res, ctx);
    else historyLogs(url, res, ctx);
    return;
  }

  sendJson(res, 404, { error: "not_found", path });
}

/** `GET /_server/logs` history mode — read the ring buffer (DESIGN §8.5). */
function historyLogs(url: URL, res: ServerResponse, ctx: HandlerCtx): void {
  const query = parseQuery(url);
  const result = ctx.logger.history(query);
  sendJson(res, 200, result);
}

/**
 * `GET /_server/logs?follow=1` tail mode — backlog from the buffer, then live via
 * SSE (DESIGN §8.5). One `LogRecord` per event. We snapshot the backlog and capture
 * the live subscription's first `seq` so a record arriving mid-snapshot isn't
 * dropped or duplicated.
 */
function tailLogs(url: URL, res: ServerResponse, ctx: HandlerCtx): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  // Flush the response head immediately so a client's request resolves even when the
  // backlog is empty (e.g. a `since=` tail that filters out everything held) — without
  // this, Node may hold the headers until the first body write, hanging the open.
  res.flushHeaders();

  const query = parseQuery(url);
  // Subscribe FIRST, buffering live records, so nothing between the backlog read
  // and the subscription is lost.
  let lastSent = query.since ?? -1;
  const sse = (record: LogRecord): void => {
    if (record.seq <= lastSent) return;
    lastSent = record.seq;
    res.write(`data: ${JSON.stringify(record)}\n\n`);
  };
  const unsubscribe = ctx.logger.subscribe(sse);

  // Flush the backlog (records already in the buffer above `since`), then let the
  // live feed take over. `sse`'s `lastSent` guard de-dupes the overlap.
  for (const record of ctx.logger.history(query).records) sse(record);

  ctx.openTails.add(res);
  const cleanup = (): void => {
    unsubscribe();
    ctx.openTails.delete(res);
  };
  res.on("close", cleanup);
  res.on("error", cleanup);
}

/** Parse the `/_server/logs` query string into a {@link LogHistoryQuery}. */
function parseQuery(url: URL): LogHistoryQuery {
  const p = url.searchParams;
  const query: {
    since?: number;
    boot?: string;
    limit?: number;
    level?: LogLevel;
    source?: LogSource;
  } = {};
  const since = toInt(p.get("since"));
  if (since !== undefined) query.since = since;
  const boot = p.get("boot");
  if (boot !== null) query.boot = boot;
  const limit = toInt(p.get("limit"));
  if (limit !== undefined) query.limit = limit;
  const level = p.get("level");
  if (level === "info" || level === "warn" || level === "error") query.level = level;
  const source = p.get("source");
  if (source === "server" || source === "stream" || source === "mcp") query.source = source;
  return query;
}

/** Parse a non-negative integer query param, or `undefined` if absent/malformed. */
function toInt(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Write a JSON response with the given status. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}
