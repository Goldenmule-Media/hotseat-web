/**
 * The engine command catalog + read queries turned into MCP tools (DESIGN §6.1).
 *
 * - **Write tools.** The structural commands (`createPage`, `reparent`, `link`, …)
 *   get hand-authored JSON-Schema inputs (they aren't covered by
 *   `IPageView.describeMutations()` today, DESIGN §6.1). Page-scoped content/status
 *   mutations flow through a single `mutatePage` tool whose `args` are validated by
 *   the engine's own Zod `argsSchema`; a companion `describeMutations` tool reports
 *   the page's CURRENTLY-legal command set + each command's `argsSchema` (straight
 *   from `IPageView.describeMutations()`), which is how an agent discovers the exact
 *   per-page input schema before calling `mutatePage` (DESIGN §6.1 "only-legal-actions").
 * - **Read tools.** `getPage`, `renderPage`, `tree`, `listWorkspaces`, `search`,
 *   `openQuestions` — backed by the SQL read model (DESIGN §5), token-gated per the
 *   session's high-water marks (DESIGN §6.2).
 *
 * Each tool is a plain {@link WikiTool} descriptor (name + JSON-Schema input +
 * handler). `server.ts` registers them on the low-level MCP `Server` so the engine's
 * RAW JSON Schema is advertised verbatim (the high-level `McpServer.registerTool`
 * wants Zod, which we don't have — we have JSON Schema from the engine). The handler
 * receives the calling session id so the token manager can thread read-your-writes
 * (DESIGN §6.2). Write tools advance the session's high-water mark and echo the
 * token in their result so a client MAY also thread it.
 */
import { encodeToken, type JsonSchema, type WorkspaceId } from "wiki";

import { asPageId, asWorkspaceId, type EmbeddedEngine } from "../engine.js";
import type { SqlReadModel } from "../readmodel/readmodel.js";
import type { SessionTokenManager } from "./tokens.js";

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
  readonly tokens: SessionTokenManager;
  /** The MCP session id (undefined for stdio) — the token-manager key (DESIGN §6.2). */
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
 * read, so the read reflects the session's own writes (DESIGN §6.2). A
 * `ConsistencyTimeoutError` from `waitFor` propagates to a structured tool error in
 * `server.ts` (the agent can retry or read stale).
 */
async function awaitConsistency(ctx: WikiToolContext, workspace: WorkspaceId): Promise<void> {
  const token = ctx.tokens.consistentWith(ctx.sessionId, workspace);
  if (token !== undefined) await ctx.readModel.waitFor(token);
}

/**
 * Fan out a cross-workspace read's consistency wait over every workspace the session
 * has written (DESIGN §6.2): the result reflects ALL of the session's writes.
 */
async function awaitAllConsistency(ctx: WikiToolContext): Promise<void> {
  const tokens = ctx.tokens.allWritten(ctx.sessionId);
  await Promise.all(tokens.map((t) => ctx.readModel.waitFor(t)));
}

// ────────────────────────────────────────────────────────────────────────────
// Write tools (structural commands — hand-authored schemas)
// ────────────────────────────────────────────────────────────────────────────

const createPageTool: WikiTool = {
  name: "createPage",
  description:
    "Create a new page of a registered type in a workspace, optionally under a parent. Returns the new page id.",
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
    return { text: `Created page ${value}.`, data: { pageId: value, token } };
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
  description: "Archive a page (and its subtree, per engine rules).",
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
    // `IWiki.createWorkspace` returns a handle, not a Committed token (DESIGN §3.2 is
    // about write-tool returns). Derive the high-water token from the workspace head:
    // stream length == head event `version` + 1 == the projection's applied position.
    const history = await handle.history();
    const head = history.length === 0 ? 0 : history[history.length - 1].version + 1;
    const token = encodeToken(handle.id, head);
    ctx.tokens.recordWrite(ctx.sessionId, token);
    return { text: `Created workspace ${handle.id}.`, data: { workspaceId: handle.id, token } };
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
    const { value, token } = await handle.mutate(asPageId(reqStr(args, "pageId")), reqStr(args, "command"), cmdArgs);
    ctx.tokens.recordWrite(ctx.sessionId, token);
    return { text: `Ran ${reqStr(args, "command")}.`, data: { result: value, token } };
  },
};

const describeMutationsTool: WikiTool = {
  name: "describeMutations",
  description:
    "List the commands a page can run right now: each with its JSON-Schema args and " +
    "whether it is currently legal in the page's status. Use this to discover the exact " +
    "input schema before calling mutatePage (DESIGN §6.1).",
  inputSchema: obj({ workspaceId: STR, pageId: STR }, ["workspaceId", "pageId"]),
  write: false,
  async handle(args, ctx) {
    const ws = asWorkspaceId(reqStr(args, "workspaceId"));
    await awaitConsistency(ctx, ws);
    const handle = await ctx.engine.open(ws);
    const view = await handle.page(asPageId(reqStr(args, "pageId")));
    const descriptors = await view.describeMutations();
    const lines = descriptors.map(
      (d) => `- ${d.name}${d.available ? "" : " (not currently legal)"}${d.description ? `: ${d.description}` : ""}`,
    );
    return {
      text: `Mutations for ${view.id} (${view.type}):\n${lines.join("\n")}`,
      data: descriptors,
    };
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
  description: "The ordered page tree of a workspace (parent → child edges, by ordinal).",
  inputSchema: obj({ workspaceId: STR }, ["workspaceId"]),
  write: false,
  async handle(args, ctx) {
    const ws = asWorkspaceId(reqStr(args, "workspaceId"));
    await awaitConsistency(ctx, ws);
    const [pages, edges] = await Promise.all([ctx.readModel.listPages(ws), ctx.readModel.treeEdges(ws)]);
    const title = new Map(pages.map((p) => [p.id, p.title] as const));
    const lines = edges.map((e) => `${e.parent_id} → ${e.child_id} (${title.get(e.child_id) ?? "?"}) @${e.ord}`);
    return { text: lines.join("\n") || "(empty)", data: { pages, edges } };
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
    // it reflects the session's own writes (DESIGN §6.2). The engine read is
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
    "Search pages by a substring of their title across one workspace (or all workspaces when workspaceId is omitted).",
  inputSchema: obj(
    {
      query: str("Case-insensitive substring matched against page titles."),
      workspaceId: { type: ["string", "null"], description: "Restrict to one workspace, or null for all." },
    },
    ["query"],
  ),
  write: false,
  async handle(args, ctx) {
    const query = reqStr(args, "query").toLowerCase();
    const oneWs = optStrOrNull(args, "workspaceId");
    if (oneWs !== null) await awaitConsistency(ctx, asWorkspaceId(oneWs));
    else await awaitAllConsistency(ctx);

    const workspaces = oneWs !== null ? [asWorkspaceId(oneWs)] : (await ctx.readModel.listWorkspaces()).map((w) => w.id as WorkspaceId);
    const hits: Array<{ workspaceId: string; pageId: string; title: string; type: string; status: string }> = [];
    for (const ws of workspaces) {
      const pages = await ctx.readModel.listPages(ws);
      for (const p of pages) {
        if (p.title.toLowerCase().includes(query)) {
          hits.push({ workspaceId: ws, pageId: p.id, title: p.title, type: p.type, status: p.status });
        }
      }
    }
    const lines = hits.map((h) => `- [${h.workspaceId}] ${h.title} (${h.type}) ${h.pageId}`);
    return { text: hits.length === 0 ? "No matches." : lines.join("\n"), data: hits };
  },
};

const openQuestionsTool: WikiTool = {
  name: "openQuestions",
  description:
    "Cross-workspace scan for pages carrying `question` items that are not yet resolved " +
    "(an item whose status is not \"resolved\"/\"answered\"/\"closed\"). Fans out over every " +
    "workspace the session has written so the result reflects all of its writes (DESIGN §6.2).",
  inputSchema: obj(
    { workspaceId: { type: ["string", "null"], description: "Restrict to one workspace, or null for all." } },
    [],
  ),
  write: false,
  async handle(args, ctx) {
    const oneWs = optStrOrNull(args, "workspaceId");
    if (oneWs !== null) await awaitConsistency(ctx, asWorkspaceId(oneWs));
    else await awaitAllConsistency(ctx);

    const workspaces = oneWs !== null ? [asWorkspaceId(oneWs)] : (await ctx.readModel.listWorkspaces()).map((w) => w.id as WorkspaceId);
    const RESOLVED = new Set(["resolved", "answered", "closed", "done"]);
    const open: Array<{ workspaceId: string; pageId: string; pageTitle: string; itemId: string; status: string }> = [];
    for (const ws of workspaces) {
      const pages = await ctx.readModel.listPages(ws);
      for (const p of pages) {
        // Walk the section tree: `question` list elements live in a `list` field
        // whose `elementType === "question"` (the new section content model §2/§3).
        const sections = (p.sections ?? []) as Array<{
          fields?: Record<string, { kind?: string; elementType?: string; elements?: Array<Record<string, unknown>> }>;
        }>;
        for (const sec of sections) {
          for (const f of Object.values(sec.fields ?? {})) {
            if (f.kind !== "list" || f.elementType !== "question") continue;
            for (const q of f.elements ?? []) {
              const status = typeof q.status === "string" ? q.status : "open";
              if (!RESOLVED.has(status.toLowerCase())) {
                open.push({ workspaceId: ws, pageId: p.id, pageTitle: p.title, itemId: String(q.id ?? ""), status });
              }
            }
          }
        }
      }
    }
    const lines = open.map((q) => `- [${q.workspaceId}] ${q.pageTitle}: question ${q.itemId} [${q.status}]`);
    return { text: open.length === 0 ? "No open questions." : lines.join("\n"), data: open };
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Derived-projection read tools (outline · symbols · references, DESIGN §6)
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
    "A page's section tree (key, name, order) from the outline projection (DESIGN §6.1) — " +
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
    "(DESIGN §6.2), optionally scoped to one page and/or filtered by exact name or kind. " +
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
    "workspace's `code` fields/blocks (DESIGN §6.2), optionally scoped to one page. Each " +
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
// The full catalog
// ────────────────────────────────────────────────────────────────────────────

/**
 * The full tool catalog (DESIGN §6.1 "the full catalog is exposed; the engine's
 * guard rejects illegal calls with structured errors the agent self-corrects on").
 */
export function wikiTools(): readonly WikiTool[] {
  return [
    // writes
    createWorkspaceTool,
    createPageTool,
    reparentTool,
    setPageTitleTool,
    archivePageTool,
    linkTool,
    unlinkTool,
    mutatePageTool,
    // reads
    describeMutationsTool,
    listWorkspacesTool,
    getPageTool,
    treeTool,
    renderPageTool,
    searchTool,
    openQuestionsTool,
    // derived projections (§6)
    outlineTool,
    symbolsTool,
    referencesTool,
  ];
}
