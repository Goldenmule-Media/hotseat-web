/**
 * Model-bundle discovery + tolerant loading. A PORTABLE mirror carries its schema as loose files
 * beside the binary, so `--models-dir` has to cope with a built tree: entry bundles, shared
 * chunks that are not bundles, and sourcemaps, all in one flat directory.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IPageType } from "wiki/authoring";

import type { Logger } from "../src/logger.js";
import { dedupePageTypes, discoverModelBundles, loadModelsDir } from "../src/models.js";

/** A logger that records what it was told, so tests can assert on level as well as message. */
function recordingLogger(): Logger & { lines: { level: string; msg: string }[] } {
  const lines: { level: string; msg: string }[] = [];
  const logger = {
    lines,
    info: (msg: string) => lines.push({ level: "info", msg }),
    warn: (msg: string) => lines.push({ level: "warn", msg }),
    error: (msg: string) => lines.push({ level: "error", msg }),
    child: () => logger,
  };
  return logger;
}

const pageType = (type: string): IPageType => ({ __def: { type } }) as unknown as IPageType;

describe("wiki-mirror — model bundles", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wiki-mirror-models-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("discoverModelBundles", () => {
    it("finds <bundle>/index.* in a source tree, named by the directory", () => {
      mkdirSync(join(dir, "feature"));
      writeFileSync(join(dir, "feature", "index.ts"), "export default [];");
      mkdirSync(join(dir, "adr"));
      writeFileSync(join(dir, "adr", "index.js"), "export default [];");
      mkdirSync(join(dir, "not-a-bundle")); // no index file

      expect(discoverModelBundles(dir)).toEqual([
        { id: "adr", specifier: join(dir, "adr", "index.js") },
        { id: "feature", specifier: join(dir, "feature", "index.ts") },
      ]);
    });

    it("finds <bundle>.js in a flat built tree, ignoring sourcemaps, .d.ts and dotfiles", () => {
      for (const name of ["feature.js", "toc.mjs", "feature.js.map", "types.d.ts", ".DS_Store", "notes.md"]) {
        writeFileSync(join(dir, name), "export default [];");
      }

      expect(discoverModelBundles(dir).map((b) => b.id)).toEqual(["feature", "toc"]);
    });

    it("fails loudly when the directory cannot be read", () => {
      expect(() => discoverModelBundles(join(dir, "missing"))).toThrow(/could not be read/);
    });
  });

  describe("loadModelsDir", () => {
    it("loads real bundles and passes over the shared chunks a built tree is full of", async () => {
      writeFileSync(join(dir, "good.mjs"), 'export default [{ __def: { type: "note" } }];');
      writeFileSync(join(dir, "chunk.mjs"), "export const helper = () => 1;");
      const logger = recordingLogger();

      const types = await loadModelsDir(dir, logger);

      expect(types).toHaveLength(1);
      expect(types[0].__def.type).toBe("note");
      // A chunk is expected cargo, not a failure — it must not read like one in a service log.
      expect(logger.lines).toContainEqual({ level: "info", msg: "wiki-mirror: ignored a file that is not a model bundle" });
      expect(logger.lines.some((l) => l.level === "warn")).toBe(false);
    });

    it("warns and continues when a bundle throws on import — one bad file can't cost the schema", async () => {
      writeFileSync(join(dir, "boom.mjs"), 'throw new Error("bad bundle");');
      writeFileSync(join(dir, "good.mjs"), 'export default [{ __def: { type: "note" } }];');
      const logger = recordingLogger();

      const types = await loadModelsDir(dir, logger);

      expect(types).toHaveLength(1);
      expect(logger.lines).toContainEqual({ level: "warn", msg: "wiki-mirror: skipped an unloadable discovered bundle" });
    });

    it("accepts a `pageTypes` named export as well as the default", async () => {
      writeFileSync(join(dir, "named.mjs"), 'export const pageTypes = [{ __def: { type: "note" } }];');
      expect(await loadModelsDir(dir, recordingLogger())).toHaveLength(1);
    });
  });

  describe("dedupePageTypes", () => {
    it("keeps the FIRST definition of a type so an explicit --models wins over a discovered one", () => {
      const logger = recordingLogger();
      const explicit = pageType("note");
      const discovered = pageType("note");

      const merged = dedupePageTypes([explicit, discovered, pageType("adr")], logger);

      expect(merged).toEqual([explicit, pageType("adr")]);
      expect(merged[0]).toBe(explicit);
      expect(logger.lines).toContainEqual({ level: "warn", msg: "wiki-mirror: ignoring a duplicate page type" });
    });
  });
});
