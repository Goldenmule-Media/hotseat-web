import { defineConfig } from "tsdown";

/**
 * Build a SELF-CONTAINED, runnable `dist/main.js` (DESIGN §10). `wiki-mcp` embeds the
 * `wiki` engine, which is consumed as TS *source* with extensionless relative imports
 * (the engine's `Bundler`-style convention), so a plain `tsc` emit would NOT run under
 * raw Node ESM. tsdown (Rolldown) **bundles the workspace lib in from source** —
 * resolving those extensionless imports at build time — and keeps the npm deps
 * **external** so the native/WASM ones (PGlite, pg, the lmdb-backed `@durable-streams`
 * server) load from `node_modules` at runtime. Dev (typecheck/test) is unchanged: it
 * still resolves the workspace packages to source via `Bundler` resolution / vitest.
 * The entry's `#!` shebang is preserved (the package `bin` is `dist/main.js`).
 */
export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  // Emit `.js` (ESM — the package is `type: module`) so the `bin` path stays stable.
  outExtensions: () => ({ js: ".js" }),
  deps: {
    // Inline the workspace engine (consumed as source); keep npm deps external.
    alwaysBundle: ["wiki"],
    neverBundle: [
      /^@durable-streams\//,
      /^@electric-sql\//,
      /^@modelcontextprotocol\//,
      /^kysely($|\/)/,
      /^pg($|\/)/,
      /^zod($|\/)/,
      /^zod-to-json-schema($|\/)/,
    ],
  },
  sourcemap: true,
  clean: true,
  dts: false,
});
