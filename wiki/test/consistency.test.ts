/**
 * CQRS consistency-token tests (ADR-003).
 *
 * The engine is strict CQRS with eventual consistency: every write returns a
 * `Committed<T>` carrying a `ConsistencyToken`, and reads either pass that token to
 * get read-your-writes (the read `waitFor`s the read side before serving) or omit it
 * to serve the current — possibly stale — projection.
 *
 * Two layers are exercised:
 *
 *  1. Handle layer (a real in-memory wiki): a token-gated read reflects a prior
 *     write, and `Committed.value`/`Committed.token` carry the result + head position.
 *  2. Read-model seam (`InMemoryReadModel`, the default `IReadModel`): an un-applied
 *     token is STALE — an un-tokened read serves the older applied head while a
 *     token-gated `waitFor` parks until the read side catches up (`notifyApplied`),
 *     then resolves; `appliedToken()` reports how far the read side has applied; and
 *     a `waitFor` that the read side never satisfies rejects with
 *     `ConsistencyTimeoutError`.
 *
 * No host clock / RNG in engine logic: the wiki injects deterministic clock/ids and
 * the read model's only host dependency is the timeout timer (I/O, not reducer logic).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ConsistencyToken, IWiki, IWorkspaceHandle, WorkspaceId } from "../src/api";
import { ConsistencyTimeoutError, ReadModelClosedError } from "../src/core/errors";
import { encodeToken, InMemoryReadModel } from "../src/core/readmodel";
import { featurePageTypes } from "wiki-models/feature";
import { createTestWiki, type ITestWiki } from "../src/testing";

// ────────────────────────────────────────────────────────────────────────────
// Handle layer — read-your-writes via a write's token
// ────────────────────────────────────────────────────────────────────────────

describe("handle: a token-gated read reflects a prior write", () => {
  let tw: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;

  beforeEach(async () => {
    tw = await createTestWiki(featurePageTypes);
    wiki = tw.wiki;
    ws = await wiki.createWorkspace({ name: "Consistency" });
  });

  afterEach(async () => {
    await tw.stop();
  });

  it("returns Committed { value, token } from a write and read-your-writes off the token", async () => {
    // The write resolves to the new page id PLUS a token naming the committed head.
    const committed = await ws.createPage("feature-brief", { title: "Export", parentId: null });
    expect(typeof committed.value).toBe("string");
    expect(committed.value.startsWith("feature-brief:")).toBe(true);
    expect(typeof committed.token).toBe("string");
    expect(committed.token).toContain(ws.id);

    // Threading the token into a read guarantees the brief (+ its mandated children)
    // are visible — the read waited for the read side to apply the write.
    const view = await ws.page(committed.value, { consistentWith: committed.token });
    const children = await view.children();
    expect(children.map((c) => c.type)).toEqual([
      "implementation-plan",
      "testing-plan",
      "feature-spec",
    ]);

    // A later content write's token gates a status read to its post-write value.
    const planning = await ws.mutate(committed.value, "beginPlanning", {});
    expect(await view.status({ consistentWith: planning.token })).toBe("planning");
  });

  it("a monotonically later token still reflects all earlier writes (read-your-writes is cumulative)", async () => {
    const { value: brief } = await ws.createPage("feature-brief", { title: "Bulk", parentId: null });
    await ws.mutate(brief, "setSummary", { text: "first" });
    const last = await ws.mutate(brief, "addComponent", { name: "web-app" });

    // The latest token names a head ≥ every earlier write, so a read gated on it
    // reflects BOTH the summary and the component.
    const state = await (await ws.page(brief, { consistentWith: last.token })).state();
    const summary = state.sections.find((s) => s.key === "summary")?.fields.body;
    expect(summary?.kind === "prose" ? summary.value : undefined).toBe("first");
    const comps = state.sections.find((s) => s.key === "components")?.fields.items;
    const names = comps?.kind === "list" ? comps.elements.map((e) => { const n = e.fields.name; return n?.kind === "scalar" ? n.value : undefined; }) : [];
    expect(names).toEqual(["web-app"]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Read-model seam — un-tokened reads may be stale; token-gated reads wait
// ────────────────────────────────────────────────────────────────────────────

describe("InMemoryReadModel: un-tokened read may be stale, token-gated read waits", () => {
  const WS = "ws:rm" as WorkspaceId;
  /** A fixed-timeout read model standing in for the engine's default read side. */
  let rm: InMemoryReadModel;

  beforeEach(() => {
    rm = new InMemoryReadModel(50);
  });

  it("appliedToken lags the write head until notifyApplied — the stale window", async () => {
    // Write side has committed up to version 5; read side has only applied 2.
    rm.notifyApplied(WS, 2);
    const writeToken: ConsistencyToken = encodeToken(WS, 5);

    // appliedToken reports the read side's CURRENT head (2), not the write head (5):
    // an un-tokened read here would serve this stale projection.
    expect(await rm.appliedToken(WS)).toBe(encodeToken(WS, 2));

    // A token-gated read for version 5 must NOT resolve yet (read side is behind).
    let settled = false;
    const gated = rm.waitFor(writeToken).then(() => {
      settled = true;
    });
    // Let microtasks drain; the wait is still parked because applied (2) < 5.
    await Promise.resolve();
    expect(settled).toBe(false);

    // The read side catches up (live tail folds the rest) → the wait resolves and
    // appliedToken now names the up-to-date head.
    rm.notifyApplied(WS, 5);
    await gated;
    expect(settled).toBe(true);
    expect(await rm.appliedToken(WS)).toBe(encodeToken(WS, 5));
  });

  it("an already-applied token resolves immediately (read-your-writes is free in-process)", async () => {
    rm.notifyApplied(WS, 7);
    // applied (7) ≥ requested (4) → resolves without parking.
    await expect(rm.waitFor(encodeToken(WS, 4))).resolves.toBeUndefined();
  });

  it("a token the read side never applies rejects with ConsistencyTimeoutError", async () => {
    rm.notifyApplied(WS, 1);
    // Request a head (9) the read side never reaches within the timeout.
    await expect(rm.waitFor(encodeToken(WS, 9), { timeoutMs: 20 })).rejects.toBeInstanceOf(
      ConsistencyTimeoutError,
    );
    // The error carries the awaited token + timeout so a caller can fall back to an
    // eventually-consistent (un-tokened) read.
    try {
      await rm.waitFor(encodeToken(WS, 9), { timeoutMs: 20 });
      throw new Error("expected ConsistencyTimeoutError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConsistencyTimeoutError);
      expect((err as ConsistencyTimeoutError).token).toBe(encodeToken(WS, 9));
      expect((err as ConsistencyTimeoutError).timeoutMs).toBe(20);
    }
  });

  it("tokens are compared within a workspace only — a peer workspace's head is independent", async () => {
    const other = "ws:other" as WorkspaceId;
    rm.notifyApplied(WS, 10);
    // `other` has applied nothing, so even though WS is at 10, a wait on `other`'s
    // version 3 times out — cross-workspace tokens never satisfy each other.
    await expect(rm.waitFor(encodeToken(other, 3), { timeoutMs: 20 })).rejects.toBeInstanceOf(
      ConsistencyTimeoutError,
    );
    expect(await rm.appliedToken(other)).toBe(encodeToken(other, 0));
  });

  it("forget() rejects a still-parked waiter with ReadModelClosedError (no hang on teardown)", async () => {
    rm.notifyApplied(WS, 1);
    // Park a wait for a head the read side hasn't reached, with a generous timeout — so a
    // regression (forget that only clears timers) surfaces as a 1s timeout FAIL, not a hang.
    const parked = rm.waitFor(encodeToken(WS, 9), { timeoutMs: 1000 });
    rm.forget(WS); // teardown while the wait is pending
    await expect(parked).rejects.toBeInstanceOf(ReadModelClosedError);
  });
});
