/**
 * Host-behavior tests (DESIGN §11). These assert that wiki-server *hosts streams*
 * correctly, using `@durable-streams/client` directly — with **no `wiki` import**
 * (G2). A full client/host round-trip belongs in the engine's own suite.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DurableStream, stream } from "@durable-streams/client";
import { DurableStreamTestServer } from "@durable-streams/server";
import { afterEach, describe, expect, it } from "vitest";

import { configWarnings, resolveConfig } from "../src/config";

/** OCC seq: the folded head, zero-padded so lexicographic == numeric (mirrors EventLog). */
const pad = (n: number): string => String(n).padStart(20, "0");
const JSON_CT = "application/json";

/** Track servers/dirs started by a test so afterEach can tear them down. */
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function startServer(opts: { dataDir?: string } = {}): Promise<string> {
  const server = new DurableStreamTestServer({ port: 0, ...opts });
  const url = await server.start();
  cleanups.push(() => server.stop());
  return url;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wiki-server-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Read a stream from the start and flatten array-messages into a flat event list. */
async function readAll(url: string): Promise<unknown[]> {
  const res = await stream<unknown[]>({ url, offset: "-1", live: false });
  const batches = await res.json();
  return batches.flat();
}

describe.each(["memory", "file"] as const)("smoke (%s storage)", (mode) => {
  it("append stores one message; read returns it; live tail sees a later append", async () => {
    const base = await startServer(mode === "file" ? { dataDir: tempDir() } : {});
    const url = `${base}/test/smoke-${mode}`;
    const handle = await DurableStream.create({ url, contentType: JSON_CT });

    // One append of a JSON array = ONE durably-stored message (arrays not split).
    await handle.append(JSON.stringify([{ n: 1 }, { n: 2 }]), { seq: pad(0) });
    expect(await readAll(url)).toEqual([{ n: 1 }, { n: 2 }]);

    // Live tail: subscribe (replays history), then a later append must arrive.
    const seen: unknown[] = [];
    const res = await stream<unknown[]>({ url, offset: "-1", live: true });
    cleanups.push(() => res.cancel?.());
    const got2 = new Promise<void>((resolve) => {
      res.subscribeJson((batch) => {
        for (const m of batch.items) seen.push(m);
        if (seen.flat().length >= 3) resolve();
      });
    });
    await handle.append(JSON.stringify([{ n: 3 }]), { seq: pad(2) });
    await got2;
    expect(seen.flat()).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });
});

describe("durability (file storage)", () => {
  it("data written before stop() survives a restart on the same dataDir", async () => {
    const dir = tempDir();
    const path = "/test/durable";

    const server1 = new DurableStreamTestServer({ port: 0, dataDir: dir });
    const base1 = await server1.start();
    const handle = await DurableStream.create({ url: `${base1}${path}`, contentType: JSON_CT });
    await handle.append(JSON.stringify([{ kept: true }]), { seq: pad(0) });
    await server1.stop();

    // Restart on the same dataDir (new ephemeral port); the stream must rehydrate.
    const base2 = await startServer({ dataDir: dir });
    await DurableStream.create({ url: `${base2}${path}`, contentType: JSON_CT }); // idempotent
    expect(await readAll(`${base2}${path}`)).toEqual([{ kept: true }]);
  });
});

describe("optimistic concurrency (Stream-Seq → 409)", () => {
  it("a stale (equal) seq is rejected with HTTP 409", async () => {
    const base = await startServer();
    const url = `${base}/test/occ`;
    const handle = await DurableStream.create({ url, contentType: JSON_CT });

    await handle.append(JSON.stringify([{ v: 1 }]), { seq: pad(0) }); // first writer wins

    let err: unknown;
    try {
      await handle.append(JSON.stringify([{ v: 2 }]), { seq: pad(0) }); // same head → stale
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    const status = (err as { status?: number }).status;
    expect(status === 409 || /409|sequence|conflict/i.test(String((err as Error)?.message))).toBe(true);

    // The losing write never committed.
    expect(await readAll(url)).toEqual([{ v: 1 }]);
  });
});

describe("resolveConfig", () => {
  it("applies defaults with no flags or env", () => {
    const c = resolveConfig([], {});
    expect(c).toMatchObject({ host: "127.0.0.1", port: 4437, storage: "file", dataDir: "./.wiki-data" });
  });

  it("env overrides defaults", () => {
    const c = resolveConfig([], { WIKI_SERVER_PORT: "5000", WIKI_SERVER_STORAGE: "memory" });
    expect(c.port).toBe(5000);
    expect(c.storage).toBe("memory");
  });

  it("flags override env (and parse --key=value)", () => {
    const c = resolveConfig(["--port", "6000", "--host=0.0.0.0"], { WIKI_SERVER_PORT: "5000" });
    expect(c.port).toBe(6000);
    expect(c.host).toBe("0.0.0.0");
  });

  it("rejects a non-existent storage mode (e.g. acid)", () => {
    expect(() => resolveConfig(["--storage", "acid"], {})).toThrow(/acid/);
  });

  it("warns on a non-loopback host, not on loopback", () => {
    expect(configWarnings(resolveConfig(["--host", "0.0.0.0"], {}))).toHaveLength(1);
    expect(configWarnings(resolveConfig([], {}))).toHaveLength(0);
  });
});
