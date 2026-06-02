/**
 * The MCP server (DESIGN §6) — exposes the engine command catalog + read queries as
 * MCP tools and `wiki://` resources, plugging the two CQRS planes together with the
 * per-session token manager (DESIGN §6.2).
 *
 * Built on the SDK's LOW-LEVEL {@link Server} (not the high-level `McpServer`),
 * because our tool input schemas are the engine's RAW JSON Schema (from
 * `argsSchema` / `describeMutations`), and `McpServer.registerTool` wants Zod —
 * which we don't have. The low-level `Server.setRequestHandler` also exposes
 * `extra.sessionId`, the key the token manager threads read-your-writes on
 * (DESIGN §6.2). The engine validates a write's `args` itself and rejects illegal
 * calls with structured errors the agent self-corrects on (DESIGN §6.1) — those map
 * to a tool result with `isError: true`.
 *
 * Transports: **stdio** for a local agent (one ambient session), and
 * **streamable HTTP** for a networked / `wiki-server`-embedded deployment
 * (per-request session ids, DESIGN §6.1). The stream client / DB live elsewhere; this
 * module only wires the protocol surface.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type ListResourcesResult,
  type ListToolsResult,
  type ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import { WikiError } from "wiki";

import type { EmbeddedEngine } from "../engine.js";
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
  readonly namespace: string;
  readonly logger: Logger;
}

/** The transport to listen on (DESIGN §6.1). */
export type McpTransport =
  | { readonly kind: "stdio" }
  | { readonly kind: "http"; readonly host?: string; readonly port: number; readonly path?: string };

/**
 * The wiki MCP server: builds the protocol surface once and connects it to a chosen
 * transport. One {@link SessionTokenManager} is shared across sessions; the transport
 * supplies each request's session id (DESIGN §6.2).
 */
export class WikiMcpServer {
  private readonly tokens = new SessionTokenManager();
  private readonly toolsByName = new Map<string, WikiTool>();
  private readonly server: Server;
  private httpServer: HttpServer | undefined;
  private httpTransport: StreamableHTTPServerTransport | undefined;

  constructor(private readonly deps: McpServerDeps) {
    for (const tool of wikiTools()) this.toolsByName.set(tool.name, tool);
    this.server = new Server(SERVER_INFO, {
      capabilities: { tools: {}, resources: {} },
      instructions:
        "A structured wiki. Discover workspaces (listWorkspaces), inspect a page's legal " +
        "commands (describeMutations), then write (createPage / mutatePage / link / …) and " +
        "read (getPage / tree / renderPage / search). Reads reflect your own prior writes.",
    });
    this.registerHandlers();
  }

  /** Start the chosen transport (DESIGN §6.1). */
  async start(transport: McpTransport): Promise<void> {
    if (transport.kind === "stdio") {
      await this.server.connect(new StdioServerTransport());
      this.deps.logger.info("MCP server listening", { transport: "stdio" });
      return;
    }
    await this.startHttp(transport);
  }

  /** Stop the server + any HTTP listener. */
  async stop(): Promise<void> {
    await this.server.close();
    if (this.httpTransport !== undefined) await this.httpTransport.close();
    if (this.httpServer !== undefined) {
      await new Promise<void>((resolve) => this.httpServer?.close(() => resolve()));
      this.httpServer = undefined;
    }
  }

  // ── request handlers ──────────────────────────────────────────────────────────

  private registerHandlers(): void {
    // tools/list — advertise the engine's RAW JSON Schema per tool.
    this.server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => ({
      tools: [...this.toolsByName.values()].map((t) => ({
        name: t.name,
        description: t.description,
        // The engine's argsSchema is a JSON-Schema object; pass it verbatim.
        inputSchema: t.inputSchema as ListToolsResult["tools"][number]["inputSchema"],
        annotations: { readOnlyHint: !t.write },
      })),
    }));

    // tools/call — run the tool; map engine errors to a structured tool error.
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
      const tool = this.toolsByName.get(request.params.name);
      if (tool === undefined) {
        return errorResult(`Unknown tool: ${request.params.name}`);
      }
      const ctx: WikiToolContext = {
        engine: this.deps.engine,
        readModel: this.deps.readModel,
        tokens: this.tokens,
        sessionId: extra.sessionId,
      };
      try {
        const result = await tool.handle(request.params.arguments ?? {}, ctx);
        return successResult(result.text, result.data);
      } catch (err) {
        return this.toToolError(err, tool.name);
      }
    });

    // resources/list — one entry per workspace (rendered tree).
    this.server.setRequestHandler(ListResourcesRequestSchema, async (_request, extra): Promise<ListResourcesResult> => {
      const entries = await listResources(this.resourceCtx(extra.sessionId));
      return { resources: entries.map((e) => ({ uri: e.uri, name: e.name, description: e.description, mimeType: e.mimeType })) };
    });

    // resources/read — render a wiki:// URI to Markdown.
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request, extra): Promise<ReadResourceResult> => {
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
   * Map an engine error onto a structured tool error (DESIGN §6.1/§9). A
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
   * Serve over streamable HTTP (DESIGN §6.1). One stateful transport (session ids
   * from `randomUUID`) handles every request at `path` (default `/mcp`). This is the
   * networked / `wiki-server`-embedded path; the engine reads localhost streams
   * regardless (DESIGN §8).
   */
  private async startHttp(transport: Extract<McpTransport, { kind: "http" }>): Promise<void> {
    const path = transport.path ?? "/mcp";
    const host = transport.host ?? "127.0.0.1";
    const httpTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessionclosed: (sessionId: string) => this.tokens.forget(sessionId),
    });
    await this.server.connect(httpTransport);
    this.httpTransport = httpTransport;

    const httpServer = createServer((req, res) => {
      if (req.url?.split("?")[0] !== path) {
        res.statusCode = 404;
        res.end("Not Found");
        return;
      }
      // The transport reads the body itself (it implements MCP framing).
      void httpTransport.handleRequest(req, res).catch((err: unknown) => {
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
