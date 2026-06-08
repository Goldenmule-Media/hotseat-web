/**
 * The MCP server — exposes the engine command catalog + read queries as
 * MCP tools and `wiki://` resources, plugging the two CQRS planes together with the
 * per-session token manager.
 *
 * Built on the SDK's LOW-LEVEL {@link Server} (not the high-level `McpServer`),
 * because our tool input schemas are the engine's RAW JSON Schema (from
 * `argsSchema` / `describeMutations`), and `McpServer.registerTool` wants Zod —
 * which we don't have. The low-level `Server.setRequestHandler` also exposes
 * `extra.sessionId`, the key the token manager threads read-your-writes on.
 * The engine validates a write's `args` itself and rejects illegal
 * calls with structured errors the agent self-corrects on — those map
 * to a tool result with `isError: true`.
 *
 * Transports: **stdio** for a local agent (one ambient session), and
 * **streamable HTTP** for a networked / `wiki-server`-embedded deployment
 * (per-request session ids). The stream client / DB live elsewhere; this
 * module only wires the protocol surface.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type ListResourcesResult,
  type ListToolsResult,
  type ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import { WikiError, decodeToken, type ISearchIndex, type WorkspaceId } from "wiki";

import { asWorkspaceId, type EmbeddedEngine } from "../engine.js";
import type { EmitterConfigStore } from "../emitters/config-store.js";
import type { Logger } from "../logger.js";
import type { SqlReadModel } from "../readmodel/readmodel.js";
import { listResources, readResource, type WikiResourceContext } from "./resources.js";
import { SessionTokenManager } from "./tokens.js";
import { wikiTools, type WikiTool, type WikiToolContext } from "./tools.js";

/** Server identity advertised in the MCP `initialize` handshake. */
const SERVER_INFO = { name: "wiki-mcp", version: "0.1.0" } as const;

/** What the MCP server needs to serve tools/resources. */
export interface McpServerDeps {
  readonly engine: EmbeddedEngine;
  readonly readModel: SqlReadModel;
  /** The engine's full-text search index backing the `search` tool. */
  readonly searchIndex: ISearchIndex;
  /** The runtime emitter config store backing the configure/list/removeEmitter tools. */
  readonly emitters?: EmitterConfigStore;
  readonly namespace: string;
  readonly logger: Logger;
  /**
   * Push the just-written workspace to the projection tailer: a local
   * commit does NOT fan out to its own handle's stream subscribers, so the host wires
   * this to `ProjectionService.notify` to project THIS process's writes promptly.
   */
  readonly onWrite?: (workspace: WorkspaceId) => void;
}

/** The transport to listen on. */
export type McpTransport =
  | { readonly kind: "stdio" }
  | { readonly kind: "http"; readonly host?: string; readonly port: number; readonly path?: string };

/**
 * The wiki MCP server: builds the protocol surface once and connects it to a chosen
 * transport. One {@link SessionTokenManager} is shared across sessions; the transport
 * supplies each request's session id.
 */
export class WikiMcpServer {
  private readonly tokens = new SessionTokenManager();
  private readonly toolsByName = new Map<string, WikiTool>();
  /** Live streamable-HTTP sessions, keyed by MCP session id — one transport + Server each. */
  private readonly sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();
  private httpServer: HttpServer | undefined;
  /** The stdio-mode Server, when started that way (a single ambient session). */
  private stdioServer: Server | undefined;

  constructor(private readonly deps: McpServerDeps) {
    for (const tool of wikiTools()) this.toolsByName.set(tool.name, tool);
  }

  /** Start the chosen transport. */
  async start(transport: McpTransport): Promise<void> {
    if (transport.kind === "stdio") {
      // stdio is one ambient session: a single Server bound to the process's stdio.
      this.stdioServer = this.buildServer();
      await this.stdioServer.connect(new StdioServerTransport());
      this.deps.logger.info("MCP server listening", { transport: "stdio" });
      return;
    }
    await this.startHttp(transport);
  }

  /** Stop every live session and the HTTP listener as a unit. */
  async stop(): Promise<void> {
    const live = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(live.flatMap((s) => [s.transport.close(), s.server.close()]));
    if (this.stdioServer !== undefined) {
      await this.stdioServer.close();
      this.stdioServer = undefined;
    }
    if (this.httpServer !== undefined) {
      await new Promise<void>((resolve) => this.httpServer?.close(() => resolve()));
      this.httpServer = undefined;
    }
  }

  /**
   * Build a fresh MCP {@link Server} with the full tool/resource handler surface
   * registered. Called once per session (stdio: once; HTTP: per `initialize`), so each
   * transport gets its own Server while they all SHARE this instance's engine, read
   * model, and {@link SessionTokenManager}. That sharing is the point: the token manager
   * keys read-your-writes by the transport-supplied `sessionId`, so
   * distinct sessions are independent yet read from the one read model.
   */
  private buildServer(): Server {
    const server = new Server(SERVER_INFO, {
      capabilities: { tools: {}, resources: {} },
      instructions:
        "A structured wiki. Discover workspaces (listWorkspaces), inspect a page's legal commands " +
        "(describeMutations / describePageType), then write (createPage / mutatePage / mutatePageBatch / " +
        "link / …) and read (getPage / tree / renderPage / search). Reads reflect your own prior writes. " +
        "SELF-DIRECTING: this wiki tells you what to do next — do not ask the user which step comes next, " +
        "the FSM already encodes it. Every write echoes a `next` summary, and nextActions(workspaceId, " +
        "pageId?) rolls a subtree up into do (agent edges — drive these yourself now), blocked (agent edges " +
        "whose unmet reason names the content to author first), humanGates (sign-off/decision edges), and " +
        "attention (items awaiting a human). Keep driving do/blocked to completion; STOP and defer to the " +
        "human ONLY for humanGates and attention items (use the `attention` tool to find them).",
    });
    this.registerHandlers(server);
    return server;
  }

  /**
   * After a successful write tool, push its workspace to the projection tailer
   * so SQL catches up promptly. The workspace is read from the tool's
   * echoed `token` (decoded) or its `workspaceId`.
   */
  private afterWrite(data: unknown): void {
    if (this.deps.onWrite === undefined) return;
    const d = data as { token?: unknown; workspaceId?: unknown } | undefined;
    let ws: string | undefined;
    if (typeof d?.token === "string") ws = decodeToken(d.token).workspaceId;
    else if (typeof d?.workspaceId === "string") ws = d.workspaceId;
    if (ws !== undefined) this.deps.onWrite(asWorkspaceId(ws));
  }

  // ── request handlers ──────────────────────────────────────────────────────────

  private registerHandlers(server: Server): void {
    // tools/list — advertise the engine's RAW JSON Schema per tool.
    server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => ({
      tools: [...this.toolsByName.values()].map((t) => ({
        name: t.name,
        description: t.description,
        // The engine's argsSchema is a JSON-Schema object; pass it verbatim.
        inputSchema: t.inputSchema as ListToolsResult["tools"][number]["inputSchema"],
        annotations: { readOnlyHint: !t.write },
      })),
    }));

    // tools/call — run the tool; map engine errors to a structured tool error.
    server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
      const tool = this.toolsByName.get(request.params.name);
      if (tool === undefined) {
        return errorResult(`Unknown tool: ${request.params.name}`);
      }
      const ctx: WikiToolContext = {
        engine: this.deps.engine,
        readModel: this.deps.readModel,
        searchIndex: this.deps.searchIndex,
        ...(this.deps.emitters !== undefined ? { emitters: this.deps.emitters } : {}),
        tokens: this.tokens,
        sessionId: extra.sessionId,
      };
      try {
        const result = await tool.handle(request.params.arguments ?? {}, ctx);
        if (tool.write) this.afterWrite(result.data);
        return successResult(result.text, result.data);
      } catch (err) {
        return this.toToolError(err, tool.name);
      }
    });

    // resources/list — one entry per workspace (rendered tree).
    server.setRequestHandler(ListResourcesRequestSchema, async (_request, extra): Promise<ListResourcesResult> => {
      const entries = await listResources(this.resourceCtx(extra.sessionId));
      return { resources: entries.map((e) => ({ uri: e.uri, name: e.name, description: e.description, mimeType: e.mimeType })) };
    });

    // resources/read — render a wiki:// URI to Markdown.
    server.setRequestHandler(ReadResourceRequestSchema, async (request, extra): Promise<ReadResourceResult> => {
      const contents = await readResource(request.params.uri, this.resourceCtx(extra.sessionId));
      return { contents: [{ uri: contents.uri, mimeType: contents.mimeType, text: contents.text }] };
    });
  }

  private resourceCtx(sessionId: string | undefined): WikiResourceContext {
    return {
      engine: this.deps.engine,
      readModel: this.deps.readModel,
      tokens: this.tokens,
      sessionId,
      namespace: this.deps.namespace,
    };
  }

  /**
   * Map an engine error onto a structured tool error. A
   * {@link WikiError} (validation / not-allowed / consistency-timeout) carries a
   * stable `code` the agent self-corrects on; anything else is an internal error.
   */
  private toToolError(err: unknown, toolName: string): CallToolResult {
    if (err instanceof WikiError) {
      this.deps.logger.warn("tool rejected by engine", { tool: toolName, code: err.code });
      return errorResult(`[${err.code}] ${err.message}`, { code: err.code });
    }
    const message = err instanceof Error ? err.message : String(err);
    this.deps.logger.error("tool failed", { tool: toolName, error: message });
    return errorResult(`Internal error running ${toolName}: ${message}`);
  }

  // ── streamable HTTP transport ─────────────────────────────────────────────────

  /**
   * Serve over streamable HTTP with **per-session** transports. The MCP
   * streamable-HTTP protocol is multi-session: a POST with no `Mcp-Session-Id` that is
   * an `initialize` opens a NEW session (a fresh transport + Server, recorded under the
   * session id the transport mints); every later request carries that id and routes to
   * its transport; a DELETE (or transport close) tears it down. So concurrent clients
   * each get an independent session, and one client's ungraceful disconnect can never
   * wedge another's — the previous single-transport wiring rejected any second
   * `initialize` with "Server already initialized".
   */
  private async startHttp(transport: Extract<McpTransport, { kind: "http" }>): Promise<void> {
    const path = transport.path ?? "/mcp";
    const host = transport.host ?? "127.0.0.1";

    const httpServer = createServer((req, res) => {
      void this.handleHttp(req, res, path).catch((err: unknown) => {
        this.deps.logger.error("MCP HTTP request failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end("Internal Server Error");
        }
      });
    });
    await new Promise<void>((resolve) => httpServer.listen(transport.port, host, resolve));
    this.httpServer = httpServer;
    this.deps.logger.info("MCP server listening", { transport: "http", host, port: transport.port, path });
  }

  /**
   * Open a fresh streamable-HTTP session: a Server bound to its own transport, recorded
   * in {@link sessions} by the session id the transport mints on `initialize`. A DELETE
   * (`onsessionclosed`) or any transport close evicts it and drops its token high-water
   * marks. Returns the transport so the caller can hand it the `initialize` request.
   */
  private async openSession(): Promise<StreamableHTTPServerTransport> {
    const server = this.buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId: string) => {
        this.sessions.set(sessionId, { server, transport });
        this.deps.logger.info("MCP session opened", { sessionId });
      },
      onsessionclosed: (sessionId: string) => this.removeSession(sessionId),
    });
    transport.onclose = () => {
      if (transport.sessionId !== undefined) this.removeSession(transport.sessionId);
    };
    await server.connect(transport);
    return transport;
  }

  /** Evict a session and forget its per-session token high-water marks (idempotent). */
  private removeSession(sessionId: string): void {
    if (this.sessions.delete(sessionId)) {
      this.tokens.forget(sessionId);
      this.deps.logger.info("MCP session closed", { sessionId });
    }
  }

  /**
   * Route one HTTP request to the right session transport. POST is the
   * JSON-RPC channel; GET opens the SSE stream and DELETE terminates a session — both
   * require an existing session id. We parse the POST body ourselves (to detect
   * `initialize` and pick the session) and pass the parsed body to the transport, which
   * then does the MCP framing.
   */
  private async handleHttp(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if ((req.url ?? "").split("?")[0] !== path) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }
    const sessionId = headerValue(req.headers["mcp-session-id"]);
    const method = req.method ?? "GET";

    // GET (SSE) / DELETE (terminate) act on an existing session and carry no body.
    if (method === "GET" || method === "DELETE") {
      const session = sessionId !== undefined ? this.sessions.get(sessionId) : undefined;
      if (session === undefined) {
        sendRpcError(res, 400, -32000, "Missing or unknown Mcp-Session-Id");
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }

    if (method !== "POST") {
      res.statusCode = 405;
      res.end("Method Not Allowed");
      return;
    }

    // POST: we consume the stream to read the body, so we MUST hand it to the transport.
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendRpcError(res, 400, -32700, "Parse error: request body is not valid JSON");
      return;
    }

    if (sessionId !== undefined) {
      const session = this.sessions.get(sessionId);
      if (session === undefined) {
        sendRpcError(res, 404, -32001, "Unknown session — send an initialize request to start a new one");
        return;
      }
      await session.transport.handleRequest(req, res, body);
      return;
    }

    // No session id → only an `initialize` may open a fresh session.
    if (!isInitializeRequest(body)) {
      sendRpcError(res, 400, -32000, "Bad Request: no Mcp-Session-Id and not an initialize request");
      return;
    }
    const transport = await this.openSession();
    await transport.handleRequest(req, res, body);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// CallToolResult helpers
// ────────────────────────────────────────────────────────────────────────────

/** A successful tool result: a text block, plus a JSON block when `data` is present. */
function successResult(text: string, data: unknown): CallToolResult {
  const content: CallToolResult["content"] = [{ type: "text", text }];
  if (data !== undefined) {
    content.push({ type: "text", text: JSON.stringify(data, null, 2) });
  }
  return { content };
}

/** A structured tool error (`isError: true`) the agent can read and retry. */
function errorResult(text: string, data?: unknown): CallToolResult {
  const content: CallToolResult["content"] = [{ type: "text", text }];
  if (data !== undefined) content.push({ type: "text", text: JSON.stringify(data, null, 2) });
  return { content, isError: true };
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP helpers (per-session routing)
// ────────────────────────────────────────────────────────────────────────────

/** First value of a (possibly repeated) HTTP header. */
function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Read a request stream fully and JSON-parse it (`undefined` for an empty body). */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length === 0 ? undefined : JSON.parse(raw);
}

/** Send a JSON-RPC error envelope with an HTTP status (clients re-initialize on these). */
function sendRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}
