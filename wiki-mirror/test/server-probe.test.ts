/**
 * The liveness probe: reachability, credentials, and whether a tail is keeping pace. Every
 * case injects `fetchImpl` + a clock, so nothing here touches a network or a real timer.
 */
import { describe, expect, it } from "vitest";

import { silentLogger } from "../src/logger.js";
import { ServerProbe, type ProbeEvent } from "../src/server-probe.js";
import type { MirrorWorkspaceStatus } from "../src/mirror.js";

const WS = "ws:probe-0001";

function statusOf(overrides: Partial<MirrorWorkspaceStatus> = {}): MirrorWorkspaceStatus {
  return {
    workspaceId: WS,
    root: "/tmp/root",
    appliedVersion: 3,
    lastReconcileAt: null,
    lastReconcileError: null,
    connected: true,
    ...overrides,
  };
}

/** A fetch stub whose per-call outcome comes from `answers` (the last one repeats). */
function fakeFetch(answers: readonly (Response | Error)[]): { impl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  let i = 0;
  const impl = (async (input: string | URL | Request) => {
    urls.push(String(input));
    const answer = answers[Math.min(i++, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return answer;
  }) as unknown as typeof fetch;
  return { impl, urls };
}

const okAt = (offset: string | null): Response =>
  new Response(null, { status: 200, headers: offset !== null ? { "stream-offset": offset } : {} });

describe("wiki-mirror — server probe", () => {
  it("HEADs each workspace stream at the documented namespace path and records reachability", async () => {
    const { impl, urls } = fakeFetch([okAt("42")]);
    const probe = new ServerProbe({
      baseUrl: "https://wiki.example.com",
      namespace: "default",
      snapshot: async () => [statusOf()],
      logger: silentLogger,
      fetchImpl: impl,
    });

    await probe.round();

    expect(urls).toEqual([`https://wiki.example.com/default/workspace/${encodeURIComponent(WS)}`]);
    expect(probe.status()).toMatchObject({ reachable: true, lastError: null, unauthorized: false });
    expect(probe.workspace(WS)).toMatchObject({ offset: "42", stuck: false });
  });

  it("probes the catalog when nothing is configured, so 'is the server up?' still has an answer", async () => {
    const { impl, urls } = fakeFetch([okAt(null)]);
    const probe = new ServerProbe({
      baseUrl: "https://wiki.example.com",
      namespace: "ns",
      snapshot: async () => [],
      logger: silentLogger,
      fetchImpl: impl,
    });

    await probe.round();

    expect(urls).toEqual(["https://wiki.example.com/ns/_catalog"]);
    expect(probe.status().reachable).toBe(true);
  });

  it("treats 401/403 as a credentials problem, not a network problem", async () => {
    const { impl } = fakeFetch([new Response(null, { status: 401 })]);
    const probe = new ServerProbe({
      baseUrl: "http://host",
      namespace: "ns",
      snapshot: async () => [statusOf()],
      logger: silentLogger,
      fetchImpl: impl,
    });

    await probe.round();

    const status = probe.status();
    expect(status.unauthorized).toBe(true);
    expect(status.reachable).toBe(true); // the host answered — the grant is what's wrong
    expect(status.lastError).toMatch(/401/);
  });

  it("counts a 404 as healthy — the stream simply does not exist yet", async () => {
    const { impl } = fakeFetch([new Response(null, { status: 404 })]);
    const probe = new ServerProbe({
      baseUrl: "http://host",
      namespace: "ns",
      snapshot: async () => [statusOf()],
      logger: silentLogger,
      fetchImpl: impl,
    });

    await probe.round();
    expect(probe.status()).toMatchObject({ reachable: true, lastError: null });
  });

  it("reports a thrown authorization resolver as unauthorized (an expired grant fails this way)", async () => {
    const { impl } = fakeFetch([okAt("1")]);
    const probe = new ServerProbe({
      baseUrl: "http://host",
      namespace: "ns",
      snapshot: async () => [statusOf()],
      logger: silentLogger,
      fetchImpl: impl,
      authorization: () => {
        throw new Error("the stored grant for http://host has expired — sign in again");
      },
    });

    await probe.round();
    expect(probe.status()).toMatchObject({ unauthorized: true });
    expect(probe.status().lastError).toMatch(/expired/);
  });

  it("marks the host unreachable when the request throws", async () => {
    const { impl } = fakeFetch([new Error("connect ECONNREFUSED")]);
    const probe = new ServerProbe({
      baseUrl: "http://host",
      namespace: "ns",
      snapshot: async () => [statusOf()],
      logger: silentLogger,
      fetchImpl: impl,
    });

    await probe.round();
    expect(probe.status()).toMatchObject({ reachable: false, unauthorized: false });
    expect(probe.status().lastError).toMatch(/ECONNREFUSED/);
  });

  it("calls a tail WEDGED once the server moves ahead and we never catch up", async () => {
    let now = 1_000_000;
    const events: ProbeEvent[] = [];
    const { impl } = fakeFetch([okAt("10"), okAt("11"), okAt("11")]);
    // lastReconcileAt stays in the distant past: this tail is subscribed but no longer applying.
    const probe = new ServerProbe({
      baseUrl: "http://host",
      namespace: "ns",
      snapshot: async () => [statusOf({ lastReconcileAt: 500_000 })], // reconciled long before
      logger: silentLogger,
      fetchImpl: impl,
      stuckAfterMs: 60_000,
      now: () => now,
    });
    probe.on((e) => events.push(e));

    await probe.round(); // baseline offset 10
    expect(probe.workspace(WS)?.behindSince).toBeNull();

    await probe.round(); // offset moved to 11 → we are behind from now on
    expect(probe.workspace(WS)?.behindSince).toBe(now);
    expect(probe.workspace(WS)?.stuck).toBe(false);

    now += 61_000;
    await probe.round(); // still behind, past the threshold
    expect(probe.workspace(WS)?.stuck).toBe(true);
    expect(events).toContainEqual({ type: "wedged", workspaceId: WS, behindSince: 1_000_000 });
  });

  it("does NOT call a mirror wedged for a commit it already reconciled between rounds", async () => {
    // The real ordering: the tail reconciles milliseconds after the append, and the probe only
    // finds out on its NEXT round. Stamping "behind" at the moment the probe noticed would make
    // every healthy commit look like a miss, and a quiet mirror would rebuild itself for nothing
    // a few minutes after every editing session.
    let now = 90_000;
    const events: ProbeEvent[] = [];
    const { impl } = fakeFetch([okAt("5"), okAt("6"), okAt("6"), okAt("6")]);
    const probe = new ServerProbe({
      baseUrl: "http://host",
      namespace: "ns",
      snapshot: async () => [statusOf({ lastReconcileAt: 100_200 })],
      logger: silentLogger,
      fetchImpl: impl,
      stuckAfterMs: 180_000,
      now: () => now,
    });
    probe.on((e) => events.push(e));

    await probe.round(); // t=90s, baseline offset 5
    now = 120_000;
    await probe.round(); // t=120s, offset moved to 6 — but we reconciled at t=100.2s
    expect(probe.workspace(WS)?.behindSince).toBeNull();

    now = 300_000;
    await probe.round(); // long after the stuck threshold would have fired
    expect(probe.workspace(WS)?.stuck).toBe(false);
    expect(events).toEqual([]);
  });

  it("ignores pace for a workspace that is not tailing — that is the supervisor's failure to report", async () => {
    let now = 1_000;
    const events: ProbeEvent[] = [];
    const { impl } = fakeFetch([okAt("1"), okAt("2"), okAt("3")]);
    const probe = new ServerProbe({
      baseUrl: "http://host",
      namespace: "ns",
      snapshot: async () => [statusOf({ connected: false, lastReconcileAt: null })],
      logger: silentLogger,
      fetchImpl: impl,
      stuckAfterMs: 1,
      now: () => now,
    });
    probe.on((e) => events.push(e));

    await probe.round();
    now = 100_000;
    await probe.round();
    now = 200_000;
    await probe.round();

    expect(probe.workspace(WS)?.behindSince).toBeNull();
    expect(events).toEqual([]);
  });

  it("clears 'behind' as soon as a reconcile lands after the server moved", async () => {
    let now = 1_000_000;
    let lastReconcileAt: number | null = 500_000;
    const { impl } = fakeFetch([okAt("10"), okAt("11"), okAt("11")]);
    const probe = new ServerProbe({
      baseUrl: "http://host",
      namespace: "ns",
      snapshot: async () => [statusOf({ lastReconcileAt })],
      logger: silentLogger,
      fetchImpl: impl,
      stuckAfterMs: 60_000,
      now: () => now,
    });

    await probe.round();
    await probe.round();
    expect(probe.workspace(WS)?.behindSince).toBe(1_000_000);

    now += 10_000;
    lastReconcileAt = now; // the tail caught up
    await probe.round();
    expect(probe.workspace(WS)?.behindSince).toBeNull();
    expect(probe.workspace(WS)?.stuck).toBe(false);
  });

  it("emits 'recovered' only on a failure → success transition, never on the first round", async () => {
    const events: ProbeEvent[] = [];
    const { impl } = fakeFetch([okAt("1"), new Error("offline"), okAt("2")]);
    const probe = new ServerProbe({
      baseUrl: "http://host",
      namespace: "ns",
      snapshot: async () => [statusOf()],
      logger: silentLogger,
      fetchImpl: impl,
    });
    probe.on((e) => events.push(e));

    await probe.start(); // baseline round: healthy, must NOT count as a recovery
    expect(events).toEqual([]);

    await probe.round(); // fails
    expect(probe.status().reachable).toBe(false);
    await probe.round(); // recovers
    expect(events).toEqual([{ type: "recovered" }]);
    probe.stop();
  });

  it("reset() forgets pace bookkeeping so a fresh engine is not judged by the old one's offsets", async () => {
    let now = 1_000_000;
    const { impl } = fakeFetch([okAt("10"), okAt("11")]);
    const probe = new ServerProbe({
      baseUrl: "http://host",
      namespace: "ns",
      snapshot: async () => [statusOf({ lastReconcileAt: 1 })],
      logger: silentLogger,
      fetchImpl: impl,
      stuckAfterMs: 1,
      now: () => now,
    });

    await probe.round();
    await probe.round();
    now += 10; // past the (1ms) threshold
    expect(probe.workspace(WS)?.stuck).toBe(true);

    probe.reset();
    expect(probe.workspace(WS)).toBeUndefined();
    now += 1;
    await probe.round();
    expect(probe.workspace(WS)?.stuck).toBe(false);
  });
});
