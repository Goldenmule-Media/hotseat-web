/**
 * The plain front door: what owns the public port when auth is OFF.
 *
 * The stream host treats every non-reserved path as a stream path and cannot be
 * extended, so any surface the server wants to serve alongside streams — today the
 * attachment store — has to be intercepted in front of it. Under `--auth github` the
 * auth gateway is that front door. This is its unauthenticated counterpart, so the
 * two modes have the SAME topology: the stream host always hides on an internal
 * loopback port, and clients always see one base URL that serves both streams and
 * blobs. Without it, blobs would be reachable in production and missing in local
 * development, which is the sort of asymmetry that only shows up late.
 *
 * It enforces nothing. Local, unauthenticated mode is already open by definition.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { handleBlobRequest, matchBlobRoute, type BlobRoutesConfig } from "./blobs/routes.js";
import type { IConsolidatingLogger } from "./logger.js";
import { proxyRequest } from "./proxy.js";

export interface FrontDoorConfig {
  readonly host: string;
  readonly port: number;
  /** The internal stream host to proxy to. */
  readonly internalBaseUrl: string;
  readonly blobs: BlobRoutesConfig;
  readonly logger: IConsolidatingLogger;
}

export interface FrontDoor {
  /** The bound public base URL (port read back, so `port: 0` works). */
  readonly url: string;
  stop(): Promise<void>;
}

export async function startFrontDoor(cfg: FrontDoorConfig): Promise<FrontDoor> {
  const log = cfg.logger.forSource("server");
  const internal = new URL(cfg.internalBaseUrl);

  const server: HttpServer = createServer((req, res) => {
    let segments: string[];
    try {
      segments = new URL(req.url ?? "/", "http://front.local").pathname
        .split("/")
        .filter((s) => s.length > 0)
        .map((s) => decodeURIComponent(s));
    } catch {
      // A malformed percent-escape throws in decodeURIComponent; this runs on every
      // request, so it must never escape and kill the listener.
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "malformed request path" }));
      return;
    }
    const route = matchBlobRoute(segments);
    if (route !== undefined) {
      void handleBlobRequest(req, res, route, cfg.blobs).catch((err: unknown) => {
        log.error("blob request failed", { path: req.url, error: (err as Error).message });
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        } else {
          res.destroy();
        }
      });
      return;
    }
    proxyRequest(req, res, internal, {
      onError: (err) => log.error("proxy upstream error", { method: req.method, path: req.url, error: err.message }),
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, cfg.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  const url = `http://${cfg.host}:${addr.port}`;

  return {
    url,
    stop: () =>
      new Promise<void>((resolve, rejectStop) => {
        server.close((err) => (err !== undefined && err !== null ? rejectStop(err) : resolve()));
        server.closeAllConnections?.();
      }),
  };
}
