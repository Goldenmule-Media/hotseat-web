/**
 * The MCP surface layer (DESIGN §6): tools wired to the engine + SQL read model, the
 * per-session token manager (§6.2), and `wiki://` resources (§6.1).
 *
 * Drives the REAL engine against an in-memory Durable Streams server + an in-memory
 * PGlite read model (the same rig as projection.test.ts), then exercises the tool
 * handlers and resource readers directly. Asserts:
 *
 *  1. Read-your-writes through the token manager: a write tool advances the session's
 *     high-water mark; a read tool waits on it (proven by withholding projection until
 *     after the read is requested, then draining).
 *  2. The engine's structured errors propagate (illegal mutate, unknown page).
 *  3. `wiki://` resources render the workspace/page via the engine.
 *  4. The session token manager keeps per-session high-water marks and fans out.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  arg,
  decodeToken,
  definePageType,
  encodeToken,
  t,
  z,
  zodSchema,
  type WorkspaceId,
} from "wiki";
import { DurableStreamTestServer } from "@durable-streams/server";

import { silentLogger } from "../src/logger.js";
import { EmbeddedEngine } from "../src/engine.js";
import { SqlReadModel } from "../src/readmodel/readmodel.js";
import { buildStore, migrateToLatest, type ReadModelStore } from "../src/readmodel/store.js";
import { ProjectionService } from "../src/tail/projection.js";
import { engineEventSource } from "../src/tail/engine-source.js";
import { SessionTokenManager } from "../src/mcp/tokens.js";
import { wikiTools, type WikiTool, type WikiToolContext } from "../src/mcp/tools.js";
import { readResource, workspaceUri, pageUri, type WikiResourceContext } from "../src/mcp/resources.js";

// ── a tiny `note` page type with a body field ──────────────────────────────────

const Note = definePageType({
  type: "note",
  version: 1,
  initialStatus: "draft",
  statusTransitions: [t("draft", "publish", "published")],
  sections: {
    body: { name: "Body", required: true, mutableIn: ["draft", "published"], fields: { text: { kind: "prose" } } },
  },
  commands: {
    setBody: { args: zodSchema(z.object({ text: z.string() })), target: { section: "body", field: "text" }, set: { text: arg("text") } },
    publish: { args: zodSchema(z.object({})), transition: { level: "page", event: "publish" } },
  },
  render: { sections: [{ section: "body", heading: "Body", field: "text", as: "block" }] },
});

const PAGE_TYPES = [Note] as const;

function deterministicClock(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2020, 0, 1) + n++ * 1000).toISOString();
}
function deterministicIds(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

const NAMESPACE = "test";

describe("MCP tools + token manager + resources", () => {
  let server: DurableStreamTestServer;
  let url: string;
  let engine: EmbeddedEngine;
  let store: ReadModelStore;
  let readModel: SqlReadModel;
  let projection: ProjectionService;
  let tokens: SessionTokenManager;
  const tools = new Map<string, WikiTool>(wikiTools().map((tl) => [tl.name, tl]));

  // One EmbeddedEngine over the live test stream is shared by the tools (write side)
  // and the tailer source (`handle.history()` → project), exactly as the runtime wires
  // it in main.ts.
  beforeEach(async () => {
    server = new DurableStreamTestServer({ port: 0 });
    url = await server.start();
    engine = new EmbeddedEngine(
      {
        streamBaseUrl: url,
        namespace: NAMESPACE,
        pageTypes: PAGE_TYPES,
        clock: deterministicClock(),
        ids: deterministicIds(),
        readConsistencyTimeoutMs: 2000,
      },
      silentLogger,
    );
    store = buildStore({ kind: "pglite" });
    await migrateToLatest(store.db, silentLogger);
    readModel = new SqlReadModel(store.db, { defaultTimeoutMs: 2000, pollMs: 5 });
    projection = new ProjectionService(store.db, PAGE_TYPES, readModel, silentLogger);
    tokens = new SessionTokenManager();
  });

  afterEach(async () => {
    await engine.close();
    await store.close();
    await server.stop();
  });

  function ctx(sessionId: string | undefined): WikiToolContext {
    return { engine, readModel, tokens, sessionId };
  }
  function resCtx(sessionId: string | undefined): WikiResourceContext {
    return { engine, readModel, tokens, sessionId, namespace: NAMESPACE };
  }
  const drain = (): Promise<void> => projection.drain(engineEventSource(engine));

  it("write tool records a token; a read tool waits on it (read-your-writes)", async () => {
    const session = "s1";
    // createWorkspace then createPage via the tools (the engine commits to the stream).
    const created = await tools.get("createWorkspace")!.handle({ name: "Demo" }, ctx(session));
    const wsId = (created.data as { workspaceId: string }).workspaceId;

    const page = await tools.get("createPage")!.handle(
      { workspaceId: wsId, type: "note", title: "Alpha", parentId: null },
      ctx(session),
    );
    const pageId = (page.data as { pageId: string }).pageId;
    const writeToken = (page.data as { token: string }).token;

    // The session's high-water mark for this workspace is the write's token.
    expect(tokens.consistentWith(session, wsId as WorkspaceId)).toBe(writeToken);

    // Read BEFORE projecting: getPage must wait on the token. Kick it off, confirm it
    // parks, then drain — it must then resolve with the projected page.
    let settled = false;
    const read = tools
      .get("getPage")!
      .handle({ workspaceId: wsId, pageId }, ctx(session))
      .then((r) => {
        settled = true;
        return r;
      });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false); // parked on waitFor(writeToken)

    await drain(); // projects the workspace history into SQL, advancing applied_version
    const result = await read;
    expect(settled).toBe(true);
    const row = result.data as { id: string; title: string; type: string } | null;
    expect(row?.title).toBe("Alpha");
    expect(row?.type).toBe("note");
  });

  it("a session with no writes reads eventually-consistent (no wait)", async () => {
    // Seed a workspace and project it.
    await tools.get("createWorkspace")!.handle({ name: "Seed" }, ctx("writer"));
    await drain();
    // The writer's own cross-workspace read now reflects its write (fan-out wait
    // resolves because the projection caught up).
    const list = await tools.get("listWorkspaces")!.handle({}, ctx("writer"));
    expect((list.data as unknown[]).length).toBeGreaterThan(0);

    // A DIFFERENT session has no high-water marks → its read does not wait and sees
    // the already-projected state immediately.
    const fresh = await tools.get("listWorkspaces")!.handle({}, ctx("other"));
    expect((fresh.data as unknown[]).length).toBeGreaterThan(0);
  });

  it("mutate then describeMutations reflects status; render shows the body", async () => {
    const session = "s2";
    const created = await tools.get("createWorkspace")!.handle({ name: "W" }, ctx(session));
    const wsId = (created.data as { workspaceId: string }).workspaceId;
    const page = await tools.get("createPage")!.handle(
      { workspaceId: wsId, type: "note", title: "Note", parentId: null },
      ctx(session),
    );
    const pageId = (page.data as { pageId: string }).pageId;

    await tools.get("mutatePage")!.handle(
      { workspaceId: wsId, pageId, command: "setBody", args: { text: "hello world" } },
      ctx(session),
    );
    await drain();

    // describeMutations reports the legal set for the page's CURRENT status.
    const desc = await tools.get("describeMutations")!.handle({ workspaceId: wsId, pageId }, ctx(session));
    const names = (desc.data as Array<{ name: string }>).map((d) => d.name).sort();
    expect(names).toEqual(["publish", "setBody", "setBodyText"]);

    // renderPage shows the body (engine renderer, token-gated by the session).
    const rendered = await tools.get("renderPage")!.handle({ workspaceId: wsId, pageId }, ctx(session));
    expect(rendered.text).toContain("hello world");

    // wiki:// page resource renders the same page.
    const contents = await readResource(pageUri(NAMESPACE, wsId, pageId), resCtx(session));
    expect(contents.uri).toBe(pageUri(NAMESPACE, wsId, pageId));
    expect(contents.text).toContain("hello world");

    // wiki:// workspace resource renders the tree.
    const wsRes = await readResource(workspaceUri(NAMESPACE, wsId), resCtx(session));
    expect(wsRes.text).toContain("Note");
  });

  it("describePageType: type-level FSM + commands, no page instance needed", async () => {
    // No type → lists the loaded types.
    const list = await tools.get("describePageType")!.handle({}, ctx("d1"));
    expect((list.data as { types: string[] }).types).toContain("note");

    // A known type → FSM + declared (real args) + generated (empty args) commands.
    const desc = await tools.get("describePageType")!.handle({ type: "note" }, ctx("d1"));
    const data = desc.data as {
      type: string;
      fsm: { initial: string };
      commands: Array<{ name: string; generated: boolean; argsSchema: Record<string, unknown>; transition?: { event: string } }>;
    };
    expect(data.type).toBe("note");
    expect(data.fsm.initial).toBe("draft");

    const setBody = data.commands.find((c) => c.name === "setBody")!;
    expect(setBody.generated).toBe(false);
    expect((setBody.argsSchema as { properties?: Record<string, unknown> }).properties).toHaveProperty("text");

    expect(data.commands.find((c) => c.name === "publish")!.transition?.event).toBe("publish");

    const generated = data.commands.find((c) => c.generated)!;
    expect(generated.name).toBe("setBodyText");
    expect(generated.argsSchema).toEqual({});

    // The human text lists the FSM + commands compactly.
    expect(desc.text).toContain("Status FSM");
    expect(desc.text).toContain("setBody");
  });

  it("describePageType: unknown type returns a helpful error listing known types", async () => {
    const desc = await tools.get("describePageType")!.handle({ type: "nope" }, ctx("d2"));
    expect((desc.data as { error: string }).error).toBe("unknown_type");
    expect(desc.text).toContain("note");
  });

  it("tree returns an indented outline + slim nodes (never page content)", async () => {
    const session = "tree1";
    const created = await tools.get("createWorkspace")!.handle({ name: "Tree" }, ctx(session));
    const wsId = (created.data as { workspaceId: string }).workspaceId;
    const root = await tools.get("createPage")!.handle(
      { workspaceId: wsId, type: "note", title: "Root", parentId: null },
      ctx(session),
    );
    const rootId = (root.data as { pageId: string }).pageId;
    await tools.get("createPage")!.handle(
      { workspaceId: wsId, type: "note", title: "Child", parentId: rootId },
      ctx(session),
    );
    // Body content on Root must NOT leak into the tree payload.
    await tools.get("mutatePage")!.handle(
      { workspaceId: wsId, pageId: rootId, command: "setBody", args: { text: "SECRET-BODY-CONTENT" } },
      ctx(session),
    );
    await drain();

    const tree = await tools.get("tree")!.handle({ workspaceId: wsId }, ctx(session));
    // Indented outline: Root at depth 0, Child nested one level under it.
    expect(tree.text).toContain("- Root (note) [draft]");
    expect(tree.text).toMatch(/\n {2}- Child \(note\) \[draft\]/);
    // Slim data: nodes carry metadata ONLY — never the `sections` blob / body content.
    const data = tree.data as { nodes: Array<Record<string, unknown>>; edges: unknown[] };
    expect(data.nodes.length).toBe(2);
    for (const n of data.nodes) {
      expect(Object.keys(n).sort()).toEqual(["archived", "id", "parentId", "status", "title", "type"]);
    }
    expect(JSON.stringify(tree.data)).not.toContain("SECRET-BODY-CONTENT");
    expect(data.edges.length).toBe(2);
  });

  it("tree hides archived pages (and their subtree) by default; includeArchived reveals them; unarchive restores", async () => {
    const session = "arch1";
    const created = await tools.get("createWorkspace")!.handle({ name: "Arch" }, ctx(session));
    const wsId = (created.data as { workspaceId: string }).workspaceId;
    const root = await tools.get("createPage")!.handle(
      { workspaceId: wsId, type: "note", title: "Root", parentId: null },
      ctx(session),
    );
    const rootId = (root.data as { pageId: string }).pageId;
    await tools.get("createPage")!.handle(
      { workspaceId: wsId, type: "note", title: "Child", parentId: rootId },
      ctx(session),
    );
    await tools.get("archivePage")!.handle({ workspaceId: wsId, pageId: rootId }, ctx(session));
    await drain();

    // Default view: the archived Root and its whole subtree drop out (ancestor-aware).
    const hidden = await tools.get("tree")!.handle({ workspaceId: wsId }, ctx(session));
    expect(hidden.text).toBe("(empty)");
    expect((hidden.data as { nodes: unknown[] }).nodes.length).toBe(0);

    // includeArchived: both reappear; Root is flagged [archived] and KEEPS its status.
    const shown = await tools.get("tree")!.handle({ workspaceId: wsId, includeArchived: true }, ctx(session));
    expect(shown.text).toContain("- Root (note) [draft] [archived]");
    expect(shown.text).toMatch(/\n {2}- Child \(note\) \[draft\]/);
    const shownNodes = (shown.data as { nodes: Array<{ id: string; archived: boolean }> }).nodes;
    expect(shownNodes.length).toBe(2);
    expect(shownNodes.find((n) => n.id === rootId)?.archived).toBe(true);

    // Unarchive restores it to the default view.
    await tools.get("unarchivePage")!.handle({ workspaceId: wsId, pageId: rootId }, ctx(session));
    await drain();
    const restored = await tools.get("tree")!.handle({ workspaceId: wsId }, ctx(session));
    expect(restored.text).toContain("- Root (note) [draft]");
    expect((restored.data as { nodes: unknown[] }).nodes.length).toBe(2);
  });

  it("mutatePageBatch applies an ordered batch atomically with one recorded token", async () => {
    const session = "batch1";
    const created = await tools.get("createWorkspace")!.handle({ name: "B" }, ctx(session));
    const wsId = (created.data as { workspaceId: string }).workspaceId;
    const page = await tools.get("createPage")!.handle(
      { workspaceId: wsId, type: "note", title: "N", parentId: null },
      ctx(session),
    );
    const pageId = (page.data as { pageId: string }).pageId;

    const batch = await tools.get("mutatePageBatch")!.handle(
      {
        workspaceId: wsId,
        pageId,
        commands: [
          { command: "setBody", args: { text: "first" } },
          { command: "setBody", args: { text: "second" } },
          { command: "publish" },
        ],
      },
      ctx(session),
    );
    const data = batch.data as { results: unknown[]; token: string };
    expect(data.results).toHaveLength(3);
    // Exactly one high-water token recorded for the whole batch (read-your-writes).
    expect(tokens.consistentWith(session, wsId as WorkspaceId)).toBe(data.token);

    await drain();
    const rendered = await tools.get("renderPage")!.handle({ workspaceId: wsId, pageId }, ctx(session));
    expect(rendered.text).toContain("second"); // last write wins
    const desc = await tools.get("describeMutations")!.handle({ workspaceId: wsId, pageId }, ctx(session));
    // `publish` ran in the batch → page is now published (publish no longer legal).
    expect((desc.data as Array<{ name: string; available: boolean }>).find((d) => d.name === "publish")!.available).toBe(false);
  });

  it("mutatePageBatch is atomic: a mid-batch failure commits nothing and surfaces the failing index", async () => {
    const session = "batch2";
    const created = await tools.get("createWorkspace")!.handle({ name: "B2" }, ctx(session));
    const wsId = (created.data as { workspaceId: string }).workspaceId;
    const page = await tools.get("createPage")!.handle(
      { workspaceId: wsId, type: "note", title: "N", parentId: null },
      ctx(session),
    );
    const pageId = (page.data as { pageId: string }).pageId;

    // publish twice: the 2nd publish is illegal (already published) → batch aborts at index 1.
    await expect(
      tools.get("mutatePageBatch")!.handle(
        {
          workspaceId: wsId,
          pageId,
          commands: [{ command: "publish" }, { command: "publish" }, { command: "setBody", args: { text: "x" } }],
        },
        ctx(session),
      ),
    ).rejects.toMatchObject({ code: "BATCH_COMMAND_FAILED" });

    // Nothing committed: the page is still in draft (the first publish rolled back too).
    await drain();
    const desc = await tools.get("describeMutations")!.handle({ workspaceId: wsId, pageId }, ctx(session));
    expect((desc.data as Array<{ name: string; available: boolean }>).find((d) => d.name === "publish")!.available).toBe(true);
  });

  it("an illegal mutation surfaces the engine's structured WikiError", async () => {
    const session = "s3";
    const created = await tools.get("createWorkspace")!.handle({ name: "W" }, ctx(session));
    const wsId = (created.data as { workspaceId: string }).workspaceId;
    const page = await tools.get("createPage")!.handle(
      { workspaceId: wsId, type: "note", title: "N", parentId: null },
      ctx(session),
    );
    const pageId = (page.data as { pageId: string }).pageId;

    // publish moves draft→published; setBody is legal in both, but `publish` again
    // from `published` is illegal — publish once, project, then publish again.
    await tools.get("mutatePage")!.handle({ workspaceId: wsId, pageId, command: "publish", args: {} }, ctx(session));
    await drain();
    await expect(
      tools.get("mutatePage")!.handle({ workspaceId: wsId, pageId, command: "publish", args: {} }, ctx(session)),
    ).rejects.toMatchObject({ code: "MUTATION_NOT_ALLOWED" });
  });
});

describe("SessionTokenManager", () => {
  const ws = (s: string): WorkspaceId => s as WorkspaceId;

  it("keeps the max token per workspace and is per-session", () => {
    const m = new SessionTokenManager();
    m.recordWrite("a", encodeToken(ws("w1"), 3));
    m.recordWrite("a", encodeToken(ws("w1"), 1)); // lower → ignored
    m.recordWrite("a", encodeToken(ws("w2"), 5));

    expect(decodeToken(m.consistentWith("a", ws("w1"))!).version).toBe(3);
    expect(decodeToken(m.consistentWith("a", ws("w2"))!).version).toBe(5);
    // a different session is independent
    expect(m.consistentWith("b", ws("w1"))).toBeUndefined();
    // cross-workspace fan-out lists every written workspace's high-water token
    expect(m.allWritten("a").length).toBe(2);
    // reconnect (forget) resets
    m.forget("a");
    expect(m.consistentWith("a", ws("w1"))).toBeUndefined();
  });
});
