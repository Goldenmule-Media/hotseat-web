/**
 * The content-addressed blob store — bytes that must never enter the event stream.
 *
 * A workspace's events reference an attachment by a STABLE ID and nothing else; the
 * bytes live here, reachable over a separate upload/download surface (see `routes.ts`).
 * The id is the sha256 of the content, so an upload is idempotent and dedup'd, a blob
 * is immutable, and equal content is always the same id on every machine.
 *
 * Deliberately file-type-AGNOSTIC: it stores `mime`, the original `name` and `size`
 * and inspects none of them. Images are simply its first consumer. A sidecar carries
 * the metadata because the content hash alone cannot recover the filename a human
 * uploaded, and a PDF must download as `Q3-report.pdf` rather than as a hash.
 *
 * The stored `name` is a DEFAULT, not the authoritative one. Because identity is the
 * content hash, the same bytes uploaded twice under different names are one blob and
 * the first name wins. The name a reader should see belongs to the REFERENCE — an
 * `attachment-ref` field carries its own `name`, an image block its own `alt` — so two
 * pages can present the same bytes differently. This sidecar only decides what a
 * direct download is called when nothing else says.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The stored metadata for one blob (the `.json` sidecar beside its bytes). */
export interface BlobMeta {
  /** sha256 of the content, hex — the blob's id, and its filename. */
  readonly id: string;
  readonly mime: string;
  /** The filename the uploader supplied, preserved for `content-disposition`. */
  readonly name: string;
  readonly size: number;
}

export interface BlobStoreOptions {
  /** Root under which `<workspaceId>/<sha256>` trees live. */
  readonly dir: string;
  /** Hard ceiling per blob, in bytes. */
  readonly maxBytes: number;
  /** Allowed mime types: exact (`application/pdf`) or a `type/*` wildcard. */
  readonly mimeAllow: readonly string[];
}

/** A rejection the route layer maps to a 4xx. */
export class BlobRejected extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BlobRejected";
  }
}

/** sha256 of `bytes`, hex — the blob id. */
export function blobId(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Does `mime` satisfy the allowlist? Entries are exact or `type/*`. */
export function mimeAllowed(mime: string, allow: readonly string[]): boolean {
  const m = mime.toLowerCase().split(";")[0]!.trim();
  return allow.some((entry) => {
    const e = entry.toLowerCase().trim();
    if (e === "*/*") return true;
    if (e.endsWith("/*")) return m.startsWith(e.slice(0, -1));
    return m === e;
  });
}

/** A blob id is exactly 64 lowercase hex chars — anything else can't address a file. */
export function isBlobId(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/**
 * Strip a caller-supplied filename down to something safe to echo back in a header
 * and to log. Never used as a path — bytes are stored under the content hash.
 */
export function sanitizeName(raw: string | undefined, fallback: string): string {
  const base = (raw ?? "").replace(/[\r\n"\\]/g, "").split(/[/\\]/).pop()?.trim() ?? "";
  return base.length > 0 && base.length <= 200 ? base : fallback;
}

export class BlobStore {
  constructor(private readonly opts: BlobStoreOptions) {}

  private pathsFor(workspaceId: string, id: string): { dir: string; bytes: string; meta: string } {
    // The workspace id goes through the same encoding the rest of the tree uses for
    // untrusted segments: anything outside the safe set collapses, so a crafted id
    // can never escape the blob root.
    const dir = join(this.opts.dir, workspaceId.replace(/[^A-Za-z0-9._-]+/g, "-"));
    return { dir, bytes: join(dir, id), meta: join(dir, `${id}.json`) };
  }

  /**
   * Store `bytes` and return their metadata. Idempotent: identical content yields the
   * identical id and rewrites nothing. Rejects on size or mime before touching disk.
   */
  async put(workspaceId: string, bytes: Uint8Array, mime: string, name: string): Promise<BlobMeta> {
    if (bytes.byteLength === 0) throw new BlobRejected("an empty body has nothing to store", 400);
    if (bytes.byteLength > this.opts.maxBytes) {
      throw new BlobRejected(`blob exceeds the ${this.opts.maxBytes}-byte limit`, 413);
    }
    if (!mimeAllowed(mime, this.opts.mimeAllow)) {
      throw new BlobRejected(`content-type "${mime}" is not an allowed attachment type`, 415);
    }
    const id = blobId(bytes);
    const meta: BlobMeta = { id, mime, name, size: bytes.byteLength };
    const p = this.pathsFor(workspaceId, id);
    // Already stored: the bytes are identical by construction, so keep the existing
    // sidecar rather than rewriting metadata under a racing second uploader.
    if (await exists(p.bytes)) return (await this.head(workspaceId, id)) ?? meta;
    await mkdir(p.dir, { recursive: true });
    await atomicWrite(p.bytes, Buffer.from(bytes));
    await atomicWrite(p.meta, Buffer.from(JSON.stringify(meta), "utf8"));
    return meta;
  }

  /** The blob's metadata, or `undefined` when it isn't stored here. */
  async head(workspaceId: string, id: string): Promise<BlobMeta | undefined> {
    if (!isBlobId(id)) return undefined;
    const p = this.pathsFor(workspaceId, id);
    if (!(await exists(p.bytes))) return undefined;
    try {
      const parsed = JSON.parse(await readFile(p.meta, "utf8")) as BlobMeta;
      return { id, mime: parsed.mime, name: parsed.name, size: parsed.size };
    } catch {
      // A missing or corrupt sidecar must not make the bytes unreachable.
      const size = (await stat(p.bytes)).size;
      return { id, mime: "application/octet-stream", name: id, size };
    }
  }

  /** The blob's bytes plus metadata, or `undefined` when it isn't stored here. */
  async get(workspaceId: string, id: string): Promise<{ meta: BlobMeta; bytes: Buffer } | undefined> {
    const meta = await this.head(workspaceId, id);
    if (meta === undefined) return undefined;
    return { meta, bytes: await readFile(this.pathsFor(workspaceId, id).bytes) };
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

let tmpCounter = 0;
async function atomicWrite(path: string, body: Buffer): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${tmpCounter++}`;
  await writeFile(tmp, body);
  await rename(tmp, path);
}
