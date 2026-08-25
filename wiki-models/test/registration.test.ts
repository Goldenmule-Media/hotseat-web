/**
 * Every bundle must be registered in ALL FOUR places, or it fails silently.
 *
 * A page-type bundle is a directory under `src/` with an `index.ts` (that is what makes
 * `shared/` — glossary + page-state helpers — not a bundle). Adding one takes four
 * registrations, and only the first fails loudly:
 *
 *   1. `package.json` exports          — source imports (`wiki-models/<b>`)
 *   2. `src/<b>/index.ts`              — the bundle itself, default-exporting its types
 *   3. `tsdown.config.ts` entry        — what `npm run build` emits, and therefore what
 *                                        `deploy.sh` rsyncs to the server's `models/`
 *   4. `wiki-ui/lib/models.ts`         — what the browser can fold, resolved at BUILD time
 *                                        because a browser has no runtime `import()`
 *
 * Miss (3) and the deploy reports SUCCESS while shipping a models directory without the
 * type. Miss (4) and wiki-ui folds the stream against a registry that has never heard of
 * the type and renders an EMPTY workspace. Both happened shipping `engagement-log`; the
 * type checker caught neither, because nothing imports these registries by name.
 *
 * Deliberately textual — it reads the manifests as files rather than importing them, so a
 * missing registration shows up as a failed assertion naming the file to edit, instead of
 * a resolution error somewhere downstream.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

/** A bundle is a `src/` directory with an `index.ts`; anything else is shared helpers. */
const bundles: string[] = readdirSync(SRC, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(SRC, e.name, "index.ts")))
  .map((e) => e.name)
  .sort();

const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf8");

describe("every model bundle is registered everywhere it has to be", () => {
  it("finds the bundles (guards against the discovery itself silently going empty)", () => {
    expect(bundles.length).toBeGreaterThanOrEqual(12);
    expect(bundles).toContain("feature");
    // `shared/` holds glossary + page-state helpers and declares no page type.
    expect(bundles).not.toContain("shared");
  });

  it.each(bundles)("%s — package.json exports it", (bundle) => {
    const exports = JSON.parse(read("package.json")).exports as Record<string, string>;
    expect(exports[`./${bundle}`]).toBe(`./src/${bundle}/index.ts`);
  });

  it.each(bundles)("%s — its index.ts default-exports the bundle's page types", (bundle) => {
    expect(read("src", bundle, "index.ts")).toMatch(/export default /);
  });

  it.each(bundles)("%s — tsdown.config.ts has a build entry (else deploy.sh ships nothing)", (bundle) => {
    const config = read("tsdown.config.ts");
    // Hyphenated keys are quoted, bare ones are not — accept either.
    const entry = new RegExp(`["']?${bundle.replace(/[-]/g, "\\-")}["']?\\s*:\\s*["']src/${bundle}/index\\.ts["']`);
    expect(config).toMatch(entry);
  });

  it.each(bundles)("%s — wiki-ui/lib/models.ts imports AND spreads it (else the browser renders nothing)", (bundle) => {
    const models = readFileSync(join(ROOT, "..", "wiki-ui", "lib", "models.ts"), "utf8");
    const importLine = new RegExp(`import\\s+(\\w+)\\s+from\\s+["']wiki-models/${bundle}["']`);
    const found = importLine.exec(models);
    expect(found, `wiki-ui/lib/models.ts does not import "wiki-models/${bundle}"`).not.toBeNull();
    // Importing without spreading it into `pageTypes` registers nothing.
    expect(models).toMatch(new RegExp(`\\.\\.\\.${found![1]}\\b`));
  });
});
