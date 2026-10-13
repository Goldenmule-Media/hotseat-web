/**
 * Cross-workspace references through the MCP surface: every named workspace is access-gated,
 * the target is confirmed in the read model, and the host stamps the title snapshot the
 * engine renders with.
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
  render: {
    sections: [
      { section: "body", heading: "Body", field: "text", as: "block" },
      { section: "@references", heading: "References" },
    ],
  },
});

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

function textBlocks(result: unknown): Array<{ type: string; text?: string }> {
  const content = (result as { content?: unknown }).content;
  return Array.isArray(content) ? (content as Array<{ type: string; text?: string }>) : [];
}

function dataOf(result: unknown): Record<string, unknown> {
  for (const block of textBlocks(result)) {
    if (block.type === "text" && block.text !== undefined) {
      try {
        return JSON.parse(block.text) as Record<string, unknown>;
      } catch {
        /* not the JSON block */
      }
    }
  }
  return {};
}

const textOf = (result: unknown): string => textBlocks(result).find((b) => b.type === "text")?.text ?? "";

async function connectAs(url: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

describe("cross-workspace links over MCP", () => {
  let streamServer: DurableStreamTestServer;
  let mcp: WikiMcp;
  let alice: Client;
  let bob: Client;
  const owners = new Map<string, string>();

  const fakeAuth: McpAuth = {
    authenticate(headers) {
      const raw = headers.authorization;
      const value = Array.isArray(raw) ? raw[0] : raw;
      if (value === "Bearer alice-token") return { login: "alice" };
      if (value === "Bearer bob-token") return { login: "bob" };
      return undefined;
    },
    canAccess: (user, ws) => owners.get(ws) === user.login,
    canAdmin: (user, ws) => owners.get(ws) === user.login,
    onWorkspaceCreated: (user, ws) => {
      if (!owners.has(ws)) owners.set(ws, user.login);
    },
  };

  let here: string;
  let there: string;
  let bobs: string;
  let source: string;
  let target: string;
  let bobPage: string;

  const call = async (client: Client, name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });

  const createWs = async (client: Client, name: string): Promise<string> =>
    dataOf(await call(client, "createWorkspace", { name })).workspaceId as string;

  const createNote = async (client: Client, workspaceId: string, title: string): Promise<string> =>
    dataOf(await call(client, "createPage", { workspaceId, type: "note", title, parentId: null })).pageId as string;

  beforeAll(async () => {
    streamServer = new DurableStreamTestServer({ port: 0 });
    const streamBaseUrl = await streamServer.start();
    const port = await freePort();
    mcp = await createWikiMcp({
      config: { namespace: "test", streamBaseUrl, db: { kind: "pglite" }, readConsistencyTimeoutMs: 2000, waitForPollMs: 5 },
      pageTypes: [Note],
      transport: { kind: "http", host: "127.0.0.1", port },
      logger: silentLogger,
      auth: fakeAuth,
    });
    const url = `http://127.0.0.1:${port}/mcp`;
    alice = await connectAs(url, "alice-token");
    bob = await connectAs(url, "bob-token");
    here = await createWs(alice, "Here");
    there = await createWs(alice, "There");
    bobs = await createWs(bob, "Bob's");
    source = await createNote(alice, here, "Source");
    target = await createNote(alice, there, "Target");
    bobPage = await createNote(bob, bobs, "Private");
  });

  afterAll(async () => {
    await alice?.close();
    await bob?.close();
    await mcp?.close();
    await streamServer?.stop();
  });

  it("links across workspaces with the target's current title", async () => {
    const res = await call(alice, "link", { workspaceId: here, from: source, to: target, role: "uses", toWorkspaceId: there });
    expect(res.isError ?? false).toBe(false);
    expect(dataOf(res).title).toBe("Target");
    const md = textOf(await call(alice, "renderPage", { workspaceId: here, pageId: source }));
    expect(md).toContain(`- uses → [Target](wiki://${there}/${target})`);
  });

  it("re-linking refreshes a stale snapshot", async () => {
    await call(alice, "setPageTitle", { workspaceId: there, pageId: target, title: "Target v2" });
    await call(alice, "link", { workspaceId: here, from: source, to: target, role: "uses", toWorkspaceId: there });
    const md = textOf(await call(alice, "renderPage", { workspaceId: here, pageId: source }));
    expect(md).toContain(`[Target v2](wiki://${there}/${target})`);
    expect(md).not.toContain("[Target](");
  });

  it("denies a link into a workspace the caller can't access", async () => {
    const res = await call(alice, "link", { workspaceId: here, from: source, to: bobPage, role: "uses", toWorkspaceId: bobs });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("ACCESS_DENIED");
  });

  it("rejects a target that doesn't exist", async () => {
    const res = await call(alice, "link", {
      workspaceId: here,
      from: source,
      to: "note:missing",
      role: "uses",
      toWorkspaceId: there,
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("LINK_TARGET_NOT_FOUND");
  });

  it("treats toWorkspaceId equal to workspaceId as a local link", async () => {
    const local = await createNote(alice, here, "Local");
    const res = await call(alice, "link", { workspaceId: here, from: source, to: local, role: "sees", toWorkspaceId: here });
    expect(res.isError ?? false).toBe(false);
    const md = textOf(await call(alice, "renderPage", { workspaceId: here, pageId: source }));
    expect(md).toContain(`- sees → [Local](${local})`);
  });

  it("backlinks lists inbound edges from every workspace the caller can access", async () => {
    const res = await call(alice, "backlinks", { workspaceId: there, pageId: target });
    expect(dataOf(res)).toEqual([{ workspace_id: here, from_id: source, role: "uses", from_title: "Source" }]);
    expect(textOf(res)).toContain(`Source (${source}) in ${here} —uses→`);
  });

  it("backlinks hides a source workspace the caller can't access", async () => {
    const shared = await createWs(alice, "Shared");
    const sharedPage = await createNote(alice, shared, "Shared page");
    await call(alice, "link", { workspaceId: here, from: source, to: sharedPage, role: "cites", toWorkspaceId: shared });
    expect(dataOf(await call(alice, "backlinks", { workspaceId: shared, pageId: sharedPage }))).toHaveLength(1);
    owners.set(here, "carol");
    try {
      expect(dataOf(await call(alice, "backlinks", { workspaceId: shared, pageId: sharedPage }))).toEqual([]);
    } finally {
      owners.set(here, "alice");
    }
  });

  it("unlinks a cross-workspace edge", async () => {
    const res = await call(alice, "unlink", { workspaceId: here, from: source, to: target, role: "uses", toWorkspaceId: there });
    expect(res.isError ?? false).toBe(false);
    const md = textOf(await call(alice, "renderPage", { workspaceId: here, pageId: source }));
    expect(md).not.toContain(`wiki://${there}/`);
  });
});
