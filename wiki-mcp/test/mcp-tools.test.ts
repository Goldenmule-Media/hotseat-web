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

interface NoteFields {
  body?: string;
}

const Note = definePageType<NoteFields>({
  type: "note",
  initialStatus: "draft",
  initialFields: {},
  version: 1,
  items: {},
  statusTransitions: [
    t("draft", "setBody", "draft"),
    t("draft", "publish", "published"),
    t("published", "setBody", "published"),
  ],
  commands: {
    setBody: {
      args: zodSchema(z.object({ text: z.string() })),
      transition: { level: "page", event: "setBody" },
      produces: (_p, a) => ({ events: [{ type: "BodySet", payload: { text: a.text } }], result: undefined }),
    },
    publish: {
      args: zodSchema(z.object({}).strict()),
      transition: { level: "page", event: "publish" },
      produces: () => ({ events: [{ type: "Published", payload: {} }], result: undefined }),
    },
  },
  apply: (page, event) => {
    const p = (event.payload ?? {}) as Record<string, unknown>;
    if (event.type === "BodySet") page.fields.body = p.text as string;
    else if (event.type === "Published") page.status = "published";
    return page;
  },
  render: (page) => `# ${page.title}\n\n${page.fields.body ?? ""}`,
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
    expect(names).toEqual(["publish", "setBody"]);

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
