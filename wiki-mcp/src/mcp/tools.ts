/**
 * The engine command catalog + read queries turned into MCP tools.
 *
 * - **Write tools.** The structural commands (`createPage`, `reparent`, `link`, …)
 *   get hand-authored JSON-Schema inputs (they aren't covered by
 *   `IPageView.describeMutations()` today). Page-scoped content/status
 *   mutations flow through a single `mutatePage` tool whose `args` are validated by
 *   the engine's own Zod `argsSchema`; a companion `describeMutations` tool reports
 *   the page's CURRENTLY-legal command set + each command's `argsSchema` (straight
 *   from `IPageView.describeMutations()`), which is how an agent discovers the exact
 *   per-page input schema before calling `mutatePage` ("only-legal-actions").
 * - **Read tools.** `getPage`, `renderPage`, `tree`, `listWorkspaces`, `search`,
 *   `attention` — backed by the SQL read model, token-gated per the
 *   session's high-water marks. `nextActions` additionally rolls the
 *   engine's per-page `describeMutations`/`attentionItems` up across a subtree to
 *   self-direct an agent (do / blocked / humanGates / attention).
 *
 * Each tool is a plain {@link WikiTool} descriptor (name + JSON-Schema input +
 * handler). `server.ts` registers them on the low-level MCP `Server` so the engine's
 * RAW JSON Schema is advertised verbatim (the high-level `McpServer.registerTool`
 * wants Zod, which we don't have — we have JSON Schema from the engine). The handler
 * receives the calling session id so the token manager can thread read-your-writes.
 * Write tools advance the session's high-water mark and echo the
 * token in their result so a client MAY also thread it.
 */
import {
  encodeToken,
  PageNotFoundError,
  StaleEditError,
  type ConsistencyToken,
  type IReadOpts,
  type ISearchIndex,
  type IWorkspaceHandle,
  type JsonSchema,
  type WorkspaceId,
} from "wiki";

import { isAbsolute } from "node:path";

import { asPageId, asWorkspaceId, type EmbeddedEngine } from "../engine.js";
import type { SqlReadModel } from "../readmodel/readmodel.js";
import { createLanguageRegistry } from "../models/analyzers/index.js";
import type { LanguageRegistry, RenameTarget } from "../models/language-registry.js";
import { foldEmitters, type EmitterArchive, type EmitterConfigStore } from "../emitters/config-store.js";
import type { SessionTokenManager } from "./tokens.js";

/**
 * The shared default {@link LanguageRegistry} (built-in TS/JS analyzer, stateless/pure)
 * the semantic-operation write tools consult to compute rename edits host-side.
 */
const LANGUAGES: LanguageRegistry = createLanguageRegistry();

// ────────────────────────────────────────────────────────────────────────────
// Tool descriptor shape
// ────────────────────────────────────────────────────────────────────────────

/** A normalized tool result: text content + an optional structured payload. */
export interface ToolResult {
  /** Human/agent-readable summary lines. */
  readonly text: string;
  /** Optional structured data (echoed as JSON in a second text block). */
  readonly data?: unknown;
}

/** What every tool handler is given. */
export interface WikiToolContext {
  readonly engine: EmbeddedEngine;
  readonly readModel: SqlReadModel;
  /**
   * The engine's full-text search index (fed by the projection tailer). The running
   * server always provides it; it is optional only so a test that exercises non-search
   * tools need not wire one — the `search` tool degrades to "not configured".
   */
  readonly searchIndex?: ISearchIndex;
  /**
   * The runtime emitter config store (feature: runtime-configurable Markdown emitters). The
   * running server always provides it; it is optional only so a test exercising non-emitter
   * tools need not wire one — the emitter tools degrade to "not configured" when absent.
   */
  readonly emitters?: EmitterConfigStore;
  readonly tokens: SessionTokenManager;
  /** The MCP session id (undefined for stdio) — the token-manager key. */
  readonly sessionId: string | undefined;
}

/** One MCP tool: a name, a description, a JSON-Schema input, and a handler. */
export interface WikiTool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema object (`{ type: "object", … }`) advertised as `Tool.inputSchema`. */
  readonly inputSchema: JsonSchema;
  /** True for tools that mutate (so `server.ts` records the returned token). */
  readonly write: boolean;
  handle(args: Record<string, unknown>, ctx: WikiToolContext): Promise<ToolResult>;
}

// ────────────────────────────────────────────────────────────────────────────
// Small JSON-Schema helpers (hand-authored structural-command inputs)
// ────────────────────────────────────────────────────────────────────────────

const STR: JsonSchema = { type: "string" };
const str = (description: string): JsonSchema => ({ type: "string", description });
const nullableStr = (description: string): JsonSchema => ({
  type: ["string", "null"],
  description,
});

/** Build a `{ type: "object", properties, required }` JSON Schema. */
function obj(
  properties: Record<string, JsonSchema>,
  required: readonly string[],
): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

/** Read a required string arg or throw a descriptive error. */
function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`missing or invalid "${key}" (expected a non-empty string)`);
  }
  return v;
}

/** Read an optional string|null arg (returns `null` when absent or null). */
function optStrOrNull(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new Error(`invalid "${key}" (expected a string or null)`);
  return v;
}

// ────────────────────────────────────────────────────────────────────────────
// Read-model serialization helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Wait for the session's high-water token on `workspace` before a single-workspace
 * read, so the read reflects the session's own writes. A
 * `ConsistencyTimeoutError` from `waitFor` propagates to a structured tool error in
 * `server.ts` (the agent can retry or read stale).
 */
async function awaitConsistency(ctx: WikiToolContext, workspace: WorkspaceId): Promise<void> {
  const token = ctx.tokens.consistentWith(ctx.sessionId, workspace);
  if (token !== undefined) await ctx.readModel.waitFor(token);
}

/**
 * Fan out a cross-workspace read's consistency wait over every workspace the session
 * has written: the result reflects ALL of the session's writes.
 */
async function awaitAllConsistency(ctx: WikiToolContext): Promise<void> {
  const tokens = ctx.tokens.allWritten(ctx.sessionId);
  await Promise.all(tokens.map((t) => ctx.readModel.waitFor(t)));
}

/** Wait for the search index (its cursor is independent of the SQL read model's). */
async function awaitSearchConsistency(
  index: ISearchIndex,
  ctx: WikiToolContext,
  workspace: WorkspaceId,
): Promise<void> {
  const token = ctx.tokens.consistentWith(ctx.sessionId, workspace);
  if (token !== undefined) await index.waitFor(token);
}

// ────────────────────────────────────────────────────────────────────────────
// Self-direction roll-up (generic over the engine's model-declared classifiers:
// transition `agency` + element `awaitsHuman`; NO page-type knowledge lives here)
// ────────────────────────────────────────────────────────────────────────────

/** A page-transition command surfaced by the roll-up, tagged with the page it lives on. */
interface ActionRef {
  readonly pageId: string;
  readonly pageType: string;
  readonly command: string;
  /** The first unmet-precondition reason, when the edge is currently blocked. */
  readonly reason?: string;
}

/** An element instance a model flags as awaiting a human (via `awaitsHuman`). */
interface AttentionRef {
  readonly pageId: string;
  readonly sectionKey: string;
  readonly field: string;
  readonly itemId: string;
  readonly status?: string;
}

/**
 * The generic "what to do next" partition of a subtree, derived purely from the engine's
 * model-declared classifiers — there is no command-name / element-type literal here:
 * - `do`         — agent edges legal right now (drive these autonomously);
 * - `blocked`    — agent edges gated by an unmet precondition (satisfy `reason`, then drive);
 * - `humanGates` — sign-off/decision edges where a human decides (stop here);
 * - `attention`  — element instances flagged as awaiting a human.
 */
interface NextSummary {
  do: ActionRef[];
  blocked: ActionRef[];
  humanGates: ActionRef[];
  attention: AttentionRef[];
}

/**
 * Roll a set of pages up into a {@link NextSummary} by reading each page's
 * `describeMutations` (partitioned on the model-declared `agency`) and `attentionItems`
 * (its model-declared `awaitsHuman` instances). `agency` is present only for an edge legal
 * from the page's current status, so its presence already filters to reachable edges.
 */
async function rollupSubtree(
  handle: IWorkspaceHandle,
  pageIds: readonly string[],
  opts: IReadOpts | undefined,
): Promise<NextSummary> {
  const summary: NextSummary = { do: [], blocked: [], humanGates: [], attention: [] };
  for (const id of pageIds) {
    // The SQL read model (structure) can be one commit ahead of this hot engine handle
    // under a concurrent other-session write; skip a page the engine hasn't folded yet
    // rather than failing the whole advisory roll-up.
    let view;
    try {
      view = await handle.page(asPageId(id), opts);
    } catch (e) {
      if (e instanceof PageNotFoundError) continue;
      throw e;
    }
    const [descriptors, items] = await Promise.all([view.describeMutations(opts), view.attentionItems(opts)]);
    const pageType = view.type;
    for (const d of descriptors) {
      const ref: ActionRef = {
        pageId: id,
        pageType,
        command: d.name,
        ...(d.unmet !== undefined ? { reason: d.unmet } : {}),
      };
      if (d.agency === "agent") (d.available ? summary.do : summary.blocked).push(ref);
      else if (d.agency === "human") summary.humanGates.push(ref);
    }
    for (const it of items) {
      summary.attention.push({
        pageId: it.pageId,
        sectionKey: it.sectionKey,
        field: it.field,
        itemId: it.elementId,
        ...(it.status !== undefined ? { status: it.status } : {}),
      });
    }
  }
  return summary;
}

/** Best-effort roll-up (one page or a set) for a just-committed write — never throws (advisory). */
async function summarizeNext(
  handle: IWorkspaceHandle,
  pageId: string | readonly string[],
  token: ConsistencyToken,
): Promise<NextSummary | undefined> {
  try {
    const ids = typeof pageId === "string" ? [pageId] : pageId;
    return await rollupSubtree(handle, ids, { consistentWith: token });
  } catch {
    return undefined; // the write already committed; the hint is best-effort
  }
}

/** Compact one-line suffix for a write tool's text (empty when nothing is pending). */
function nextLine(n: NextSummary | undefined): string {
  if (n === undefined) return "";
  if (n.do.length + n.blocked.length + n.humanGates.length + n.attention.length === 0) return "";
  return (
    `\nNext: ${n.do.length} ready, ${n.blocked.length} blocked, ` +
    `${n.humanGates.length} human gate(s), ${n.attention.length} awaiting human ` +
    "(call nextActions for detail)."
  );
}

/** Render a {@link NextSummary} as readable, sectioned text for the nextActions tool. */
function renderNextSummary(n: NextSummary): string {
  const parts: string[] = [];
  const refLine = (a: ActionRef): string =>
    `- ${a.command} on ${a.pageId} (${a.pageType})${a.reason !== undefined ? ` — ${a.reason}` : ""}`;
  if (n.do.length > 0) parts.push("Ready — drive these now:", ...n.do.map(refLine));
  if (n.blocked.length > 0) parts.push("Blocked — satisfy the reason, then the edge opens:", ...n.blocked.map(refLine));
  if (n.humanGates.length > 0) parts.push("Human gates — stop here; a person decides:", ...n.humanGates.map(refLine));
  if (n.attention.length > 0)
    parts.push(
      "Awaiting human — escalated items:",
      ...n.attention.map((a) => `- ${a.itemId} on ${a.pageId} (${a.sectionKey}.${a.field})${a.status !== undefined ? ` [${a.status}]` : ""}`),
    );
  return parts.length === 0 ? "Nothing pending — this subtree is complete or fully human-gated." : parts.join("\n");
}

/**
 * The non-archived page ids of a subtree (or the whole workspace when `scope` is null),
 * using the same archived-hidden marking as the `tree` tool — so the roll-up never offers
 * actions on archived pages (which the engine refuses to mutate).
 */
function visibleSubtreeIds(
  pages: readonly { id: string; archived?: boolean | null }[],
  edges: readonly { parent_id: string; child_id: string; ord: number }[],
  scope: string | null,
): string[] {
  const archived = new Set(pages.filter((p) => p.archived === true).map((p) => p.id));
  const sorted = [...edges].sort((a, b) => a.ord - b.ord);
  const childrenOf = new Map<string, string[]>();
  for (const e of sorted) {
    const list = childrenOf.get(e.parent_id) ?? [];
    list.push(e.child_id);
    childrenOf.set(e.parent_id, list);
  }
  const out: string[] = [];
  const walk = (id: string, underArchived: boolean): void => {
    const hidden = underArchived || archived.has(id);
    if (!hidden) out.push(id);
    for (const child of childrenOf.get(id) ?? []) walk(child, hidden);
  };
  if (scope !== null) {
    walk(scope, false);
  } else {
    // Roots are parent ids that are never a child (the `@root` sentinel) — start from
    // their children (the actual top-level pages), never the sentinel itself.
    const childIds = new Set(edges.map((e) => e.child_id));
    const roots = [...childrenOf.keys()].filter((p) => !childIds.has(p)).sort();
    for (const root of roots) for (const child of childrenOf.get(root) ?? []) walk(child, false);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Write tools (structural commands — hand-authored schemas)
// ────────────────────────────────────────────────────────────────────────────

const createPageTool: WikiTool = {
  name: "createPage",
  description:
    "Create a new page of a registered type in a workspace, optionally under a parent. Returns the new " +
    "page id. If the type declares required children (see describePageType), they are auto-created as " +
    "pinned children in the SAME commit and returned in `data.children` — author into those, do not " +
    "create your own.",
  inputSchema: obj(
    {
      workspaceId: str("The workspace to create the page in."),
      type: str("The registered page-type tag (e.g. \"note\", \"feature-brief\")."),
      title: str("The page title (unique among its siblings)."),
      parentId: nullableStr("The parent page id, or null for a top-level page."),
    },
    ["workspaceId", "type", "title"],
  ),
  write: true,
  async handle(args, ctx) {
    const ws = asWorkspaceId(reqStr(args, "workspaceId"));
    const handle = await ctx.engine.open(ws);
    const { value, token } = await handle.createPage(reqStr(args, "type"), {
      title: reqStr(args, "title"),
      parentId: optStrOrNull(args, "parentId") as never,
    });
    ctx.tokens.recordWrite(ctx.sessionId, token);

    // Required children are materialized in the SAME commit. Surface them directly (ids + types)
    // so the agent gets their canonical ids and never re-creates them by hand. Best-effort: the
    // page already committed, so a read hiccup must not fail the tool.
    let children: { id: string; type: string; title: string }[] = [];
    try {
      const view = await handle.page(asPageId(value), { consistentWith: token });
      const kids = await view.children({ consistentWith: token });
      children = await Promise.all(
        kids.map(async (k) => ({ id: k.id, type: k.type, title: await k.title({ consistentWith: token }) })),
      );
    } catch {
      // advisory only
    }

    // Roll up the created page PLUS its auto-created children so each child's own pending actions
    // surface too (agency partitioning unchanged — we don't force child edges into do/blocked).
    const next = await summarizeNext(handle, [value, ...children.map((c) => c.id)], token);

    const childLine =
      children.length > 0
        ? `\nAuto-created ${children.length} required child page(s): ` +
          children.map((c) => `${c.id} (${c.type})`).join(", ") +
          " — populate these; do not create your own siblings."
        : "";
    return {
      text: `Created page ${value}.${childLine}` + nextLine(next),
      data: { pageId: value, token, ...(children.length > 0 ? { children } : {}), ...(next !== undefined ? { next } : {}) },
    };
  },
};

const reparentTool: WikiTool = {
  name: "reparent",
  description: "Move a page under a new parent (or to top level when newParentId is null).",
  inputSchema: obj(
    {
      workspaceId: str("The workspace the page lives in."),
      pageId: str("The page to move."),
      newParentId: nullableStr("The new parent id, or null for top level."),
      position: { type: "integer", minimum: 0, description: "Optional insertion index among siblings." },
    },
    ["workspaceId", "pageId"],
  ),
  write: true,
  async handle(args, ctx) {
    const ws = asWorkspaceId(reqStr(args, "workspaceId"));
    const handle = await ctx.engine.open(ws);
    const position = typeof args.position === "number" ? args.position : undefined;
    const { token } = await handle.reparent(
      asPageId(reqStr(args, "pageId")),
      optStrOrNull(args, "newParentId") as never,
      position,
    );
    ctx.tokens.recordWrite(ctx.sessionId, token);
    return { text: "Reparented.", data: { token } };
  },
};

const setPageTitleTool: WikiTool = {
  name: "setPageTitle",
  description: "Rename a page.",
  inputSchema: obj(
    { workspaceId: STR, pageId: STR, title: str("The new title.") },
    ["workspaceId", "pageId", "title"],
  ),
  write: true,
  async handle(args, ctx) {
    const ws = asWorkspaceId(reqStr(args, "workspaceId"));
    const handle = await ctx.engine.open(ws);
    const { token } = await handle.setPageTitle(asPageId(reqStr(args, "pageId")), reqStr(args, "title"));
    ctx.tokens.recordWrite(ctx.sessionId, token);
    return { text: "Title set.", data: { token } };
  },
};

const archivePageTool: WikiTool = {
  name: "archivePage",
  description:
    "Archive a page — hide it from default tree views (it and its subtree drop out). Reversible via " +
    "unarchivePage; the page's lifecycle status is preserved, and it cannot be mutated while archived. " +
    "Note: an archived page still reserves its title among its siblings (archiving does NOT free the name), " +
    "and it cannot be renamed while archived — so rename before archiving if you intend to reuse the title.",
  inputSchema: obj({ workspaceId: STR, pageId: STR }, ["workspaceId", "pageId"]),
  write: true,
  async handle(args, ctx) {
    const ws = asWorkspaceId(reqStr(args, "workspaceId"));
    const handle = await ctx.engine.open(ws);
    const { token } = await handle.archivePage(asPageId(reqStr(args, "pageId")));
    ctx.tokens.recordWrite(ctx.sessionId, token);
    return { text: "Page archived.", data: { token } };
  },
};

const unarchivePageTool: WikiTool = {
  name: "unarchivePage",
  description: "Unarchive a page — restore it to default tree views. Its lifecycle status is unchanged.",
  inputSchema: obj({ workspaceId: STR, pageId: STR }, ["workspaceId", "pageId"]),
  write: true,
  async handle(args, ctx) {
    const ws = asWorkspaceId(reqStr(args, "workspaceId"));
    const handle = await ctx.engine.open(ws);
    const { token } = await handle.unarchivePage(asPageId(reqStr(args, "pageId")));
    ctx.tokens.recordWrite(ctx.sessionId, token);
    return { text: "Page unarchived.", data: { token } };
  },
};

const linkTool: WikiTool = {
  name: "link",
  description: "Create a typed graph link between two pages (beyond the tree).",
  inputSchema: obj(
    { workspaceId: STR, from: str("Source page id."), to: str("Target page id."), role: str("Link role/label.") },
    ["workspaceId", "from", "to", "role"],
  ),
  write: true,
  async handle(args, ctx) {
    const ws = asWorkspaceId(reqStr(args, "workspaceId"));
    const handle = await ctx.engine.open(ws);
    const { token } = await handle.link(
      asPageId(reqStr(args, "from")),
      asPageId(reqStr(args, "to")),
      reqStr(args, "role"),
    );
    ctx.tokens.recordWrite(ctx.sessionId, token);
    return { text: "Linked.", data: { token } };
  },
};

const unlinkTool: WikiTool = {
  name: "unlink",
  description: "Remove a typed graph link between two pages.",
  inputSchema: obj(
    { workspaceId: STR, from: STR, to: STR, role: str("The link role to remove.") },
    ["workspaceId", "from", "to", "role"],
  ),
  write: true,
  async handle(args, ctx) {
    const ws = asWorkspaceId(reqStr(args, "workspaceId"));
    const handle = await ctx.engine.open(ws);
    const { token } = await handle.unlink(
      asPageId(reqStr(args, "from")),
      asPageId(reqStr(args, "to")),
      reqStr(args, "role"),
    );
    ctx.tokens.recordWrite(ctx.sessionId, token);
    return { text: "Unlinked.", data: { token } };
  },
};

const createWorkspaceTool: WikiTool = {
  name: "createWorkspace",
  description: "Create a new workspace and return its id.",
  inputSchema: obj({ name: str("The workspace name.") }, ["name"]),
  write: true,
  async handle(args, ctx) {
    const handle = await ctx.engine.createWorkspace({ name: reqStr(args, "name") });
    // `IWiki.createWorkspace` returns a handle, not a Committed token. Derive the
    // high-water token from the workspace head:
    // stream length == head event `version` + 1 == the projection's applied position.
    const history = await handle.history();
    const head = history.length === 0 ? 0 : history[history.length - 1].version + 1;
    const token = encodeToken(handle.id, head);
    ctx.tokens.recordWrite(ctx.sessionId, token);
    return { text: `Created workspace ${handle.id}.`, data: { workspaceId: handle.id, token } };
  },
};

const renameWorkspaceTool: WikiTool = {
  name: "renameWorkspace",
  description:
    "Rename a workspace — set the display name shown by listWorkspaces and used for its " +
    "Markdown-mirror directory (the mirrored tree moves to the new name's slug). The workspace " +
    "id never changes, so existing references stay valid. The name must be non-empty; renaming " +
    "to the current name is a no-op.",
  inputSchema: obj({ workspaceId: STR, name: str("The new workspace name.") }, ["workspaceId", "name"]),
  write: true,
  async handle(args, ctx) {
    const ws = asWorkspaceId(reqStr(args, "workspaceId"));
    const name = reqStr(args, "name");
    const handle = await ctx.engine.open(ws);
    const { token } = await handle.rename(name);
    ctx.tokens.recordWrite(ctx.sessionId, token);
    return { text: `Workspace ${ws} renamed to "${name.trim()}".`, data: { token } };
  },
};

const archiveWorkspaceTool: WikiTool = {
  name: "archiveWorkspace",
  description:
    "Archive a whole workspace — hide it from default workspace listings (listWorkspaces shows it " +
    "as [archived]). Reversible via unarchiveWorkspace; the workspace's pages, links, and history " +
    "are preserved untouched.",
  inputSchema: obj({ workspaceId: STR }, ["workspaceId"]),
  write: true,
  async handle(args, ctx) {
    const ws = asWorkspaceId(reqStr(args, "workspaceId"));
    const handle = await ctx.engine.open(ws);
    const { token } = await handle.archive();
    ctx.tokens.recordWrite(ctx.sessionId, token);
    return { text: `Workspace ${ws} archived.`, data: { token } };
  },
};

const unarchiveWorkspaceTool: WikiTool = {
  name: "unarchiveWorkspace",
  description:
    "Unarchive a workspace previously archived with archiveWorkspace — restore it to default " +
    "listings. Runnable while the workspace is archived (it is the way back).",
  inputSchema: obj({ workspaceId: STR }, ["workspaceId"]),
  write: true,
  async handle(args, ctx) {
    const ws = asWorkspaceId(reqStr(args, "workspaceId"));
    const handle = await ctx.engine.open(ws);
    const { token } = await handle.unarchive();
    ctx.tokens.recordWrite(ctx.sessionId, token);
    return { text: `Workspace ${ws} unarchived.`, data: { token } };
  },
};

const assignSerialsTool: WikiTool = {
  name: "assignSerials",
  description:
    "Backfill engine-assigned `serial` fields (e.g. an ADR's number) onto pages that predate the " +
    "field — assigning the unset pages, per type, in creation order, as one atomic commit. Pages " +
    "whose serial is already set are left untouched. Idempotent: safe to re-run. Use once after " +
    "adding a serial field to a page type that already has pages.",
  inputSchema: obj({ workspaceId: STR }, ["workspaceId"]),
  write: true,
  async handle(args, ctx) {
    const ws = asWorkspaceId(reqStr(args, "workspaceId"));
    const handle = await ctx.engine.open(ws);
    const { token } = await handle.assignSerials();
    ctx.tokens.recordWrite(ctx.sessionId, token);
    return { text: `Assigned serial numbers in ${ws}.`, data: { token } };
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Runtime Markdown emitters (per-project disk mirrors) — configure / list / remove
// ────────────────────────────────────────────────────────────────────────────

/** Read the optional `archive` arg, defaulting to `"drop"`, validating the enum. */
function reqArchive(args: Record<string, unknown>): EmitterArchive {
  const v = args.archive;
  if (v === undefined || v === null) return "drop";
  if (v !== "drop" && v !== "mirror") {
    throw new Error('invalid "archive" (expected "drop" or "mirror")');
  }
  return v;
}

const configureEmitterTool: WikiTool = {
  name: "configureEmitter",
  description:
    "Register (or reconfigure) a Markdown disk mirror: render one workspace's deterministic " +
    "Markdown to one ABSOLUTE on-disk root, kept live. Keyed by a caller-supplied emitterId " +
    "(re-using an id replaces that emitter — e.g. to point it at a new root). The mirror takes " +
    "effect immediately (no restart) and back-fills the root from the workspace's current head. " +
    "Config is event-sourced on the per-namespace `_emitter-config` durable stream, so it " +
    "survives restarts. Roots are written verbatim (local, single-machine trust in v1).",
  inputSchema: obj(
    {
      emitterId: str("Caller-supplied id for this mirror (re-using it reconfigures the emitter)."),
      workspaceId: str("The workspace to mirror."),
      root: str("Absolute on-disk directory to write the Markdown tree into."),
      archive: {
        type: ["string", "null"],
        enum: ["drop", "mirror", null],
        description: "Archived-page policy: omit/\"drop\" removes their files; \"mirror\" moves them under _archive/.",
      },
    },
    ["emitterId", "workspaceId", "root"],
  ),
  write: true,
  async handle(args, ctx) {
    const store = ctx.emitters;
    if (store === undefined) throw new Error("Runtime emitters are not configured on this server.");
    const emitterId = reqStr(args, "emitterId");
    const workspaceId = asWorkspaceId(reqStr(args, "workspaceId"));
    const root = reqStr(args, "root");
    if (!isAbsolute(root)) throw new Error(`root must be an absolute path (got "${root}").`);
    const archive = reqArchive(args);
    // Validate the workspace exists (engine catalog is authoritative for existence) so a typo
    // doesn't register a dead emitter; append NOTHING when it doesn't.
    const known = await ctx.engine.listWorkspaces();
    if (!known.some((w) => w.id === workspaceId)) {
      throw new Error(`Unknown workspace ${workspaceId}.`);
    }
    await store.appendConfigured({ emitterId, workspaceId, root, archive });
    return {
      text: `Configured emitter ${emitterId}: ${workspaceId} → ${root} (archive: ${archive}).`,
      data: { emitterId, workspaceId, root, archive },
    };
  },
};

const listEmittersTool: WikiTool = {
  name: "listEmitters",
  description:
    "List the live Markdown emitters (per-project disk mirrors) — each emitterId with the " +
    "workspace it mirrors, its absolute root, and archive policy. Folded from the " +
    "`_emitter-config` durable stream (last-writer-wins per emitterId).",
  inputSchema: obj({}, []),
  write: false,
  async handle(_args, ctx) {
    const store = ctx.emitters;
    if (store === undefined) return { text: "Runtime emitters are not configured on this server.", data: [] };
    const { events } = await store.readAll();
    const emitters = [...foldEmitters(events).values()];
    const lines = emitters.map((e) => `- ${e.emitterId}: ${e.workspaceId} → ${e.root} (archive: ${e.archive})`);
    return { text: emitters.length === 0 ? "No emitters configured." : lines.join("\n"), data: emitters };
  },
};

const removeEmitterTool: WikiTool = {
  name: "removeEmitter",
  description:
    "Remove a Markdown emitter by id: stop updating its mirror and detach the sink, effective " +
    "immediately (no restart). Already-mirrored files are LEFT on disk — the repo checkout owns " +
    "them from then on. Removing an unknown id is a tolerated no-op.",
  inputSchema: obj({ emitterId: str("The emitter id to remove.") }, ["emitterId"]),
  write: true,
  async handle(args, ctx) {
    const store = ctx.emitters;
    if (store === undefined) throw new Error("Runtime emitters are not configured on this server.");
    const emitterId = reqStr(args, "emitterId");
    await store.appendRemoved(emitterId);
    return { text: `Removed emitter ${emitterId} (mirrored files left on disk).`, data: { emitterId } };
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Page-scoped mutation (engine-validated args) + describeMutations
// ────────────────────────────────────────────────────────────────────────────

const mutatePageTool: WikiTool = {
  name: "mutatePage",
  description:
    "Run a page-scoped content/status command on a page. The command name and its " +
    "args come from describeMutations(pageId) — the engine validates `args` against " +
    "the command's schema and the page's current status, returning a structured error " +
    "(with the legal command set) if the call is illegal.",
  inputSchema: obj(
    {
      workspaceId: STR,
      pageId: STR,
      command: str("The command name (see describeMutations)."),
      args: { type: "object", description: "The command's arguments (validated by the engine).", additionalProperties: true },
    },
    ["workspaceId", "pageId", "command"],
  ),
  write: true,
  async handle(args, ctx) {
    const ws = asWorkspaceId(reqStr(args, "workspaceId"));
    const handle = await ctx.engine.open(ws);
    const cmdArgs = (args.args ?? {}) as Record<string, unknown>;
    const pageId = asPageId(reqStr(args, "pageId"));
    const { value, token } = await handle.mutate(pageId, reqStr(args, "command"), cmdArgs);
    ctx.tokens.recordWrite(ctx.sessionId, token);
    const next = await summarizeNext(handle, pageId, token);
    return {
      text: `Ran ${reqStr(args, "command")}.` + nextLine(next),
      data: { result: value, token, ...(next !== undefined ? { next } : {}) },
    };
  },
};

const mutatePageBatchTool: WikiTool = {
  name: "mutatePageBatch",
  description:
    "Run an ORDERED batch of commands on ONE page as a single ATOMIC commit — collapses the " +
    "N round-trips of populating a page (e.g. setSummary + many addComponent/addConstraint) " +
    "into one call. Each command is decided against the state left by the previous one, so " +
    "order-dependent sequences work (set a field, then a transition gated on it). All-or-" +
    "nothing: if any command is rejected the WHOLE batch aborts and nothing is committed — " +
    "the error names the failing index + command + reason (with the legal set), so fix that " +
    "command and resubmit. Command names/args come from describePageType / describeMutations. " +
    "To cross-reference an element you add in the same batch, pass its `id` explicitly in the " +
    "add command's args and reuse it.",
  inputSchema: obj(
    {
      workspaceId: STR,
      pageId: STR,
      commands: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        description: "Ordered commands, applied as one atomic commit.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["command"],
          properties: {
            command: str("The command name (see describePageType / describeMutations)."),
            args: { type: "object", description: "The command's arguments (validated by the engine).", additionalProperties: true },
          },
        },
      },
    },
    ["workspaceId", "pageId", "commands"],
  ),
  write: true,
  async handle(args, ctx) {
    const ws = asWorkspaceId(reqStr(args, "workspaceId"));
    const handle = await ctx.engine.open(ws);
    const pageId = asPageId(reqStr(args, "pageId"));
    const raw = args.commands;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error('"commands" must be a non-empty array of { command, args? }');
    }
    // Enforce the advertised cap (the SDK does not validate inputSchema for us): one
    // batch is one append held under the per-workspace mutex, so bound its size.
    if (raw.length > 50) {
      throw new Error(`mutatePageBatch accepts at most 50 commands; got ${raw.length}.`);
    }
    const commands = raw.map((c) => {
      const entry = c as { command?: unknown; args?: unknown };
      if (typeof entry.command !== "string" || entry.command.length === 0) {
        throw new Error('each batch entry needs a non-empty "command" string');
      }
      return { command: entry.command, args: (entry.args ?? {}) as Record<string, unknown> };
    });
    // Atomic: the engine throws BatchCommandError (with the failing index) on rejection,
    // committing nothing — server.ts surfaces it as a structured [BATCH_COMMAND_FAILED] error.
    const { value, token } = await handle.mutateMany(pageId, commands);
    ctx.tokens.recordWrite(ctx.sessionId, token);
    const next = await summarizeNext(handle, pageId, token);
    return {
      text: `Ran ${commands.length} command(s) on ${reqStr(args, "pageId")} in one atomic commit.` + nextLine(next),
      // `value` is undefined on an idempotent (commandId) replay — guard the contract.
      data: { results: value?.results ?? [], token, ...(next !== undefined ? { next } : {}) },
    };
  },
};

const nextActionsTool: WikiTool = {
  name: "nextActions",
  description:
    "Self-direction roll-up across a page's subtree (or the whole workspace): partitions the " +
    "model-declared FSM edges into `do` (agent edges legal now — drive these yourself), `blocked` " +
    "(agent edges with the unmet precondition to satisfy first — the reason names the content to " +
    "author), `humanGates` (sign-off/decision edges where a person decides — stop), and `attention` " +
    "(items a model flags as awaiting a human). Drive `do`/`blocked` to completion; only `humanGates` " +
    "+ `attention` are real stopping points. Generic — no page-type knowledge.",
  inputSchema: obj(
    { workspaceId: STR, pageId: nullableStr("Scope to this page's subtree, or null/omit for the whole workspace.") },
    ["workspaceId"],
  ),
  write: false,
  async handle(args, ctx) {
    const ws = asWorkspaceId(reqStr(args, "workspaceId"));
    await awaitConsistency(ctx, ws);
    const handle = await ctx.engine.open(ws);
    const scope = optStrOrNull(args, "pageId");
    const [pages, edges] = await Promise.all([ctx.readModel.listPages(ws), ctx.readModel.treeEdges(ws)]);
    const ids = visibleSubtreeIds(pages, edges, scope);
    const token = ctx.tokens.consistentWith(ctx.sessionId, ws);
    const opts = token !== undefined ? { consistentWith: token } : undefined;
    const summary = await rollupSubtree(handle, ids, opts);
    return { text: renderNextSummary(summary), data: summary };
  },
};

const describeMutationsTool: WikiTool = {
  name: "describeMutations",
  description:
    "List the commands a page can run right now: each with its JSON-Schema args and " +
    "whether it is currently legal in the page's status. Use this to discover the exact " +
    "input schema before calling mutatePage.",
  inputSchema: obj({ workspaceId: STR, pageId: STR }, ["workspaceId", "pageId"]),
  write: false,
  async handle(args, ctx) {
    const ws = asWorkspaceId(reqStr(args, "workspaceId"));
    await awaitConsistency(ctx, ws);
    const handle = await ctx.engine.open(ws);
    const view = await handle.page(asPageId(reqStr(args, "pageId")));
    const descriptors = await view.describeMutations();
    const agencyTag = (a?: string): string => (a === "agent" ? " [agent]" : a === "human" ? " [human gate]" : "");
    const lines = descriptors.map(
      (d) =>
        `- ${d.name}${agencyTag(d.agency)}${d.available ? "" : " (not currently legal)"}${d.description ? `: ${d.description}` : ""}`,
    );
    return {
      text: `Mutations for ${view.id} (${view.type}):\n${lines.join("\n")}`,
      data: descriptors,
    };
  },
};

/** Compact one-line hint for a command's args JSON Schema (full schema is in `data`). */
function summarizeArgs(schema: JsonSchema): string {
  const props = (schema as { properties?: Record<string, unknown> }).properties;
  if (props === undefined || Object.keys(props).length === 0) return "(none)";
  const required = new Set((schema as { required?: readonly string[] }).required ?? []);
  const parts = Object.entries(props).map(([k, v]) => {
    const t = (v as { type?: unknown }).type;
    const ts = Array.isArray(t) ? t.join("|") : typeof t === "string" ? t : "any";
    return `${k}${required.has(k) ? "*" : ""}: ${ts}`;
  });
  return `{ ${parts.join(", ")} }`;
}

const describePageTypeTool: WikiTool = {
  name: "describePageType",
  description:
    "Describe a page TYPE's authoring surface WITHOUT a page instance: its status FSM plus " +
    "every command — model-declared commands carry their real JSON-Schema args, description, " +
    "target section/field, and the FSM event they fire; generated structural commands carry " +
    "their target. Omit `type` to list the loaded page types. Use this before createPage / " +
    "mutatePage to learn exact command names + args. (Whether a command is legal right now, " +
    "and unmet preconditions, are instance-specific — use describeMutations for that.)",
  inputSchema: obj(
    { type: nullableStr('The page-type tag (e.g. "feature-brief"). Omit/null to list all loaded types.') },
    [],
  ),
  write: false,
  async handle(args, ctx) {
    const wiki = ctx.engine.raw;
    const type = optStrOrNull(args, "type");
    if (type === null) {
      const types = wiki.pageTypes();
      const lines = types.map((t) => {
        const fsm = wiki.fsmOf(t);
        // `states` is an unordered set (initial first), NOT a path — summarize as a
        // count so we never imply a linear progression the FSM doesn't have. The full
        // edge list is one drill-down away: describePageType({ type }).
        return `- ${t} (initial: ${fsm.initial}; ${fsm.states.length} statuses, ${fsm.transitions.length} transitions)`;
      });
      return {
        text: types.length === 0 ? "No page types loaded." : `Loaded page types:\n${lines.join("\n")}`,
        data: { types },
      };
    }
    if (!wiki.pageTypes().includes(type)) {
      const known = wiki.pageTypes();
      return {
        text: `Unknown page type "${type}". Known types: ${known.join(", ") || "(none)"}.`,
        data: { error: "unknown_type", type, known },
      };
    }
    const desc = wiki.describeType(type);
    const fsmLine =
      desc.fsm.transitions.map((tr) => `${tr.from} —${tr.event}→ ${tr.to}`).join("; ") || "(no transitions)";
    let anyBlocks = false;
    const cmdLines = desc.commands.map((c) => {
      // The target field-kind (e.g. "(blocks)") is part of the target so authoring constraints
      // that differ by kind are visible before the call.
      if (c.targetKind === "blocks") anyBlocks = true;
      const kind = c.targetKind !== undefined ? ` (${c.targetKind})` : "";
      const tgt = c.target !== undefined ? ` →${c.target.section}${c.target.field !== undefined ? `.${c.target.field}` : ""}${kind}` : "";
      const ev = c.transition !== undefined ? ` [fires ${c.transition.event}]` : "";
      const gen = c.generated ? " (generated)" : "";
      const why = c.description !== undefined ? ` — ${c.description}` : "";
      // A generated structural command carries no curated schema (argsSchema is `{}`),
      // but it is NOT zero-arg — its args are implied by the target section/field. Say
      // so, rather than printing the bare "(none)" a real zero-arg command shows.
      const argHint = c.generated ? "(implied by target)" : summarizeArgs(c.argsSchema);
      return `- ${c.name}${tgt}${ev}${gen}  args ${argHint}${why}`;
    });
    // One presentational line about the kind distinction (not copied per-command; the canonical
    // rule lives in the engine's ingestion). Only shown when a blocks field is actually present.
    const blocksNote = anyBlocks
      ? "\nNote: (blocks) fields hold structured blocks — their prose runs reject inline Markdown; add code/refs/marks via the targeted commands, unlike (prose) fields which accept inline emphasis."
      : "";
    const reqChildren =
      desc.requiredChildren !== undefined && desc.requiredChildren.length > 0
        ? `\nAuto-creates pinned children on create: ${desc.requiredChildren.join(", ")} — author INTO those, do not create your own.`
        : "";
    const head = `${desc.type}${desc.label !== undefined ? ` — ${desc.label}` : ""}\nStatus FSM (initial: ${desc.fsm.initial}): ${fsmLine}${reqChildren}\nCommands:`;
    return { text: `${head}\n${cmdLines.join("\n")}${blocksNote}`, data: desc };
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Read tools (SQL read model)
// ────────────────────────────────────────────────────────────────────────────

const listWorkspacesTool: WikiTool = {
  name: "listWorkspaces",
  description: "List all workspaces in this namespace (id, name, status).",
  inputSchema: obj({}, []),
  write: false,
  async handle(_args, ctx) {
    await awaitAllConsistency(ctx);
    const rows = await ctx.readModel.listWorkspaces();
    const lines = rows.map((r) => `- ${r.id} — ${r.name} [${r.status}]`);
    return { text: rows.length === 0 ? "No workspaces." : lines.join("\n"), data: rows };
  },
};

const getPageTool: WikiTool = {
  name: "getPage",
  description: "Fetch one page's projected state (type, title, status, sections) from the read model.",
  inputSchema: obj({ workspaceId: STR, pageId: STR }, ["workspaceId", "pageId"]),
  write: false,
  async handle(args, ctx) {
    const ws = asWorkspaceId(reqStr(args, "workspaceId"));
    await awaitConsistency(ctx, ws);
    const row = await ctx.readModel.getPage(ws, reqStr(args, "pageId"));
    if (row === undefined) return { text: `Page ${reqStr(args, "pageId")} not found.`, data: null };
    return { text: `${row.title} (${row.type}) [${row.status}]`, data: row };
  },
};

const treeTool: WikiTool = {
  name: "tree",
  description:
    "The ordered page tree of a workspace as an indented outline (title, type, status, id), " +
    "plus a slim { nodes, edges } payload. Archived pages (and their subtrees) are hidden by " +
    "default — pass includeArchived:true to show them (flagged [archived]). Structure + metadata " +
    "ONLY — never page content (use renderPage or getPage for a page's body).",
  inputSchema: obj(
    {
      workspaceId: STR,
      includeArchived: {
        type: "boolean",
        description: "Include archived pages and their subtrees (default: false — archived pages are hidden).",
      },
    },
    ["workspaceId"],
  ),
  write: false,
  async handle(args, ctx) {
    const ws = asWorkspaceId(reqStr(args, "workspaceId"));
    const includeArchived = (args as { includeArchived?: unknown }).includeArchived === true;
    await awaitConsistency(ctx, ws);
    const [pages, edges] = await Promise.all([ctx.readModel.listPages(ws), ctx.readModel.treeEdges(ws)]);
    // Slim per-page metadata — deliberately DROP the heavy `sections` jsonb. Shipping
    // every page's full folded state here is what made the whole-tree payload blow the
    // response token cap; the structure + light metadata is all `tree` should carry.
    const meta = new Map(
      pages.map(
        (p) =>
          [
            p.id,
            { id: p.id, type: p.type, title: p.title, status: p.status, archived: p.archived, parentId: p.parent_id },
          ] as const,
      ),
    );
    // Children by parent, in ordinal order. Roots are parents that are never a child
    // (the `@root` sentinel, plus any orphan whose parent is gone) — derived, so we
    // don't hard-code the sentinel literal.
    const sorted = [...edges].sort((a, b) => a.ord - b.ord);
    const childrenOf = new Map<string, typeof sorted>();
    for (const e of sorted) {
      const list = childrenOf.get(e.parent_id) ?? [];
      list.push(e);
      childrenOf.set(e.parent_id, list);
    }
    const childIds = new Set(edges.map((e) => e.child_id));
    const roots = [...childrenOf.keys()].filter((p) => !childIds.has(p)).sort();
    // A page is hidden when it — or any ancestor — is archived (ADR-011), unless opted in.
    const hidden = new Set<string>();
    if (!includeArchived) {
      const mark = (parentId: string, underArchived: boolean): void => {
        for (const e of childrenOf.get(parentId) ?? []) {
          const isHidden = underArchived || meta.get(e.child_id)?.archived === true;
          if (isHidden) hidden.add(e.child_id);
          mark(e.child_id, isHidden);
        }
      };
      for (const root of roots) mark(root, false);
    }
    const lines: string[] = [];
    const walk = (parentId: string, depth: number): void => {
      for (const e of childrenOf.get(parentId) ?? []) {
        if (hidden.has(e.child_id)) continue;
        const n = meta.get(e.child_id);
        const flag = n?.archived === true ? " [archived]" : "";
        const label = n !== undefined ? `${n.title} (${n.type}) [${n.status}]${flag}` : "?";
        lines.push(`${"  ".repeat(depth)}- ${label}  ${e.child_id}`);
        walk(e.child_id, depth + 1);
      }
    };
    for (const root of roots) walk(root, 0);
    const nodes = [...meta.values()].filter((n) => !hidden.has(n.id));
    const visibleEdges = edges.filter((e) => !hidden.has(e.child_id));
    return { text: lines.join("\n") || "(empty)", data: { nodes, edges: visibleEdges } };
  },
};

const renderPageTool: WikiTool = {
  name: "renderPage",
  description:
    "Render a page (or the whole workspace tree when pageId is omitted) to Markdown via the engine renderer.",
  inputSchema: obj(
    { workspaceId: STR, pageId: { type: ["string", "null"], description: "Page to render, or null for the whole tree." } },
    ["workspaceId"],
  ),
  write: false,
  async handle(args, ctx) {
    const ws = asWorkspaceId(reqStr(args, "workspaceId"));
    // Render via the hot engine handle; gate it on the session's high-water token so
    // it reflects the session's own writes. The engine read is
    // token-aware via `consistentWith`.
    const token = ctx.tokens.consistentWith(ctx.sessionId, ws);
    const handle = await ctx.engine.open(ws);
    const pageId = optStrOrNull(args, "pageId");
    const opts = token !== undefined ? { consistentWith: token } : undefined;
    const md = pageId === null ? await handle.toMarkdown(undefined, opts) : await handle.toMarkdown(asPageId(pageId), opts);
    return { text: md, data: { markdown: md } };
  },
};

const searchTool: WikiTool = {
  name: "search",
  description:
    "Full-text search over page CONTENT — the page's rendered Markdown (titles, prose, code, " +
    "decisions, …) — within ONE workspace. Returns ranked hits, each with a highlighted snippet of " +
    "the match; archived pages are excluded. Case-insensitive: a plain query matches by word PREFIX " +
    "(so \"concur\" finds \"concurrency\"); a query using web operators (quoted \"phrases\", OR, " +
    "-excluded) is matched whole-word. Workspace-scoped by design (ADR-30: cross-workspace operations " +
    "are an admin/system affordance) — pass `workspaceId`.",
  inputSchema: obj(
    {
      query: str("Words to find in page content. Plain words match case-insensitively by prefix; quoted phrases, OR, and -term are honored."),
      workspaceId: STR,
      limit: { type: ["number", "null"], description: "Max hits to return, a positive integer (default 20)." },
    },
    ["query", "workspaceId"],
  ),
  write: false,
  async handle(args, ctx) {
    const index = ctx.searchIndex;
    if (index === undefined) return { text: "Search is not configured on this server.", data: [] };

    const query = reqStr(args, "query");
    const ws = asWorkspaceId(reqStr(args, "workspaceId"));
    // Only a positive number is a meaningful limit; anything else falls back to the
    // index default (the index also clamps defensively before the value reaches SQL).
    const limit = typeof args.limit === "number" && args.limit >= 1 ? Math.floor(args.limit) : undefined;

    await awaitSearchConsistency(index, ctx, ws);
    const hits = await index.query([ws], query, limit !== undefined ? { limit } : undefined);
    const lines = hits.map((h) => `- ${h.title} (${h.type}) ${h.pageId}\n    ${h.snippet}`);
    return { text: hits.length === 0 ? "No matches." : lines.join("\n"), data: hits };
  },
};

const attentionTool: WikiTool = {
  name: "attention",
  description:
    "Scan ONE workspace for element instances a model flags as AWAITING A HUMAN — via the " +
    "model-declared `awaitsHuman` predicate (e.g. an escalated, still-open question). Generic: the " +
    "host carries no element-type or status vocabulary; each model decides what awaits a person. " +
    "Workspace-scoped by design (ADR: cross-workspace operations are an admin/system affordance, " +
    "not a content read) — pass `workspaceId`.",
  inputSchema: obj({ workspaceId: STR }, ["workspaceId"]),
  write: false,
  async handle(args, ctx) {
    const ws = asWorkspaceId(reqStr(args, "workspaceId"));
    await awaitConsistency(ctx, ws);
    const handle = await ctx.engine.open(ws);
    const pages = await ctx.readModel.listPages(ws);
    const token = ctx.tokens.consistentWith(ctx.sessionId, ws);
    const opts = token !== undefined ? { consistentWith: token } : undefined;
    const waiting: Array<{ pageId: string; pageTitle: string; itemId: string; sectionKey: string; field: string; status?: string }> = [];
    for (const p of pages) {
      if (p.archived === true) continue; // archived pages can't be mutated → can't be acted on
      let view;
      try {
        view = await handle.page(asPageId(p.id), opts);
      } catch (e) {
        if (e instanceof PageNotFoundError) continue; // engine not yet caught up to a concurrent write
        throw e;
      }
      for (const it of await view.attentionItems(opts)) {
        waiting.push({
          pageId: p.id,
          pageTitle: p.title,
          itemId: it.elementId,
          sectionKey: it.sectionKey,
          field: it.field,
          ...(it.status !== undefined ? { status: it.status } : {}),
        });
      }
    }
    const lines = waiting.map(
      (q) => `- ${q.pageTitle}: ${q.itemId} (${q.sectionKey}.${q.field})${q.status !== undefined ? ` [${q.status}]` : ""}`,
    );
    return { text: waiting.length === 0 ? "Nothing awaiting human attention." : lines.join("\n"), data: waiting };
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Derived-projection read tools (outline · symbols · references)
// ────────────────────────────────────────────────────────────────────────────

/**
 * A nested outline node — the section tree shape the `outline` tool returns.
 * `(key, name, order)` plus children, rebuilt from the flat `outline` rows.
 */
interface OutlineNode {
  sectionId: string;
  key: string;
  name: string;
  order: number;
  children: OutlineNode[];
}

const outlineTool: WikiTool = {
  name: "outline",
  description:
    "A page's section tree (key, name, order) from the outline projection — " +
    "no parsing, straight from folded state. Token-gated for read-your-writes.",
  inputSchema: obj({ workspaceId: STR, pageId: STR }, ["workspaceId", "pageId"]),
  write: false,
  async handle(args, ctx) {
    const ws = asWorkspaceId(reqStr(args, "workspaceId"));
    await awaitConsistency(ctx, ws);
    const rows = await ctx.readModel.outline(ws, reqStr(args, "pageId"));
    // Rebuild the nested tree from the flat rows (rows are ordered by parent, ord).
    const byId = new Map<string, OutlineNode>();
    for (const r of rows) {
      byId.set(r.section_id, { sectionId: r.section_id, key: r.key, name: r.name, order: r.ord, children: [] });
    }
    const roots: OutlineNode[] = [];
    for (const r of rows) {
      const node = byId.get(r.section_id)!;
      const parent = r.parent_section_id !== null ? byId.get(r.parent_section_id) : undefined;
      if (parent !== undefined) parent.children.push(node);
      else roots.push(node);
    }
    const lines: string[] = [];
    const render = (nodes: OutlineNode[], depth: number): void => {
      for (const n of nodes) {
        lines.push(`${"  ".repeat(depth)}- ${n.name} (${n.key})`);
        render(n.children, depth + 1);
      }
    };
    render(roots, 0);
    return { text: lines.join("\n") || "(no sections)", data: roots };
  },
};

const symbolsTool: WikiTool = {
  name: "symbols",
  description:
    "Symbols (declarations) indexed from `code` fields/blocks across a workspace " +
    "optionally scoped to one page and/or filtered by exact name or kind. " +
    "Each symbol carries its kind, container, and [defStart, defEnd) offset range into " +
    "canonical source. A `code` field in an unanalyzed language yields only a location " +
    "stub (no name/kind). Token-gated for read-your-writes.",
  inputSchema: obj(
    {
      workspaceId: STR,
      pageId: nullableStr("Restrict to one page, or null/omit for the whole workspace."),
      name: nullableStr("Filter by exact symbol name."),
      kind: nullableStr("Filter by exact symbol kind (e.g. function, class, method)."),
    },
    ["workspaceId"],
  ),
  write: false,
  async handle(args, ctx) {
    const ws = asWorkspaceId(reqStr(args, "workspaceId"));
    await awaitConsistency(ctx, ws);
    const pageId = optStrOrNull(args, "pageId");
    const name = optStrOrNull(args, "name");
    const kind = optStrOrNull(args, "kind");
    const filter = {
      ...(pageId !== null ? { pageId } : {}),
      ...(name !== null ? { name } : {}),
      ...(kind !== null ? { kind } : {}),
    };
    const rows = await ctx.readModel.symbols(ws, filter);
    const lines = rows.map((r) =>
      r.name === null
        ? `- [${r.lang}] ${r.page_id}/${r.section_id}.${r.field}${r.block_id ? `#${r.block_id}` : ""} (no analyzer)`
        : `- ${r.kind} ${r.container ? `${r.container}.` : ""}${r.name} @[${r.def_start},${r.def_end}) (${r.page_id}/${r.section_id}.${r.field}${r.block_id ? `#${r.block_id}` : ""})`,
    );
    return { text: rows.length === 0 ? "No symbols." : lines.join("\n"), data: rows };
  },
};

const referencesTool: WikiTool = {
  name: "references",
  description:
    "In-source references (identifier occurrences) to a given symbol name across a " +
    "workspace's `code` fields/blocks, optionally scoped to one page. Each " +
    "reference carries its [start, end) offset. Resolution to a specific declaration " +
    "(cross-file / type-aware) is deferred; this is the by-name where-used index. " +
    "Token-gated for read-your-writes.",
  inputSchema: obj(
    {
      workspaceId: STR,
      name: str("The symbol name to find references to."),
      pageId: nullableStr("Restrict to one page, or null/omit for the whole workspace."),
    },
    ["workspaceId", "name"],
  ),
  write: false,
  async handle(args, ctx) {
    const ws = asWorkspaceId(reqStr(args, "workspaceId"));
    await awaitConsistency(ctx, ws);
    const name = reqStr(args, "name");
    const pageId = optStrOrNull(args, "pageId");
    const filter = pageId !== null ? { pageId } : undefined;
    const rows = await ctx.readModel.references(ws, name, filter);
    const lines = rows.map(
      (r) => `- ${r.name} @[${r.ref_start},${r.ref_end}) (${r.page_id}/${r.section_id}.${r.field}${r.block_id ? `#${r.block_id}` : ""})`,
    );
    return { text: rows.length === 0 ? `No references to "${name}".` : lines.join("\n"), data: rows };
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Semantic operations (write) — renameSymbol (Phase 3)
// ────────────────────────────────────────────────────────────────────────────

/** Capitalize the first letter (mirrors the engine's generated-command derivation). */
function cap(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The engine's generated guarded code-edit command name for a `(section, field)`
 * target — `apply<Section><Field>Edits` for a `code` field, or
 * `apply<Section><Field>BlockEdits` when addressing a `code` block in a `blocks`
 * field (mirrors `registry.deriveGenerated`).
 */
function codeEditCommand(section: string, field: string, onBlock: boolean): string {
  return onBlock ? `apply${cap(section)}${cap(field)}BlockEdits` : `apply${cap(section)}${cap(field)}Edits`;
}

/** The shape of a serialized section in a `pages.sections` JSONB row. */
interface SectionJson {
  id: string;
  key: string;
  fields?: Record<string, FieldJson>;
}
type FieldJson =
  | { kind: "code"; lang: string; source: string; hash: string }
  | { kind: "blocks"; blocks: BlockJson[] }
  | { kind: string; [k: string]: unknown };
type BlockJson = { kind: string; id?: string; lang?: string; source?: string; hash?: string } & Record<string, unknown>;

/** A located `code` field/block's canonical source + hash, read from a page row. */
interface CodeLocation {
  readonly lang: string;
  readonly source: string;
  readonly hash: string;
}

/**
 * Locate a `code` field (or a `code` block by id, when `block` is given) in a page's
 * serialized section tree, returning its canonical source + hash. The canonical source
 * is the write-model source of truth; we read it from the read-model page row.
 */
function locateCode(sections: SectionJson[], section: string, field: string, block: string | undefined): CodeLocation | undefined {
  const sec = sections.find((s) => s.key === section);
  const f = sec?.fields?.[field];
  if (f === undefined) return undefined;
  if (block !== undefined) {
    if (f.kind !== "blocks") return undefined;
    const blk = (f as { blocks: BlockJson[] }).blocks.find((b) => b.id === block);
    if (blk === undefined || blk.kind !== "code") return undefined;
    return { lang: String(blk.lang ?? "ts"), source: String(blk.source ?? ""), hash: String(blk.hash ?? "") };
  }
  if (f.kind !== "code") return undefined;
  const cf = f as { lang: string; source: string; hash: string };
  return { lang: cf.lang, source: cf.source, hash: cf.hash };
}

const renameSymbolTool: WikiTool = {
  name: "renameSymbol",
  description:
    "Type-aware rename of a symbol within ONE `code` field or `code` block (Phase 3). " +
    "Reads the field/block's current canonical source, computes scope-correct rename edits " +
    "with the language analyzer (a single-file type-checker, so shadowed / unrelated " +
    "same-name identifiers are NOT touched), then applies them via a guarded code-edit " +
    "command under a CONTENT-HASH PRECONDITION (rejected + retried once on a concurrent " +
    "write). GUARANTEE SCOPE: sound only for in-scope references within the single edited " +
    "source in a supported language. Same-name references in OTHER code fields / blocks / " +
    "pages are REPORTED as `candidates` (where-used), never auto-renamed; cross-workspace " +
    "and prose occurrences are out of scope. Returns the new consistency token, the applied " +
    "edits, any `unresolved` notes, and the reported `candidates`.",
  inputSchema: obj(
    {
      workspaceId: STR,
      pageId: str("The page whose code field/block to edit."),
      section: str("The section KEY containing the code field/block."),
      field: str("The field key (a `code` field, or a `blocks` field when `block` is set)."),
      block: nullableStr("A `code` block id inside a `blocks` field, or null/omit for a `code` field."),
      symbol: nullableStr("The symbol name to rename (the first declaration of that name)."),
      offset: { type: ["integer", "null"], minimum: 0, description: "An offset into the source on the target identifier (disambiguates same-name declarations). Use instead of, or with, `symbol`." },
      newName: str("The new name for the symbol."),
    },
    ["workspaceId", "pageId", "section", "field", "newName"],
  ),
  write: true,
  async handle(args, ctx) {
    const ws = asWorkspaceId(reqStr(args, "workspaceId"));
    const pageId = reqStr(args, "pageId");
    const section = reqStr(args, "section");
    const field = reqStr(args, "field");
    const block = optStrOrNull(args, "block") ?? undefined;
    const newName = reqStr(args, "newName");
    const symbol = optStrOrNull(args, "symbol") ?? undefined;
    const offset = typeof args.offset === "number" ? args.offset : undefined;
    if (symbol === undefined && offset === undefined) {
      throw new Error('renameSymbol needs a target: pass "symbol" (a name) and/or "offset".');
    }

    // Read the CURRENT canonical source + hash for this code field/block, gated on the
    // session's own writes so we rename against the latest committed source.
    await awaitConsistency(ctx, ws);
    const located = await readCode(ctx, ws, pageId, section, field, block);
    if (located === undefined) {
      throw new Error(`No code field/block at ${pageId}/${section}.${field}${block ? `#${block}` : ""}.`);
    }
    const analyzer = LANGUAGES.get(located.lang);
    if (analyzer?.rename === undefined) {
      throw new Error(`No rename-capable analyzer for lang "${located.lang}" (rename is supported for TS/JS).`);
    }

    const target: RenameTarget = offset !== undefined ? { offset } : { name: symbol! };
    const rename = analyzer.rename(located.source, target, newName, located.lang);
    if (rename.edits.length === 0) {
      return {
        text: `No bound occurrences of ${symbol ?? `offset ${offset}`} were renamed.${rename.unresolved.length ? ` ${rename.unresolved.join(" ")}` : ""}`,
        data: { token: null, edits: [], unresolved: rename.unresolved, candidates: [] },
      };
    }

    const command = codeEditCommand(section, field, block !== undefined);
    const handle = await ctx.engine.open(ws);

    // Apply the precomputed edits via the guarded code-edit command under the
    // content-hash precondition. On a StaleEditError (a concurrent write changed the
    // source), re-read + recompute ONCE, then either succeed or surface the conflict.
    let token: string;
    let appliedEdits = rename.edits;
    let usedHash = located.hash;
    try {
      const res = await handle.mutate(asPageId(pageId), command, {
        ...(block !== undefined ? { block } : {}),
        edits: rename.edits,
        expectedHash: located.hash,
        label: "renameSymbol",
      });
      token = res.token;
    } catch (e) {
      if (!(e instanceof StaleEditError)) throw e;
      // Concurrent write: re-read the now-current source, recompute, retry once.
      const fresh = await readCode(ctx, ws, pageId, section, field, block, /* bypassCache */ true);
      if (fresh === undefined) throw e;
      const recomputed = analyzer.rename(fresh.source, target, newName, fresh.lang);
      if (recomputed.edits.length === 0) {
        throw new Error(`renameSymbol conflict: the source changed concurrently and no bound occurrences remain. ${recomputed.unresolved.join(" ")}`);
      }
      const res = await handle.mutate(asPageId(pageId), command, {
        ...(block !== undefined ? { block } : {}),
        edits: recomputed.edits,
        expectedHash: fresh.hash,
        label: "renameSymbol",
      });
      token = res.token;
      appliedEdits = recomputed.edits;
      usedHash = fresh.hash;
    }
    ctx.tokens.recordWrite(ctx.sessionId, token);

    // Harvest OTHER same-name references (cross-field / cross-page) from the by-name
    // reference index — REPORTED as candidates, NOT renamed (honest guarantee scope).
    // Exclude the edited field/block itself (those were just renamed in-place).
    const refs = await ctx.readModel.references(ws, rename.oldName);
    const candidates = refs
      .filter((r) => !(r.page_id === pageId && r.section_id === located.sectionId && r.field === field && (r.block_id ?? undefined) === block))
      .map((r) => ({
        pageId: r.page_id,
        sectionId: r.section_id,
        field: r.field,
        blockId: r.block_id,
        start: r.ref_start,
        end: r.ref_end,
      }));

    const sameField = candidates.filter((c) => c.pageId === pageId);
    return {
      text:
        `Renamed "${rename.oldName}" → "${newName}" in ${pageId}/${section}.${field}${block ? `#${block}` : ""} ` +
        `(${appliedEdits.length} edit${appliedEdits.length === 1 ? "" : "s"}). ` +
        `${candidates.length} same-name reference(s) in OTHER code fields/pages were REPORTED, not renamed` +
        `${sameField.length ? ` (${sameField.length} elsewhere on this page)` : ""}.` +
        `${rename.unresolved.length ? ` Notes: ${rename.unresolved.join(" ")}` : ""}`,
      data: {
        token,
        oldName: rename.oldName,
        newName,
        edits: appliedEdits,
        expectedHash: usedHash,
        unresolved: rename.unresolved,
        candidates,
        guaranteeScope:
          "Renames are sound only for in-scope references within the single edited source in a supported language. " +
          "Candidates in other fields/pages and any cross-workspace or prose occurrences are reported, never auto-applied.",
      },
    };
  },
};

/**
 * Read the CURRENT canonical source + hash for a `(page, section, field, block?)` code
 * target from the read-model page row. `bypassCache` is accepted for symmetry with a
 * post-conflict re-read; the read model is queried fresh either way.
 */
async function readCode(
  ctx: WikiToolContext,
  ws: WorkspaceId,
  pageId: string,
  section: string,
  field: string,
  block: string | undefined,
  _bypassCache = false,
): Promise<(CodeLocation & { sectionId: string }) | undefined> {
  const row = await ctx.readModel.getPage(ws, pageId);
  if (row === undefined) return undefined;
  const sections = ((row.sections ?? []) as unknown as SectionJson[]) ?? [];
  const located = locateCode(sections, section, field, block);
  if (located === undefined) return undefined;
  const sec = sections.find((s) => s.key === section);
  return { ...located, sectionId: sec?.id ?? "" };
}

// ────────────────────────────────────────────────────────────────────────────
// The full catalog
// ────────────────────────────────────────────────────────────────────────────

/**
 * The full tool catalog: the full catalog is exposed; the engine's guard rejects
 * illegal calls with structured errors the agent self-corrects on.
 */
export function wikiTools(): readonly WikiTool[] {
  return [
    // writes
    createWorkspaceTool,
    renameWorkspaceTool,
    archiveWorkspaceTool,
    unarchiveWorkspaceTool,
    assignSerialsTool,
    // runtime Markdown emitters (per-project disk mirrors)
    configureEmitterTool,
    listEmittersTool,
    removeEmitterTool,
    createPageTool,
    reparentTool,
    setPageTitleTool,
    archivePageTool,
    unarchivePageTool,
    linkTool,
    unlinkTool,
    mutatePageTool,
    mutatePageBatchTool,
    // semantic operations (write, Phase 3)
    renameSymbolTool,
    // reads
    nextActionsTool,
    describeMutationsTool,
    describePageTypeTool,
    listWorkspacesTool,
    getPageTool,
    treeTool,
    renderPageTool,
    searchTool,
    attentionTool,
    // derived projections
    outlineTool,
    symbolsTool,
    referencesTool,
  ];
}
