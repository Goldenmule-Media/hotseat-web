/**
 * The reverse proxy both front doors use to reach the stream host.
 *
 * The stream host treats every non-reserved path as a stream path and cannot be
 * extended without patching the vendored package, so anything the server wants to
 * serve at the public address — the auth routes, the blob routes — must be
 * intercepted in FRONT of it. That makes a proxy leg unavoidable, and this is it:
 * one implementation shared by the auth gateway and the plain front door, so the two
 * auth modes cannot drift in how they forward a request.
 *
 * Bodies pipe through unbuffered in both directions, which is what keeps SSE tails
 * and long-polls streaming chunk by chunk instead of stalling until completion.
 */
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";

/** Hop-by-hop headers a proxy must not forward (RFC 9110 §7.6.1). */
export const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

export interface ProxyTarget {
  readonly hostname: string;
  readonly port: string | number;
}

export interface ProxyHooks {
  /** Observe the upstream status (used to capture workspace-creation ownership). */
  readonly onResponse?: (status: number) => void;
  /** Report an unreachable upstream; the caller owns logging. */
  readonly onError?: (err: Error) => void;
}

/** Forward `req` to `target` and pipe the reply back. */
export function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  target: ProxyTarget,
  hooks: ProxyHooks = {},
): void {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(key)) headers[key] = value;
  }
  const upstream = httpRequest(
    { host: target.hostname, port: target.port, method: req.method, path: req.url, headers },
    (upstreamRes) => {
      hooks.onResponse?.(upstreamRes.statusCode ?? 0);
      const outHeaders: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (value !== undefined && !HOP_BY_HOP.has(key)) outHeaders[key] = value;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
      upstreamRes.pipe(res);
      upstreamRes.on("error", () => res.destroy());
    },
  );
  upstream.on("error", (err: Error) => {
    hooks.onError?.(err);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "stream host unreachable" }));
    } else {
      res.destroy();
    }
  });
  // A client that walks away tears the upstream leg down with it (frees long-polls/SSE).
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}
