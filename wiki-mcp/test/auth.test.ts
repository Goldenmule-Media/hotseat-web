/**
 * Host-injected auth seam (`createWikiMcp({ auth })`): the MCP HTTP transport 401s
 * unauthenticated requests; workspace-scoped tools are gated generically on their
 * `workspaceId` arg (member level by default, owner level for workspace admin);
 * `createWorkspace` attributes ownership; `listWorkspaces` and resource listing
 * filter to accessible workspaces. The McpAuth here is an in-memory fake — the
 * mechanism (GitHub, tokens) is the HOST's concern and is tested in wiki-server.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { arg, definePageType, t, z, zodSchema } from "wiki";
import { DurableStreamTestServer } from "@durable-streams/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createWikiMcp, silentLogger, type McpAuth, type WikiMcp } from "../src/main.js";

const Note = definePageType({
  type: "note",
  version: 1,
  initialStatus: "draft",
  statusTransitions: [t("draft", "publish", "published")],
  sections: {
    body: { name: "Body", required: true, mutableIn: ["draft"], fields: { text: { kind: "prose" } } },
  },
  commands: {
    setBody: { args: zodSchema(z.object({ text: z.string() })), target: { section: "body", field: "text" }, set: { text: arg("text") } },
  },
  render: { sections: [{ section: "body", heading: "Body", field: "text", as: "block" }] },
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

/** Connect an MCP client carrying a bearer token on every request. */
async function connectAs(url: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

describe("wiki-mcp auth seam", () => {
  let streamServer: DurableStreamTestServer;
  let mcp: WikiMcp;
  let url: string;

  /** First-wins owner ledger the fake McpAuth maintains (what wiki-server's store does). */
  const owners = new Map<string, string>();
  const members = new Map<string, Set<string>>();

  const fakeAuth: McpAuth = {
    authenticate(headers) {
      const raw = headers.authorization;
      const value = Array.isArray(raw) ? raw[0] : raw;
      if (value === "Bearer alice-token") return { login: "alice" };
      if (value === "Bearer bob-token") return { login: "bob" };
      return undefined;
    },
    // Unclaimed workspaces are open to any authenticated user (the host's orphan policy).
    canAccess: (user, ws) =>
      !owners.has(ws) || owners.get(ws) === user.login || members.get(ws)?.has(user.login) === true,
    canAdmin: (user, ws) => owners.get(ws) === user.login,
    onWorkspaceCreated: (user, ws) => {
      if (!owners.has(ws)) owners.set(ws, user.login);
    },
  };

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
      auth: fakeAuth,
    });
  });

  afterAll(async () => {
    await mcp?.close();
    await streamServer?.stop();
  });

  it("401s a client with no/invalid bearer token", async () => {
    const bare = new Client({ name: "anon", version: "1.0.0" });
    await expect(bare.connect(new StreamableHTTPClientTransport(new URL(url)))).rejects.toThrow(/Unauthenticated/);

    const wrong = new Client({ name: "anon", version: "1.0.0" });
    const t2 = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: "Bearer nope" } },
    });
    await expect(wrong.connect(t2)).rejects.toThrow(/Unauthenticated/);
  });

  it("attributes ownership on createWorkspace and enforces member/owner gates", async () => {
    const alice = await connectAs(url, "alice-token");
    const bob = await connectAs(url, "bob-token");
    try {
      // Alice creates a workspace → she is recorded as its owner.
      const created = dataOf(await alice.callTool({ name: "createWorkspace", arguments: { name: "alice-space" } }));
      const ws = created?.workspaceId as string;
      expect(ws).toBeDefined();
      expect(owners.get(ws)).toBe("alice");

      // Bob (not a member) is denied a member-level workspace-scoped tool…
      const denied = await bob.callTool({ name: "tree", arguments: { workspaceId: ws } });
      expect(denied.isError).toBe(true);
      expect(textOf(denied)).toContain("ACCESS_DENIED");

      // …and the owner-level archive, while Alice may archive (owner).
      const deniedAdmin = await bob.callTool({ name: "archiveWorkspace", arguments: { workspaceId: ws } });
      expect(deniedAdmin.isError).toBe(true);
      expect(textOf(deniedAdmin)).toContain("ACCESS_DENIED");

      // Membership opens member-level access but NOT owner-level administration.
      members.set(ws, new Set(["bob"]));
      const allowed = await bob.callTool({ name: "tree", arguments: { workspaceId: ws } });
      expect(allowed.isError ?? false).toBe(false);
      const stillDeniedAdmin = await bob.callTool({ name: "archiveWorkspace", arguments: { workspaceId: ws } });
      expect(stillDeniedAdmin.isError).toBe(true);

      const archived = await alice.callTool({ name: "archiveWorkspace", arguments: { workspaceId: ws } });
      expect(archived.isError ?? false).toBe(false);
    } finally {
      await alice.close();
      await bob.close();
    }
  });

  it("filters listWorkspaces to the caller's accessible workspaces", async () => {
    const alice = await connectAs(url, "alice-token");
    const bob = await connectAs(url, "bob-token");
    try {
      const created = dataOf(await alice.callTool({ name: "createWorkspace", arguments: { name: "alice-only" } }));
      const ws = created?.workspaceId as string;
      expect(owners.get(ws)).toBe("alice");

      const aliceSees = textOf(await alice.callTool({ name: "listWorkspaces", arguments: {} }));
      expect(aliceSees).toContain("alice-only");

      const bobSees = textOf(await bob.callTool({ name: "listWorkspaces", arguments: {} }));
      expect(bobSees).not.toContain("alice-only");
    } finally {
      await alice.close();
      await bob.close();
    }
  });
});

describe("wiki-mcp auth discovery (host-injected, RFC 9728)", () => {
  let streamServer: DurableStreamTestServer;
  let mcp: WikiMcp;
  let base: string;

  const RESOURCE_METADATA_URL = "https://gateway.example/.well-known/oauth-protected-resource";
  const DOCUMENT = { resource: "http://127.0.0.1/mcp", authorization_servers: ["https://gateway.example"] };

  beforeAll(async () => {
    streamServer = new DurableStreamTestServer({ port: 0 });
    const streamBaseUrl = await streamServer.start();
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    mcp = await createWikiMcp({
      config: { namespace: "test", streamBaseUrl, db: { kind: "pglite" }, readConsistencyTimeoutMs: 2000, waitForPollMs: 5 },
      pageTypes: [Note],
      transport: {
        kind: "http",
        host: "127.0.0.1",
        port,
        authDiscovery: { resourceMetadataUrl: RESOURCE_METADATA_URL, protectedResourceDocument: DOCUMENT },
      },
      logger: silentLogger,
      auth: { authenticate: () => undefined, canAccess: () => false, canAdmin: () => false, onWorkspaceCreated: () => {} },
    });
  });

  afterAll(async () => {
    await mcp?.close();
    await streamServer?.stop();
  });

  it("the 401 advertises resource_metadata so an MCP client can bootstrap its login", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer realm="wiki-mcp", resource_metadata="${RESOURCE_METADATA_URL}"`,
    );
  });

  it("serves the host-authored protected-resource document on its own origin", async () => {
    const res = await fetch(`${base}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual(DOCUMENT);
  });
});
