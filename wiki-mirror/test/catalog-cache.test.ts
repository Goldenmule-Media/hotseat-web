/** The catalog TTL cache: names on a hot status path must never cost a round-trip or a failure. */
import { describe, expect, it } from "vitest";

import type { IWorkspaceSummary, WorkspaceId } from "wiki";

import { CatalogCache } from "../src/catalog-cache.js";

const entry = (id: string, name: string): IWorkspaceSummary =>
  ({ id: id as WorkspaceId, name, status: "active" }) as IWorkspaceSummary;

describe("wiki-mirror — catalog cache", () => {
  it("loads once and serves the snapshot until the TTL expires", async () => {
    let calls = 0;
    let now = 0;
    const cache = new CatalogCache(
      async () => {
        calls++;
        return [entry("ws:a", `load-${calls}`)];
      },
      { ttlMs: 100, now: () => now },
    );

    expect((await cache.get())[0].name).toBe("load-1");
    now = 50;
    expect((await cache.get())[0].name).toBe("load-1");
    now = 150;
    expect((await cache.get())[0].name).toBe("load-2");
    expect(calls).toBe(2);
  });

  it("peek() never does I/O and starts empty", async () => {
    const cache = new CatalogCache(async () => [entry("ws:a", "A")]);
    expect(cache.peek()).toEqual([]);
    await cache.refresh();
    expect(cache.peek()).toHaveLength(1);
    expect(cache.nameOf("ws:a")).toBe("A");
    expect(cache.nameOf("ws:missing")).toBeUndefined();
  });

  it("serves a stale snapshot when a refresh fails — names are worth more than freshness here", async () => {
    let fail = false;
    let now = 0;
    const cache = new CatalogCache(
      async () => {
        if (fail) throw new Error("offline");
        return [entry("ws:a", "A")];
      },
      { ttlMs: 10, now: () => now },
    );

    await cache.get();
    fail = true;
    now = 100;
    expect(await cache.get()).toHaveLength(1); // stale, not empty
    await expect(cache.refresh()).rejects.toThrow(/offline/);
  });

  it("throws from get() only when it has never loaded anything", async () => {
    const cache = new CatalogCache(async () => {
      throw new Error("offline");
    });
    await expect(cache.get()).rejects.toThrow(/offline/);
  });

  it("shares one round-trip between concurrent callers", async () => {
    let calls = 0;
    const cache = new CatalogCache(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return [entry("ws:a", "A")];
    });

    await Promise.all([cache.refresh(), cache.refresh(), cache.refresh()]);
    expect(calls).toBe(1);
  });
});
