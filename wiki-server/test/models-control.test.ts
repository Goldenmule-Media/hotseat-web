/**
 * The `/_server/models` control surface (ADR-M6). Drives the REAL control listener
 * (`startControlServer`) over HTTP against a FAKE {@link ModelsControl} — wiki-server
 * proxies into the registry by id + specifier and never imports a bundle, so the seam is
 * exactly what's exercised here. No `wiki` / `wiki-mcp` import (the host stays
 * schema-agnostic).
 */
import { afterEach, describe, expect, it } from "vitest";

import { createLogger, type IConsolidatingLogger } from "../src/logger";
import { startControlServer, type ControlServer, type ModelEvent, type ModelsControl } from "../src/control";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function makeLogger(): IConsolidatingLogger {
  let t = 0;
  return createLogger({
    bufferSize: 100,
    format: "json",
    boot: "b",
    now: () => new Date(Date.UTC(2020, 0, 1) + t++ * 1000).toISOString(),
    write: () => {},
  });
}

/** A fake ModelsControl that records calls and bumps a generation, mimicking ModelRegistry. */
function fakeModels(): { control: ModelsControl; calls: string[] } {
  const bundles = new Map<string, { id: string; specifier: string; types: string[] }>();
  const calls: string[] = [];
  let gen = 0;
  const event = (reason: string, bundleId: string): ModelEvent => ({ generation: ++gen, fingerprint: `fp-${gen}`, reason, bundleId });
  const control: ModelsControl = {
    list: () => [...bundles.values()],
    generation: () => gen,
    load: async (id, specifier) => {
      calls.push(`load:${id}:${specifier}`);
      bundles.set(id, { id, specifier, types: ["note"] });
      return event("load", id);
    },
    reload: async (id) => {
      calls.push(`reload:${id}`);
      if (!bundles.has(id)) throw new Error(`unknown model bundle "${id}"`);
      return event("reload", id);
    },
    unregister: async (id) => {
      calls.push(`unregister:${id}`);
      if (!bundles.delete(id)) throw new Error(`unknown model bundle "${id}"`);
      return event("unregister", id);
    },
  };
  return { control, calls };
}

async function startControl(models?: ModelsControl): Promise<ControlServer> {
  const control = await startControlServer({
    host: "127.0.0.1",
    port: 0,
    logger: makeLogger(),
    info: { version: "9.9.9", storage: "memory", baseUrl: "http://127.0.0.1:4437" },
    startedAt: Date.now(),
    ...(models !== undefined ? { models } : {}),
  });
  cleanups.push(() => control.stop());
  return control;
}

describe("control: /_server/models (ADR-M6)", () => {
  it("lists, loads, reloads, and unregisters bundles — proxying into the registry", async () => {
    const { control: models, calls } = fakeModels();
    const c = await startControl(models);

    let res = await fetch(`${c.url}/_server/models`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ generation: 0, bundles: [] });

    res = await fetch(`${c.url}/_server/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "feature", specifier: "/abs/dist/feature.js" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).reason).toBe("load");

    res = await fetch(`${c.url}/_server/models`);
    const listed = (await res.json()) as { generation: number; bundles: { id: string }[] };
    expect(listed.bundles.map((b) => b.id)).toEqual(["feature"]);
    expect(listed.generation).toBe(1);

    res = await fetch(`${c.url}/_server/models/feature/reload`, { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()).reason).toBe("reload");

    res = await fetch(`${c.url}/_server/models/feature`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await res.json()).reason).toBe("unregister");

    expect(calls).toEqual(["load:feature:/abs/dist/feature.js", "reload:feature", "unregister:feature"]);
  });

  it("400 on a bad POST body, 404 on an unknown bundle, 503 with no registry", async () => {
    const { control: models } = fakeModels();
    const c = await startControl(models);

    let res = await fetch(`${c.url}/_server/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "x" }), // missing specifier
    });
    expect(res.status).toBe(400);

    res = await fetch(`${c.url}/_server/models/nope/reload`, { method: "POST" });
    expect(res.status).toBe(404);

    const c2 = await startControl(undefined); // no registry wired
    res = await fetch(`${c2.url}/_server/models`);
    expect(res.status).toBe(503);
  });
});
