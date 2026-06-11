import { defineConfig } from "tsdown";

/**
 * Build a SELF-CONTAINED, runnable `dist/bin.js`. `wiki-mirror` embeds the `wiki` engine,
 * which is consumed as TS *source* with extensionless relative imports (the engine's
 * `Bundler`-style convention), so a plain `tsc` emit would NOT run under raw Node ESM.
 * tsdown (Rolldown) **bundles the workspace engine in from source** — resolving those
 * extensionless imports at build time — and keeps the npm deps external so they load from
 * `node_modules` at runtime. `wiki-models` is NOT bundled: it is loaded BY REFERENCE
 * (dynamic `import()` of a specifier) at runtime, keeping the mirror schema-agnostic.
 */
export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  // Emit `.js` (ESM — the package is `type: module`) so the `bin` path stays stable.
  outExtensions: () => ({ js: ".js" }),
  deps: {
    // Inline the workspace engine (consumed as source); keep npm deps external. The regex
    // (not the bare string "wiki") is REQUIRED so the `wiki/registry` + `wiki/authoring`
    // SUBPATH exports are bundled too — otherwise they stay external and Node tries to load
    // the engine's extensionless TS source at runtime (ERR_MODULE_NOT_FOUND). It does NOT
    // match `wiki-models` (no `/` or end-of-string after `wiki`), which is correct.
    alwaysBundle: [/^wiki(\/|$)/],
    neverBundle: [
      /^@durable-streams\//,
      /^kysely($|\/)/,
      /^zod($|\/)/,
      /^zod-to-json-schema($|\/)/,
      // Loaded by reference (dynamic import) at runtime — never bundled.
      /^wiki-models($|\/)/,
    ],
  },
  sourcemap: true,
  clean: true,
  dts: false,
});
