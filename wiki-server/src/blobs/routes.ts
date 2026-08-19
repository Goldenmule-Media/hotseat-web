/**
 * The blob HTTP surface: upload and download, deliberately SEPARATE operations from
 * the event stream. Bytes never travel through a durable stream — a workspace's events
 * carry only `attachment:<sha256>`, and these routes are how those bytes get in and out.
 *
 * Mounted at `/{ns}/workspace/{id}/blobs[/{sha}]`. That path shape is not cosmetic: it
 * is the one shape the auth gateway's deny-by-default allowlist already gates on
 * workspace membership, so blob access inherits the workspace's own ACL with no second
 * policy to keep in sync.
 *
 * Nothing here knows what an image is.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { BlobRejected, isBlobId, sanitizeName, type BlobStore } from "./store.js";

/** Response headers on blob replies; mirrors the gateway's CORS for authored responses. */
const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, HEAD, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, content-disposition",
  "access-control-expose-headers": "content-disposition, content-length, etag",
};

/** The parsed shape of a blob request path, or `undefined` when it isn't one. */
export interface BlobRoute {
  readonly workspaceId: string;
  /** The blob id for a download, absent for the collection (upload) endpoint. */
  readonly id?: string;
}

/**
 * Match `/{ns}/workspace/{id}/blobs[/{sha}]` against already-decoded path segments.
 * Returns `undefined` for anything else, so the caller falls through to its own routing.
 */
export function matchBlobRoute(segments: readonly string[]): BlobRoute | undefined {
  if (segments.length < 4 || segments[1] !== "workspace" || segments[3] !== "blobs") return undefined;
  if (segments.length > 5) return undefined;
  const workspaceId = segments[2]!;
  const id = segments[4];
  return id === undefined ? { workspaceId } : { workspaceId, id };
}

/** RFC 6266 `filename="…"` from a content-disposition header, if present. */
export function filenameFrom(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star !== null) {
    try {
      return decodeURIComponent(star[1]!);
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1];
}

/**
 * Read a request body, aborting as soon as it exceeds `maxBytes`. Counted while
 * streaming rather than buffered-then-checked, so an oversized upload can never be
 * used to balloon the host's memory.
 */
async function readCapped(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.byteLength;
    if (total > maxBytes) throw new BlobRejected(`blob exceeds the ${maxBytes}-byte limit`, 413);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export interface BlobRoutesConfig {
  readonly store: BlobStore;
  readonly maxBytes: number;
}

/**
 * Serve one blob request. The caller has ALREADY authenticated and authorized it for
 * `route.workspaceId` — this layer is transport only, and enforces no policy of its own.
 */
export async function handleBlobRequest(
  req: IncomingMessage,
  res: ServerResponse,
  route: BlobRoute,
  cfg: BlobRoutesConfig,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  try {
    if (method === "OPTIONS") {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    if (method === "POST") {
      if (route.id !== undefined) {
        json(res, 405, { error: "upload posts to the collection, not to a blob id" });
        return;
      }
      const mime = (req.headers["content-type"] ?? "").split(";")[0]!.trim();
      if (mime.length === 0) {
        json(res, 400, { error: "an upload must declare its content-type" });
        return;
      }
      const bytes = await readCapped(req, cfg.maxBytes);
      const name = sanitizeName(filenameFrom(req.headers["content-disposition"]), "attachment");
      const meta = await cfg.store.put(route.workspaceId, bytes, mime, name);
      json(res, 201, meta);
      return;
    }
    if (method === "GET" || method === "HEAD") {
      if (route.id === undefined || !isBlobId(route.id)) {
        json(res, 404, { error: "no such blob" });
        return;
      }
      const meta = await cfg.store.head(route.workspaceId, route.id);
      if (meta === undefined) {
        json(res, 404, { error: "no such blob" });
        return;
      }
      // Content-addressed bytes are immutable, so they may be cached forever. The
      // filename rides `content-disposition` so a download keeps the name a human
      // gave it rather than the hash the bytes are stored under.
      const headers: Record<string, string> = {
        ...CORS,
        "content-type": meta.mime,
        "content-length": String(meta.size),
        "cache-control": "public, max-age=31536000, immutable",
        etag: `"${meta.id}"`,
        "content-disposition": `inline; filename="${meta.name}"`,
      };
      if (method === "HEAD") {
        res.writeHead(200, headers);
        res.end();
        return;
      }
      const found = await cfg.store.get(route.workspaceId, route.id);
      if (found === undefined) {
        json(res, 404, { error: "no such blob" });
        return;
      }
      res.writeHead(200, headers);
      res.end(found.bytes);
      return;
    }
    json(res, 405, { error: `method ${method} is not allowed on blobs` });
  } catch (err) {
    if (err instanceof BlobRejected) {
      json(res, err.status, { error: err.message });
      return;
    }
    throw err;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...CORS, "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
