/**
 * `wiki://` MCP resources served from the SQL read model.
 *
 * Two resource shapes, both under the configured namespace `ns`:
 *  - `wiki://{ns}/workspace/{id}` — the workspace rendered as Markdown (its page
 *    tree, via the engine renderer);
 *  - `wiki://{ns}/page/{workspaceId}/{pageId}` — a single page rendered as Markdown.
 *
 * Reads are token-gated by the session's high-water marks, same as the
 * read tools. We expose a fixed `list` (every workspace) plus a `read` that parses a
 * concrete URI and renders it. `server.ts` wires these to the MCP resource request
 * handlers. The URI parsing is the load-bearing contract here; rendering reuses the
 * hot engine handle (token-aware) so resource reads match tool reads exactly.
 */
import type { WorkspaceId } from "wiki";

import { asPageId, asWorkspaceId, type EmbeddedEngine } from "../engine.js";
import type { SqlReadModel } from "../readmodel/readmodel.js";
import type { AccessView } from "./auth.js";
import type { SessionTokenManager } from "./tokens.js";

/** A listed resource (what `resources/list` returns per entry). */
export interface WikiResourceEntry {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
}

/** The contents of one resource read (`resources/read`). */
export interface WikiResourceContents {
  readonly uri: string;
  readonly mimeType: string;
  readonly text: string;
}

/** What the resource handlers are given (mirrors {@link WikiToolContext}). */
export interface WikiResourceContext {
  readonly engine: EmbeddedEngine;
  readonly readModel: SqlReadModel;
  readonly tokens: SessionTokenManager;
  readonly sessionId: string | undefined;
  /** The single namespace this instance serves — the `wiki://{ns}/…` authority. */
  readonly namespace: string;
  /** The caller's access view (auth mode only; absent → trusted). */
  readonly access?: AccessView;
}

const MARKDOWN = "text/markdown";

/** Build the workspace resource URI. */
export function workspaceUri(namespace: string, workspaceId: string): string {
  return `wiki://${namespace}/workspace/${encodeURIComponent(workspaceId)}`;
}

/** Build the page resource URI. */
export function pageUri(namespace: string, workspaceId: string, pageId: string): string {
  return `wiki://${namespace}/page/${encodeURIComponent(workspaceId)}/${encodeURIComponent(pageId)}`;
}

/**
 * List one resource per workspace (the rendered tree). Per-page resources are
 * addressable by URI but not enumerated here (a workspace can hold many pages —
 * enumerate via the `tree` tool, then read `wiki://…/page/…`).
 */
export async function listResources(ctx: WikiResourceContext): Promise<readonly WikiResourceEntry[]> {
  const all = await ctx.readModel.listWorkspaces();
  // Auth mode: enumerate only workspaces the caller can access.
  const rows = ctx.access !== undefined ? all.filter((w) => ctx.access?.canAccess(w.id) === true) : all;
  return rows.map((w) => ({
    uri: workspaceUri(ctx.namespace, w.id),
    name: `${w.name} (workspace)`,
    description: `Rendered Markdown of workspace ${w.id} [${w.status}].`,
    mimeType: MARKDOWN,
  }));
}

/** A parsed `wiki://` URI: either a workspace render or a single-page render. */
type ParsedUri =
  | { readonly kind: "workspace"; readonly workspaceId: WorkspaceId }
  | { readonly kind: "page"; readonly workspaceId: WorkspaceId; readonly pageId: string };

/**
 * Parse a `wiki://{ns}/…` URI for this namespace, or throw if it is malformed /
 * for another namespace.
 */
function parseUri(uri: string, namespace: string): ParsedUri {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error(`malformed resource URI: ${uri}`);
  }
  if (url.protocol !== "wiki:") throw new Error(`unsupported resource scheme: ${url.protocol}`);
  if (url.hostname !== namespace) {
    throw new Error(`resource URI namespace "${url.hostname}" != server namespace "${namespace}"`);
  }
  // pathname is like `/workspace/<id>` or `/page/<wsId>/<pageId>` (leading slash).
  const segments = url.pathname.split("/").filter((s) => s.length > 0).map((s) => decodeURIComponent(s));
  if (segments[0] === "workspace" && segments.length === 2) {
    return { kind: "workspace", workspaceId: asWorkspaceId(segments[1]) };
  }
  if (segments[0] === "page" && segments.length === 3) {
    return { kind: "page", workspaceId: asWorkspaceId(segments[1]), pageId: segments[2] };
  }
  throw new Error(`unrecognized wiki resource path: ${url.pathname}`);
}

/**
 * Read a `wiki://` resource: render the workspace tree or a single page to Markdown
 * via the hot engine handle, token-gated by the session's high-water mark on that
 * workspace.
 */
export async function readResource(uri: string, ctx: WikiResourceContext): Promise<WikiResourceContents> {
  const parsed = parseUri(uri, ctx.namespace);
  if (ctx.access !== undefined && !ctx.access.canAccess(parsed.workspaceId)) {
    throw new Error(`access denied: not a member of workspace ${parsed.workspaceId}`);
  }
  const token = ctx.tokens.consistentWith(ctx.sessionId, parsed.workspaceId);
  const opts = token !== undefined ? { consistentWith: token } : undefined;
  const handle = await ctx.engine.open(parsed.workspaceId);

  const text =
    parsed.kind === "workspace"
      ? await handle.toMarkdown(undefined, opts)
      : await handle.toMarkdown(asPageId(parsed.pageId), opts);

  return { uri, mimeType: MARKDOWN, text };
}
