"use client";

/**
 * Attachments in the browser: uploading bytes to the wiki-server's blob endpoint, and
 * resolving the `attachment:<sha>` refs that come back in rendered Markdown.
 *
 * The event stream carries only the ref, so the picture a reader sees has to be fetched
 * separately — and a plain `<img src>` cannot send an Authorization header, while a
 * cookie is unavailable because wiki-ui is served from a different origin than the
 * server. So a rendered page's attachment URLs are resolved by FETCHING them with the
 * bearer and swapping in an object URL, in a DOM pass after the Markdown is inserted.
 *
 * Uploads go straight to wiki-server rather than through a Next route: wiki-ui deploys
 * separately, and proxying bytes through SSR compute would add a hop and a size limit
 * for nothing.
 */
import { AttachmentClient, parseAttachmentRef } from "wiki/attachments";
import { getToken, notifyUnauthorized, serverBaseUrl } from "./auth";

/** Must match the server's WIKI_MCP_NAMESPACE, like every other stream URL here. */
function namespace(): string {
  return process.env.NEXT_PUBLIC_WIKI_NAMESPACE ?? "default";
}

function client(): AttachmentClient {
  return new AttachmentClient({
    baseUrl: serverBaseUrl(),
    namespace: namespace(),
    // A FUNCTION so a token replaced mid-session is picked up on the next request.
    headers: { authorization: () => `Bearer ${getToken() ?? ""}` },
  });
}

/** The URL a blob is served from (still needs the bearer to actually fetch). */
export function attachmentUrl(workspaceId: string, id: string): string {
  return client().urlFor(workspaceId, id);
}

/**
 * Upload one file and return the `attachment:<sha>` ref to put in page content.
 * Surfaces a 401 to the AuthProvider like every other authenticated call here.
 */
export async function uploadAttachment(workspaceId: string, file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = file.type.length > 0 ? file.type : "application/octet-stream";
  try {
    const meta = await client().upload(workspaceId, bytes, mime, file.name);
    return `attachment:${meta.id}`;
  } catch (err) {
    if ((err as { status?: number }).status === 401) notifyUnauthorized();
    throw err;
  }
}

/**
 * Fetch a blob with the bearer and hand back an object URL. Cached per blob id for the
 * page's lifetime: the same image may appear in several notes, and the bytes are
 * immutable, so one fetch is always enough.
 */
const objectUrls = new Map<string, Promise<string | null>>();

export function resolveAttachment(workspaceId: string, id: string): Promise<string | null> {
  const key = `${workspaceId}/${id}`;
  const hit = objectUrls.get(key);
  if (hit !== undefined) return hit;
  const pending = (async (): Promise<string | null> => {
    try {
      const found = await client().download(workspaceId, id);
      if (found === undefined) return null;
      return URL.createObjectURL(new Blob([found.bytes as BlobPart], { type: found.meta.mime }));
    } catch (err) {
      if ((err as { status?: number }).status === 401) notifyUnauthorized();
      return null;
    }
  })();
  objectUrls.set(key, pending);
  return pending;
}

/**
 * The `src` an `<img>` can load for one image ref: an `attachment:` ref fetched with the
 * bearer and handed back as an object URL, any ordinary URL passed through untouched.
 * `null` when it is neither — the caller shows the alt text instead.
 */
export function imageSrc(workspaceId: string, ref: string): Promise<string | null> {
  const id = parseAttachmentRef(ref);
  if (id !== undefined) return resolveAttachment(workspaceId, id);
  return Promise.resolve(/^(?:https?:|data:)/i.test(ref) ? ref : null);
}

/**
 * Swap every `attachment:` URL inside `root` for a fetched object URL. Runs after the
 * rendered HTML is inserted, and covers `<img src>` and `<a href>` alike — so an inline
 * image and a PDF link need no separate handling.
 *
 * Returns a cleanup that marks the pass abandoned; the object URLs themselves are
 * deliberately NOT revoked, because they are cached and shared across renders.
 */
export function resolveAttachmentsIn(root: HTMLElement, workspaceId: string): () => void {
  let live = true;
  const targets: { el: Element; attr: "src" | "href"; id: string }[] = [];
  for (const el of Array.from(root.querySelectorAll("img[src], a[href]"))) {
    const attr = el.tagName === "IMG" ? "src" : "href";
    // getAttribute, not .src: the DOM resolves an unknown scheme against the page URL.
    const raw = el.getAttribute(attr) ?? "";
    const id = parseAttachmentRef(raw);
    if (id !== undefined) targets.push({ el, attr, id });
  }
  for (const { el, attr, id } of targets) {
    void resolveAttachment(workspaceId, id).then((url) => {
      if (!live || url === null) return;
      el.setAttribute(attr, url);
    });
  }
  return () => {
    live = false;
  };
}
