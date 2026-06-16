/**
 * The local health endpoint. `wiki-mirror` is otherwise a headless tail-loop process; this
 * small `http.createServer` (modeled on wiki-server's control listener) lets a client — chiefly
 * wiki-ui — see whether a mirror is running on this machine and whether it is keeping pace:
 *
 * | Method · path | Purpose |
 * |---|---|
 * | `GET /_mirror/health` | liveness — always `200 {status:"ok"}` while the process is up |
 * | `GET /_mirror/status` | `{ status, uptimeMs, namespace, streamBaseUrl, workspaces[] }` |
 *
 * Unlike wiki-server's CORS-free, loopback-only control listener, every response carries
 * permissive CORS: wiki-ui runs at a *different* origin (`localhost:3000`) and reads this
 * cross-origin, exactly as it already reads the Durable Streams host. It binds loopback by
 * default — it is unauthenticated and exposes local roots/versions, matching the mirror's
 * local-only trust model.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { Logger } from "./logger.js";
import type { MirrorWorkspaceStatus, WorkspaceMirror } from "./mirror.js";

/** JSON shape of `GET /_mirror/status`. */
export interface MirrorStatusResponse {
  /** "degraded" if any workspace has a reconcile error or isn't tailing; else "ok". */
  readonly status: "ok" | "degraded";
  readonly uptimeMs: number;
  readonly namespace: string;
  readonly streamBaseUrl: string;
  readonly workspaces: readonly MirrorWorkspaceStatus[];
}

/** What {@link startHealthServer} needs to answer the status probe. */
export interface HealthServerOptions {
  readonly host: string;
  readonly port: number;
  readonly namespace: string;
  readonly streamBaseUrl: string;
  /** The running tail loops; their `status()` is read live per request (empty = mirror up, nothing mirrored). */
  readonly mirrors: readonly WorkspaceMirror[];
  /** Process start time (ms epoch) for `uptimeMs`; defaults to "now". */
  readonly startedAt?: number;
  readonly logger?: Logger;
}

/** A started health listener; `stop()` closes it. */
export interface HealthServer {
  /** The bound base URL (e.g. `http://127.0.0.1:4440`). */
  readonly url: string;
  stop(): Promise<void>;
}

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};

/**
 * Start the health HTTP listener. Resolves once bound; the returned {@link HealthServer}
 * exposes its URL and a graceful `stop()`. Rejects if the port can't be bound.
 */
export function startHealthServer(options: HealthServerOptions): Promise<HealthServer> {
  const { host, port, namespace, streamBaseUrl, mirrors } = options;
  const startedAt = options.startedAt ?? Date.now();

  const buildStatus = async (): Promise<MirrorStatusResponse> => {
    const workspaces = await Promise.all(mirrors.map((m) => m.status()));
    const degraded = workspaces.some((w) => w.lastReconcileError !== null || !w.connected);
    return {
      status: degraded ? "degraded" : "ok",
      uptimeMs: Date.now() - startedAt,
      namespace,
      streamBaseUrl,
      workspaces,
    };
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res, buildStatus);
  });

  return new Promise<HealthServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      // Read the ACTUAL bound port back — robust when `port: 0` auto-assigns (used by tests).
      const address = server.address();
      const boundPort = typeof address === "object" && address !== null ? address.port : port;
      resolve({
        url: `http://${host}:${boundPort}`,
        stop(): Promise<void> {
          return new Promise((res2, rej) => {
            server.close((err) => (err ? rej(err) : res2()));
            // close() waits forever for idle keep-alive sockets; destroy them so it fires.
            server.closeAllConnections();
          });
        },
      });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  buildStatus: () => Promise<MirrorStatusResponse>,
): Promise<void> {
  const path = (req.url ?? "/").split("?")[0];

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed", method: req.method });
    return;
  }
  if (path === "/_mirror/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }
  if (path === "/_mirror/status") {
    sendJson(res, 200, await buildStatus());
    return;
  }
  sendJson(res, 404, { error: "not_found", path });
}

/** Write a JSON response with the given status and permissive CORS. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...CORS_HEADERS, "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
