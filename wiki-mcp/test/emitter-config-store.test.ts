/**
 * The emitter configuration store (feature: "Runtime-configurable Markdown emitters").
 *
 * Covers the pure fold (last-writer-wins per emitterId; remove deletes) and the
 * append/readAll round-trip over a real in-memory Durable Streams host against the store's
 * OWN `_emitter-config` stream — separate from any workspace stream.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DurableStreamTestServer } from "@durable-streams/server";

import {
  EmitterConfigStore,
  foldEmitters,
  type EmitterConfigEvent,
} from "../src/emitters/config-store.js";

const NAMESPACE = "test";

/** A deterministic ISO clock so `at` stamps are stable in assertions. */
function clock(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2020, 0, 1) + n++ * 1000).toISOString();
}

describe("foldEmitters — last-writer-wins per emitterId", () => {
  it("a later EmitterConfigured for the same id replaces the earlier one", () => {
    const events: EmitterConfigEvent[] = [
      { type: "EmitterConfigured", emitterId: "e1", workspaceId: "ws:A", root: "/rootA", at: "t0" },
      { type: "EmitterConfigured", emitterId: "e1", workspaceId: "ws:A", root: "/rootB", at: "t1" },
    ];
    const live = foldEmitters(events);
    expect(live.size).toBe(1);
    expect(live.get("e1")).toEqual({ emitterId: "e1", workspaceId: "ws:A", root: "/rootB" });
  });

  it("EmitterRemoved deletes the entry, leaving the rest", () => {
    const events: EmitterConfigEvent[] = [
      { type: "EmitterConfigured", emitterId: "e1", workspaceId: "ws:A", root: "/a", at: "t0" },
      { type: "EmitterConfigured", emitterId: "e2", workspaceId: "ws:B", root: "/b", at: "t1" },
      { type: "EmitterRemoved", emitterId: "e1", at: "t2" },
    ];
    const live = foldEmitters(events);
    expect([...live.keys()]).toEqual(["e2"]);
  });
});

describe("EmitterConfigStore — append / readAll round-trip", () => {
  let server: DurableStreamTestServer;
  let url: string;

  beforeEach(async () => {
    server = new DurableStreamTestServer({ port: 0 });
    url = await server.start();
  });
  afterEach(async () => {
    await server.stop();
  });

  it("appends configured + removed and reads them back in order, folding to the live set", async () => {
    const store = new EmitterConfigStore({ baseUrl: url, namespace: NAMESPACE }, clock());
    await store.appendConfigured({ emitterId: "e1", workspaceId: "ws:A", root: "/a" });
    await store.appendConfigured({ emitterId: "e2", workspaceId: "ws:B", root: "/b" });
    await store.appendRemoved("e1");

    const { events } = await store.readAll();
    expect(events.map((e) => e.type)).toEqual(["EmitterConfigured", "EmitterConfigured", "EmitterRemoved"]);
    // The `at` stamp came from the injected clock (informational; the fold ignores it).
    expect(events[0].at).toBe("2020-01-01T00:00:00.000Z");

    const live = foldEmitters(events);
    expect([...live.keys()]).toEqual(["e2"]);
    expect(live.get("e2")).toEqual({ emitterId: "e2", workspaceId: "ws:B", root: "/b" });

    await store.close();
  });
});
