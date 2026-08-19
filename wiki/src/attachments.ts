/**
 * `wiki/attachments` — the client for the attachment store, and the `attachment:` ref
 * scheme that ties it to page content.
 *
 * Binary never enters the event stream. A page references bytes by a STABLE ID
 * (`attachment:<sha256>`), and upload/download are separate HTTP operations against
 * the wiki-server's blob endpoint. This module is the seam every consumer shares —
 * wiki-ui uploading a pasted screenshot, wiki-mirror downloading one to disk — so the
 * ref format has exactly one definition.
 *
 * ISOMORPHIC by construction: plain `fetch`, no `node:*` imports, so the browser
 * engine surface can import it (unlike `wiki/auth-client`, which is Node-only). It
 * takes the same `{ baseUrl, namespace, headers }` shape as {@link IStreamConfig},
 * including function-valued headers — but unlike the stream client, which resolves
 * those internally, this one must resolve them itself before each request.
 *
 * The engine does NOT depend on this. It never folds, validates, or renders bytes,
 * so nothing here hangs off `createWiki`, and an attachment ref is deliberately not
 * integrity-checked at ingestion — it has the same standing as an external URL.
 */
import type { IStreamHeaders } from "./api";

/** The URI scheme marking a ref as living in this wiki's own attachment store. */
export const ATTACHMENT_SCHEME = "attachment:";

/** Metadata for one stored blob, as the server reports it. */
export interface AttachmentMeta {
  /** sha256 of the content, hex. */
  readonly id: string;
  readonly mime: string;
  /** The filename at upload — a DEFAULT only; the display name belongs to the ref. */
  readonly name: string;
  readonly size: number;
}

export interface AttachmentClientConfig {
  readonly baseUrl: string;
  readonly namespace: string;
  readonly headers?: IStreamHeaders;
}

/** The content ref for a stored blob: `attachment:<sha256>`. */
export function attachmentRef(id: string): string {
  return `${ATTACHMENT_SCHEME}${id}`;
}

/** The blob id inside an `attachment:` ref, or `undefined` for anything else
 *  (an ordinary `https://` image URL passes through untouched). */
export function parseAttachmentRef(ref: string): string | undefined {
  if (!ref.startsWith(ATTACHMENT_SCHEME)) return undefined;
  const id = ref.slice(ATTACHMENT_SCHEME.length);
  return /^[0-9a-f]{64}$/.test(id) ? id : undefined;
}

/** Every distinct `attachment:` id appearing in a rendered Markdown body, in order. */
export function attachmentRefsIn(markdown: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of markdown.matchAll(/attachment:([0-9a-f]{64})/g)) {
    const id = m[1]!;
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** A non-2xx from the blob endpoint. */
export class AttachmentError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AttachmentError";
  }
}

/** Resolve function-valued headers (the per-request auth seam) into plain strings. */
async function resolveHeaders(headers: IStreamHeaders | undefined): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key] = typeof value === "function" ? await value() : value;
  }
  return out;
}

export class AttachmentClient {
  private readonly baseUrl: string;

  constructor(private readonly cfg: AttachmentClientConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
  }

  /** The download URL for a blob. Fetching it still needs the configured headers. */
  urlFor(workspaceId: string, id: string): string {
    return `${this.baseUrl}/${this.cfg.namespace}/workspace/${encodeURIComponent(workspaceId)}/blobs/${id}`;
  }

  private collectionUrl(workspaceId: string): string {
    return `${this.baseUrl}/${this.cfg.namespace}/workspace/${encodeURIComponent(workspaceId)}/blobs`;
  }

  /** Store bytes and return their metadata. Idempotent — identical bytes, identical id. */
  async upload(workspaceId: string, bytes: Uint8Array, mime: string, name: string): Promise<AttachmentMeta> {
    const res = await fetch(this.collectionUrl(workspaceId), {
      method: "POST",
      headers: {
        ...(await resolveHeaders(this.cfg.headers)),
        "content-type": mime,
        // The filename rides content-disposition rather than a multipart envelope:
        // the body is the bytes and nothing else, so an upload never needs parsing.
        "content-disposition": `attachment; filename="${name.replace(/[\r\n"\\]/g, "")}"`,
      },
      body: bytes as BodyInit,
    });
    if (!res.ok) throw new AttachmentError(await errorText(res), res.status);
    return (await res.json()) as AttachmentMeta;
  }

  /** Fetch a blob's bytes and metadata, or `undefined` when it is not stored. */
  async download(workspaceId: string, id: string): Promise<{ meta: AttachmentMeta; bytes: Uint8Array } | undefined> {
    const res = await fetch(this.urlFor(workspaceId, id), { headers: await resolveHeaders(this.cfg.headers) });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new AttachmentError(await errorText(res), res.status);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return {
      meta: {
        id,
        mime: res.headers.get("content-type") ?? "application/octet-stream",
        name: filenameFromDisposition(res.headers.get("content-disposition")) ?? id,
        size: bytes.byteLength,
      },
      bytes,
    };
  }
}

function filenameFromDisposition(header: string | null): string | undefined {
  if (header === null) return undefined;
  return /filename="?([^";]+)"?/i.exec(header)?.[1];
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (typeof body.error === "string") return body.error;
  } catch {
    /* fall through to the status line */
  }
  return `attachment request failed with ${res.status}`;
}
