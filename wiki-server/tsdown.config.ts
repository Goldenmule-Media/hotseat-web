import { defineConfig } from "tsdown";

/**
 * Build a SELF-CONTAINED, runnable `dist/main.js` (DESIGN §10). `wiki-server` hosts
 * `wiki-mcp` (which embeds the `wiki` engine); both are consumed as TS *source*, so
 * tsdown (Rolldown) **bundles them in from source** and keeps the npm deps **external**
 * so the native/WASM ones (the lmdb-backed `@durable-streams/server`, PGlite, pg) load
 * from `node_modules` at runtime. Dev (typecheck/test) is unchanged — it resolves the
 * workspace packages to source via `Bundler` resolution / vitest. The entry's `#!`
 * shebang is preserved (the package `bin` is `dist/main.js`).
 */
export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  // Emit `.js` (ESM — the package is `type: module`) so the `bin` path stays stable.
  outExtensions: () => ({ js: ".js" }),
  deps: {
    // Inline the hosted module + engine (consumed as source); keep npm deps external.
    // Regexes (not bare strings) so SUBPATH exports — notably `wiki/registry` — are
    // bundled too; left external, Node would load the engine's extensionless TS
    // source at runtime (ERR_MODULE_NOT_FOUND). `^wiki(/|$)` does NOT match
    // "wiki-mcp" (next char is "-"), so the two patterns stay disjoint.
    alwaysBundle: [/^wiki(\/|$)/, /^wiki-mcp(\/|$)/],
    neverBundle: [
      /^@durable-streams\//,
      /^@electric-sql\//,
      /^@modelcontextprotocol\//,
      /^kysely($|\/)/,
      /^pg($|\/)/,
      /^zod($|\/)/,
      /^zod-to-json-schema($|\/)/,
      // The TypeScript compiler is wiki-mcp's TS/JS analyzer parser (structured-content
      // §6.2) — heavy + version-sensitive, kept EXTERNAL here too so the 8 MB compiler
      // loads from node_modules at runtime rather than bloating dist (§4/§13).
      /^typescript($|\/)/,
    ],
  },
  sourcemap: true,
  clean: true,
  dts: false,
});
