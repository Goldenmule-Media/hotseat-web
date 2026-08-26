import { beforeEach, describe, expect, it } from "vitest";
import { bootMark, navStart, painted, reset, routeCommit, rpc, take, timeMarkdown } from "./perf";

const WS = "ws:bench";
const A = "document:a";
const B = "document:b";

/** Drive one whole navigation for `pageId`. */
async function nav(pageId: string, from: string | null = null): Promise<void> {
  navStart(WS, pageId, from);
  routeCommit(WS, pageId);
  await rpc("toMarkdown", pageId, Promise.resolve("# md"));
  await rpc("describeMutations", pageId, Promise.resolve([]));
  timeMarkdown(pageId, 4, () => "<h1>md</h1>");
  painted(pageId, 11);
}

describe("perf", () => {
  beforeEach(() => reset());

  it("records one complete navigation with its spans in order", async () => {
    await nav(A);
    const { navs, stray } = take();
    expect(navs).toHaveLength(1);
    const n = navs[0]!;
    expect(n).toMatchObject({ source: "tree", workspaceId: WS, pageId: A, complete: true });
    expect(n.rpc.map((r) => r.name)).toEqual(["toMarkdown", "describeMutations"]);
    expect(n.bodyBytes).toBe(4);
    expect(n.htmlBytes).toBe(11);
    expect(stray).toHaveLength(0);
    // Monotonic: click → route commit → html → painted.
    expect(n.routeCommitAt!).toBeGreaterThanOrEqual(n.t0);
    expect(n.htmlAt!).toBeGreaterThanOrEqual(n.routeCommitAt!);
    expect(n.paintedAt!).toBeGreaterThanOrEqual(n.htmlAt!);
  });

  it("drains, so a second take() returns nothing new", async () => {
    await nav(A);
    expect(take().navs).toHaveLength(1);
    expect(take().navs).toHaveLength(0);
  });

  it("discards a superseded navigation instead of leaking it into the next", async () => {
    navStart(WS, A, null); // click A…
    await nav(B, A); //        …then click B before A resolved
    const { navs } = take();
    expect(navs).toHaveLength(2);
    expect(navs[0]).toMatchObject({ pageId: A, complete: false });
    expect(navs[0]!.rpc).toHaveLength(0);
    expect(navs[1]).toMatchObject({ pageId: B, complete: true });
    expect(navs[1]!.rpc).toHaveLength(2);
  });

  it("routes an RPC for a non-current page to stray, never to the open record", async () => {
    navStart(WS, A, null);
    await rpc("toMarkdown", B, Promise.resolve("stale"));
    painted(A, 1);
    const { navs, stray } = take();
    expect(navs[0]!.rpc).toHaveLength(0);
    expect(stray).toHaveLength(1);
    expect(stray[0]).toMatchObject({ name: "toMarkdown", pageId: B });
  });

  it("records a rejected RPC as ok:false and still rethrows", async () => {
    navStart(WS, A, null);
    await expect(rpc("toMarkdown", A, Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    painted(A, 1);
    expect(take().navs[0]!.rpc[0]).toMatchObject({ name: "toMarkdown", ok: false });
  });

  it("ignores a second painted() so a live re-render cannot rewrite a finished navigation", async () => {
    await nav(A);
    const first = take().navs[0]!.paintedAt;
    painted(A, 999); // a commit-driven re-render
    expect(take().navs).toHaveLength(0);
    expect(first).toBeDefined();
  });

  it("opens an 'other' navigation when a route commits with no click (link / direct load)", () => {
    routeCommit(WS, A);
    painted(A, 5);
    const n = take().navs[0]!;
    expect(n.source).toBe("other");
    expect(n.t0).toBe(n.routeCommitAt);
  });

  it("stamps each boot field once", () => {
    bootMark("connectStart");
    bootMark("handshakeStart");
    const first = take().boot!.connectStart;
    bootMark("connectStart");
    expect(take().boot!.connectStart).toBe(first);
  });
});
