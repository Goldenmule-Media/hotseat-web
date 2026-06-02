/**
 * ModelRegistry + loader (ADR-M6). Self-contained: writes temp `.mjs` bundles rather than
 * depending on a built wiki-models artifact.
 *
 * NOTE on cache-busting: under real Node, importing the same path with a distinct `?v=`
 * query RE-EVALUATES the module (this is ADR-M6's load-bearing claim — verified directly
 * against Node). vitest's module runner caches dynamic imports regardless of the query, so
 * we can't observe re-evaluation HERE; instead we assert the loader emits a **distinct
 * cache-busting URL per load** (the controllable half), which is what makes Node reload.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadModelBundle } from "../src/models/loader.js";
import { ModelRegistry } from "../src/models/registry.js";

const dirs: string[] = [];
function tmpModule(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "wiki-models-"));
  dirs.push(dir);
  const path = join(dir, "bundle.mjs");
  writeFileSync(path, contents);
  return path;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("ModelRegistry + loader (ADR-M6)", () => {
  it("cache-busts each load with a distinct ?v= query (so Node re-evaluates on reload)", async () => {
    const path = tmpModule(`export default [];`);
    const a = await loadModelBundle(path, "0");
    const b = await loadModelBundle(path, "1");
    expect(a.url).toMatch(/\?v=0$/);
    expect(b.url).toMatch(/\?v=1$/);
    expect(a.url).not.toBe(b.url); // distinct module keys → Node re-evaluates on reload
  });

  it("load → reload → unregister bump the generation and fire onChange", async () => {
    const events: string[] = [];
    const reg = new ModelRegistry({ onChange: (e) => void events.push(`${e.reason}@${e.generation}`) });
    const path = tmpModule(`export default [];`);

    const e1 = await reg.load("feature", path);
    expect([e1.reason, e1.generation]).toEqual(["load", 1]);
    expect(reg.list().map((b) => b.id)).toEqual(["feature"]);

    const e2 = await reg.reload("feature");
    expect([e2.reason, e2.generation]).toEqual(["reload", 2]);

    const e3 = await reg.unregister("feature");
    expect([e3.reason, e3.generation]).toEqual(["unregister", 3]);
    expect(reg.list()).toEqual([]);
    await expect(reg.unregister("feature")).rejects.toThrow(/unknown model bundle/);

    expect(events).toEqual(["load@1", "reload@2", "unregister@3"]);
  });

  it("rejects a bundle whose default export is not an array", async () => {
    await expect(loadModelBundle(tmpModule(`export default 42;`))).rejects.toThrow(/must default-export an array/);
  });
});
