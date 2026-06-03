/**
 * Streamable-HTTP MCP transport: CONCURRENT SESSIONS (DESIGN §6.1).
 *
 * Regression test for the single-session wiring bug: `startHttp` used to connect ONE
 * `StreamableHTTPServerTransport` once, so the first client to `initialize` claimed the
 * server and every later `initialize` was rejected with "Server already initialized" —
 * and an ungraceful disconnect could wedge it until restart. The fix gives each client
 * its own transport + Server keyed by `Mcp-Session-Id`, sharing one read model + token
 * manager.
 *
 * Boots the REAL stack over HTTP via `createWikiMcp` (in-memory Durable Streams + PGlite)
 * and drives it with the actual MCP SDK client. Asserts two clients connect concurrently
 * with distinct sessions, each reads its own writes, and a reconnect gets a fresh session.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { definePageType, t, z, zodSchema } from "wiki";
import { DurableStreamTestServer } from "@durable-streams/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createWikiMcp, silentLogger, type WikiMcp } from "../src/main.js";

// Minimal page type so the engine has a registered schema (createWorkspace itself
// needs none, but this keeps the instance realistic).
const Note = definePageType<{ body?: string }>({
  type: "note",
  initialStatus: "draft",
  initialFields: {},
  version: 1,
  items: {},
  statusTransitions: [t("draft", "setBody", "draft")],
  commands: {
    setBody: {
      args: zodSchema(z.object({ text: z.string() })),
      transition: { level: "page", event: "setBody" },
      produces: (_p, a) => ({ events: [{ type: "BodySet", payload: { text: a.text } }], result: undefined }),
    },
  },
  apply: (page, event) => {
    if (event.type === "BodySet") page.fields.body = (event.payload as { text: string }).text;
    return page;
  },
  render: (page) => `# ${page.title}\n\n${page.fields.body ?? ""}`,
});

/** Reserve an OS-assigned port, then release it for the MCP server to bind. */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

/** The text content blocks of a tool result (`callTool` returns a union, so narrow). */
function textBlocks(result: unknown): Array<{ type: string; text?: string }> {
  const content = (result as { content?: unknown }).content;
  return Array.isArray(content) ? (content as Array<{ type: string; text?: string }>) : [];
}

/** Pull the first JSON-parseable text block out of a tool result. */
function dataOf(result: unknown): Record<string, unknown> | undefined {
  for (const block of textBlocks(result)) {
    if (block.type === "text" && block.text !== undefined) {
      try {
        return JSON.parse(block.text) as Record<string, unknown>;
      } catch {
        /* not the JSON block */
      }
    }
  }
  return undefined;
}

/** First content block's text (the human-readable summary). */
function textOf(result: unknown): string {
  return textBlocks(result).find((b) => b.type === "text")?.text ?? "";
}

async function connect(url: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

describe("streamable HTTP MCP: concurrent sessions", () => {
  let streamServer: DurableStreamTestServer;
  let mcp: WikiMcp;
  let url: string;

  beforeAll(async () => {
    streamServer = new DurableStreamTestServer({ port: 0 });
    const streamBaseUrl = await streamServer.start();
    const port = await freePort();
    url = `http://127.0.0.1:${port}/mcp`;
    mcp = await createWikiMcp({
      config: {
        namespace: "test",
        streamBaseUrl,
        db: { kind: "pglite" },
        readConsistencyTimeoutMs: 2000,
        waitForPollMs: 5,
      },
      pageTypes: [Note],
      transport: { kind: "http", host: "127.0.0.1", port },
      logger: silentLogger,
    });
  });

  afterAll(async () => {
    await mcp?.close();
    await streamServer?.stop();
  });

  it("two clients connect concurrently with distinct sessions (was: 'Server already initialized')", async () => {
    const a = await connect(url);
    const b = await connect(url); // the old single-transport wiring rejected this second initialize
    try {
      expect(a.transport.sessionId).toBeDefined();
      expect(b.transport.sessionId).toBeDefined();
      expect(a.transport.sessionId).not.toBe(b.transport.sessionId);

      // Both sessions see the full tool catalog.
      const toolsA = await a.client.listTools();
      expect(toolsA.tools.map((tool) => tool.name)).toContain("createWorkspace");

      // Each session reads its OWN writes (per-session token threading over the real transport).
      const createdA = dataOf(await a.client.callTool({ name: "createWorkspace", arguments: { name: "from-A" } }));
      expect(createdA?.workspaceId).toBeDefined();
      expect(textOf(await a.client.callTool({ name: "listWorkspaces", arguments: {} }))).toContain("from-A");

      const createdB = dataOf(await b.client.callTool({ name: "createWorkspace", arguments: { name: "from-B" } }));
      expect(createdB?.workspaceId).toBeDefined();
      expect(textOf(await b.client.callTool({ name: "listWorkspaces", arguments: {} }))).toContain("from-B");
    } finally {
      await a.client.close();
      await b.client.close();
    }
  });

  it("a reconnecting client gets a fresh session — a prior disconnect cannot wedge the server", async () => {
    const first = await connect(url);
    const firstSession = first.transport.sessionId;
    await first.client.close();

    const second = await connect(url);
    try {
      expect(second.transport.sessionId).toBeDefined();
      expect(second.transport.sessionId).not.toBe(firstSession);
      expect((await second.client.listTools()).tools.length).toBeGreaterThan(0);
    } finally {
      await second.client.close();
    }
  });
});
