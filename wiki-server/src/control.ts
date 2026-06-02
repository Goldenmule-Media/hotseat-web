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

/** The outcome of a model-registry change (mirrors wiki-mcp's `ModelRegistryEvent`). */
export interface ModelEvent {
  readonly generation: number;
  readonly fingerprint: string;
  readonly reason: string;
  readonly bundleId: string;
}

/**
 * The model-registry control seam (ADR-M6) that `/_server/models` proxies into —
 * structurally satisfied by `wiki-mcp`'s `ModelRegistry`. `wiki-server` stays
 * schema-agnostic: it forwards a bundle **id + module specifier** and never imports the
 * bundle itself (the embedded `wiki-mcp` does the dynamic `import()`).
 */
export interface ModelsControl {
  /** Loaded bundles (for `GET /_server/models`). */
  list(): { id: string; specifier: string; types: string[] }[];
  /** The current registry generation (bumps on every change). */
  generation(): number;
  /** Load or hard-replace a bundle, then rebind + reproject (awaits the whole reaction). */
  load(id: string, specifier: string): Promise<ModelEvent>;
  /** Re-import a known bundle's specifier (cache-busted) — pick up a rebuild. */
  reload(id: string): Promise<ModelEvent>;
  /** Hard-unregister a bundle (workspaces with live events of its types then halt). */
  unregister(id: string): Promise<ModelEvent>;
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
  /** The model registry `/_server/models` proxies into (ADR-M6). Omit → the route 503s. */
  readonly models?: ModelsControl;
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
  const { host, port, logger, info, models } = options;
  const isReady = options.isReady ?? (() => true);
  const startedAt = options.startedAt ?? Date.now();

  /** Open SSE tails, tracked so `stop()` can end them. */
  const openTails = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    handle(req, res, { logger, info, isReady, startedAt, openTails, models });
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
  readonly models: ModelsControl | undefined;
}

/** Route one request (DESIGN §8.5). GET on the log/health/info paths; the models route also takes POST/DELETE. */
function handle(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  // The model-registry control surface (ADR-M6) — GET/POST/DELETE — is async; it owns
  // its own method handling, so route it BEFORE the GET-only guard below.
  if (path === "/_server/models" || path.startsWith("/_server/models/")) {
    void handleModels(req, res, path, ctx);
    return;
  }

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

/**
 * The model-registry control surface (ADR-M6) — pipeline-driven, NOT agent-facing:
 *
 * | Method · path | Action |
 * |---|---|
 * | `GET /_server/models` | `{ generation, bundles: [{ id, specifier, types }] }` |
 * | `POST /_server/models` · body `{ id, specifier }` | load (or hard-replace) a bundle → rebind + reproject |
 * | `POST /_server/models/<id>/reload` | re-import a known bundle's specifier (cache-busted) |
 * | `DELETE /_server/models/<id>` | hard-unregister a bundle |
 *
 * The change result is the {@link ModelEvent}. `503` when no registry is wired, `400` on a
 * bad body, `404` on an unknown bundle id. The call returns only AFTER the rebind +
 * reproject completes (the registry awaits it), so a build pipeline can sequence on it.
 */
async function handleModels(req: IncomingMessage, res: ServerResponse, path: string, ctx: HandlerCtx): Promise<void> {
  const models = ctx.models;
  if (models === undefined) {
    sendJson(res, 503, { error: "models_unavailable", message: "no model registry is hosted by this server" });
    return;
  }
  // ["_server", "models", <id>?, "reload"?]
  const segs = path.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  const log = ctx.logger.forSource("server");

  try {
    if (segs.length === 2) {
      if (req.method === "GET") {
        sendJson(res, 200, { generation: models.generation(), bundles: models.list() });
        return;
      }
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const id = body?.id;
        const specifier = body?.specifier;
        if (typeof id !== "string" || typeof specifier !== "string") {
          sendJson(res, 400, { error: "bad_request", message: "POST /_server/models requires a JSON body { id, specifier }" });
          return;
        }
        const event = await models.load(id, specifier);
        log.info("model bundle loaded via control API", { id, specifier, generation: event.generation });
        sendJson(res, 200, event);
        return;
      }
    } else if (segs.length === 3 && req.method === "DELETE") {
      const event = await models.unregister(segs[2]);
      log.info("model bundle unregistered via control API", { id: segs[2], generation: event.generation });
      sendJson(res, 200, event);
      return;
    } else if (segs.length === 4 && segs[3] === "reload" && req.method === "POST") {
      const event = await models.reload(segs[2]);
      log.info("model bundle reloaded via control API", { id: segs[2], generation: event.generation });
      sendJson(res, 200, event);
      return;
    }
    sendJson(res, 405, { error: "method_not_allowed", method: req.method, path });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /unknown model bundle/.test(message) ? 404 : 400;
    log.warn("models control error", { path, method: req.method, error: message });
    sendJson(res, status, { error: "models_error", message });
  }
}

/** Read and JSON-parse a request body; `undefined` on empty or malformed input. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Write a JSON response with the given status. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}
