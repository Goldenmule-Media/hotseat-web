/**
 * Cross-workspace page moves through the MCP host: the read model projects forwards and
 * pending moves, a moved page answers PAGE_MOVED with its new home, and a cross-workspace
 * reference to a moved page follows it there.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { arg, definePageType, t, z, zodSchema, type PageId, type WorkspaceId } from "wiki";
import { movePages } from "wiki/admin";
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
    rel: { name: "Related", required: true, mutableIn: ["draft"], fields: { see: { kind: "ref" } } },
  },
  commands: {
    setBody: { args: zodSchema(z.object({ text: z.string() })), target: { section: "body", field: "text" }, set: { text: arg("text") } },
    setSee: { args: zodSchema(z.object({ see: z.any() })), target: { section: "rel", field: "see" }, set: { see: arg("see") } },
  },
  render: {
    sections: [
      { section: "body", heading: "Body", field: "text", as: "block" },
      { section: "rel", heading: "Related", field: "see", as: "inline" },
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

function blocks(result: unknown): Array<{ type: string; text?: string }> {
  const content = (result as { content?: unknown }).content;
  return Array.isArray(content) ? (content as Array<{ type: string; text?: string }>) : [];
}

function dataOf(result: unknown): Record<string, unknown> {
  for (const block of blocks(result)) {
    if (block.type !== "text" || block.text === undefined) continue;
    try {
      return JSON.parse(block.text) as Record<string, unknown>;
    } catch {
      /* not the JSON block */
    }
  }
  return {};
}

const textOf = (result: unknown): string => blocks(result).find((b) => b.type === "text")?.text ?? "";

async function connectAs(url: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

describe("page moves over MCP", () => {
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

  let src: string;
  let dst: string;
  let far: string;
  let kit: string;
  let usage: string;
  let stay: string;
  let farPage: string;

  const call = async (client: Client, name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const createWs = async (client: Client, name: string): Promise<string> =>
    dataOf(await call(client, "createWorkspace", { name })).workspaceId as string;
  const createNote = async (client: Client, workspaceId: string, title: string, parentId: string | null = null): Promise<string> =>
    dataOf(await call(client, "createPage", { workspaceId, type: "note", title, parentId })).pageId as string;
  const open = (id: WorkspaceId) => mcp.engine.open(id);

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
    src = await createWs(alice, "Godot Addons");
    dst = await createWs(alice, "Sovereign Axe");
    far = await createWs(alice, "Elsewhere");
    kit = await createNote(alice, src, "Kit");
    usage = await createNote(alice, src, "Usage", kit);
    stay = await createNote(alice, src, "Stay");
    farPage = await createNote(alice, far, "Far");
    await call(alice, "mutatePage", { workspaceId: src, pageId: stay, command: "setSee", args: { see: { kind: "ref", target: { kind: "page", id: kit } } } });

    await movePages({ open, from: src as WorkspaceId, to: dst as WorkspaceId, pageIds: [kit as PageId], parentId: null });
    await mcp.drainOnce();
  });

  afterAll(async () => {
    await alice?.close();
    await bob?.close();
    await mcp?.close();
    await streamServer?.stop();
  });

  it("projects forwards, and pending moves while one is under way", async () => {
    expect(await mcp.readModel.forwardOf(src as WorkspaceId, usage)).toMatchObject({ to_workspace_id: dst, title: "Usage" });
    expect(await mcp.readModel.getPage(dst as WorkspaceId, usage)).toMatchObject({ title: "Usage", parent_id: kit });
    expect(await mcp.readModel.pendingMoves()).toEqual([]);

    const handle = await open(src as WorkspaceId);
    const { value: move } = await handle.beginPageMove({ to: far as WorkspaceId, roots: [stay as PageId], toParentId: null });
    await mcp.drainOnce();
    expect(await mcp.readModel.pendingMoves()).toEqual([
      { workspace_id: src, move_id: move.moveId, to_workspace_id: far, page_ids: [stay] },
    ]);
    await handle.abortPageMove(move.moveId, "test");
    await mcp.drainOnce();
    expect(await mcp.readModel.pendingMoves()).toEqual([]);
  });

  it("a moved page answers PAGE_MOVED with where it lives now", async () => {
    for (const tool of ["getPage", "renderPage"]) {
      const res = await call(alice, tool, { workspaceId: src, pageId: usage });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("[PAGE_MOVED]");
      expect(dataOf(res)).toEqual({ code: "PAGE_MOVED", workspaceId: dst, pageId: usage });
    }
  });

  it("a cross-workspace link or ref to a moved page follows it to its new home", async () => {
    const linked = await call(alice, "link", { workspaceId: far, from: farPage, to: usage, role: "uses", toWorkspaceId: src });
    expect(linked.isError ?? false).toBe(false);
    expect(dataOf(linked).workspaceId).toBe(dst);
    const ref = await call(alice, "mutatePage", {
      workspaceId: far,
      pageId: farPage,
      command: "setSee",
      args: { see: { kind: "ref", target: { kind: "page", id: kit, workspace: src } } },
    });
    expect(ref.isError ?? false).toBe(false);
    const md = textOf(await call(alice, "renderPage", { workspaceId: far, pageId: farPage }));
    expect(md).toContain(`uses → [Usage](wiki://${dst}/${usage})`);
    expect(md).toContain(`[Kit](wiki://${dst}/${kit})`);
  });

  it("movePages: a dry run reports the plan and writes nothing", async () => {
    const page = await createNote(alice, src, "Dry");
    const before = (await mcp.readModel.events(src as WorkspaceId)).length;
    const res = await call(alice, "movePages", { workspaceId: src, pageIds: [page], toWorkspaceId: dst, parentId: null, dryRun: true });
    expect(res.isError ?? false).toBe(false);
    expect(textOf(res)).toContain("Dry run: would move 1 page(s)");
    expect(dataOf(res)).toMatchObject({ dryRun: true, movedPageIds: [page] });
    await mcp.drainOnce();
    expect((await mcp.readModel.events(src as WorkspaceId)).length).toBe(before);
  });

  it("movePages moves a subtree and reports where each page went", async () => {
    const top = await createNote(alice, src, "Signals");
    const child = await createNote(alice, src, "Signal bus", top);
    const res = await call(alice, "movePages", { workspaceId: src, pageIds: [top], toWorkspaceId: dst, parentId: kit });
    expect(res.isError ?? false).toBe(false);
    expect(dataOf(res)).toMatchObject({
      dryRun: false,
      movedPageIds: [top, child],
      forwards: [
        { pageId: top, workspaceId: dst },
        { pageId: child, workspaceId: dst },
      ],
    });
    const tree = textOf(await call(alice, "tree", { workspaceId: dst }));
    expect(tree).toContain("Signal bus");
    const gone = await call(alice, "getPage", { workspaceId: src, pageId: child });
    expect(dataOf(gone)).toMatchObject({ code: "PAGE_MOVED", workspaceId: dst });
  });

  it("movePages needs access to both workspaces", async () => {
    const bobs = await createWs(bob, "Bob's");
    const page = await createNote(alice, src, "Mine");
    const intoBobs = await call(alice, "movePages", { workspaceId: src, pageIds: [page], toWorkspaceId: bobs, parentId: null });
    expect(intoBobs.isError).toBe(true);
    expect(textOf(intoBobs)).toContain("ACCESS_DENIED");
    const outOfAlices = await call(bob, "movePages", { workspaceId: src, pageIds: [page], toWorkspaceId: bobs, parentId: null });
    expect(outOfAlices.isError).toBe(true);
    expect(textOf(outOfAlices)).toContain("ACCESS_DENIED");
  });

  it("finishes a move left half done when the host recovers", async () => {
    const page = await createNote(alice, src, "Interrupted");
    const handle = await open(src as WorkspaceId);
    await handle.beginPageMove({ to: dst as WorkspaceId, roots: [page as PageId], toParentId: null });
    await mcp.drainOnce();
    expect(await mcp.recoverMoves()).toBe(1);
    await mcp.drainOnce();
    expect(await mcp.readModel.pendingMoves()).toEqual([]);
    expect(await mcp.readModel.getPage(dst as WorkspaceId, page)).toMatchObject({ title: "Interrupted" });
    expect(await mcp.readModel.forwardOf(src as WorkspaceId, page)).toMatchObject({ to_workspace_id: dst });
  });

  it("a ref left behind counts as a backlink of the page in its new home", async () => {
    const res = await call(alice, "backlinks", { workspaceId: dst, pageId: kit });
    expect(dataOf(res)).toEqual(
      expect.arrayContaining([expect.objectContaining({ workspace_id: src, from_id: stay, via: "ref" })]),
    );
  });
});
