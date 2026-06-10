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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import featurePageTypes, { skills as featureSkills } from "wiki-models/feature";

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

// ── model-packaged Claude skills (the optional named `skills` export) ───────────────

const SKILL = {
  name: "build-feature",
  description: "FSM-gated feature builds.",
  plugin: "hotseat",
  marketplace: "hotseat",
  marketplaceSource: "Goldenmule-Media/hotseat-web",
  command: "/build-feature",
};

function skillBundle(skill: Record<string, unknown>): string {
  return tmpModule(`export default [];\nexport const skills = [${JSON.stringify(skill)}];`);
}

describe("model-packaged Claude skills", () => {
  it("loads a bundle's named `skills` export beside its page types; absent → []", async () => {
    const withSkills = await loadModelBundle(skillBundle(SKILL));
    expect(withSkills.skills).toEqual([SKILL]);

    const without = await loadModelBundle(tmpModule(`export default [];`));
    expect(without.skills).toEqual([]);
  });

  it("rejects a malformed `skills` export with a descriptive contract error", async () => {
    await expect(loadModelBundle(tmpModule(`export default [];\nexport const skills = 42;`))).rejects.toThrow(
      /`skills` export that is not an array/,
    );
    const { command: _command, plugin: _plugin, ...missingPlugin } = SKILL;
    await expect(loadModelBundle(skillBundle(missingPlugin))).rejects.toThrow(/missing the string field "plugin"/);
    await expect(loadModelBundle(skillBundle({ ...SKILL, marketplace: 7 }))).rejects.toThrow(
      /missing the string field "marketplace"/,
    );
    await expect(loadModelBundle(skillBundle({ ...SKILL, command: 7 }))).rejects.toThrow(
      /command must be a non-empty string/,
    );
    await expect(loadModelBundle(skillBundle({ ...SKILL, command: "" }))).rejects.toThrow(
      /command must be a non-empty string/,
    );
  });

  it("list() derives installCommands from the declaration; in-memory register() declares none", async () => {
    const reg = new ModelRegistry();
    await reg.load("feature", skillBundle(SKILL));
    expect(reg.list()[0].skills).toEqual([
      {
        ...SKILL,
        installCommands: ["/plugin marketplace add Goldenmule-Media/hotseat-web", "/plugin install hotseat@hotseat"],
      },
    ]);

    // The createWikiMcp seed path: already-loaded defs, no skills param.
    await reg.register("default", featurePageTypes);
    expect(reg.list().find((b) => b.id === "default")?.skills).toEqual([]);
  });

  it("reload threads skills; a replaced registration reflects new metadata", async () => {
    const reg = new ModelRegistry();
    await reg.load("feature", skillBundle(SKILL));
    await reg.reload("feature"); // the reload path re-extracts skills via the loader
    expect(reg.list()[0].skills[0].name).toBe("build-feature");

    // Registry-level metadata replace — what a real Node reload delivers (the distinct
    // ?v= per load, asserted above, is what makes Node re-evaluate; vitest caches imports).
    await reg.register("feature", [], [{ ...SKILL, description: "v2" }]);
    expect(reg.list()[0].skills[0].description).toBe("v2");
  });

  it("the feature bundle's declaration stays consistent with the repo's marketplace manifest", () => {
    // Keeps the triple-named "hotseat" (marketplace.json / plugin.json / bundle decl) from drifting.
    const marketplace = JSON.parse(
      readFileSync(new URL("../../.claude-plugin/marketplace.json", import.meta.url), "utf8"),
    ) as { name: string; plugins: { name: string }[] };
    for (const skill of featureSkills) {
      expect(skill.marketplace).toBe(marketplace.name);
      expect(marketplace.plugins.map((p) => p.name)).toContain(skill.plugin);
    }
    expect(featureSkills.length).toBeGreaterThan(0);
  });
});
