import { defineConfig } from "tsdown";

/**
 * The PORTABLE build: one self-contained `wiki-mirror.mjs` you can copy to another Mac that has
 * nothing but `node` on it — no repo, no `npm install`, no `node_modules` anywhere on the path.
 *
 * The default build (`tsdown.config.ts`) keeps npm deps external, so its `dist/bin.js` only runs
 * from inside this repo. Here every dependency is inlined and the output imports nothing but
 * `node:` builtins. `wiki-models` stays external — it is loaded BY REFERENCE at runtime, which is
 * what keeps the mirror schema-agnostic; a portable artifact carries the built bundles as loose
 * files beside the binary and points `--models-dir` at them.
 *
 * `.mjs`, not `.js`: a lone `.js` dropped in a directory with no package.json is treated as
 * CommonJS by Node and fails on the first `import`.
 */
export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist-portable",
  outExtensions: () => ({ js: ".mjs" }),
  deps: {
    alwaysBundle: [/.*/],
    // Loaded by reference (dynamic import) at runtime — never bundled, in any build.
    neverBundle: [/^wiki-models($|\/)/],
  },
  sourcemap: false,
  clean: true,
  dts: false,
});
