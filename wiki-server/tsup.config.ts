import { defineConfig } from "tsup";

/**
 * Build a SELF-CONTAINED, runnable `dist/main.js` (DESIGN §10). `wiki-server` hosts
 * `wiki-mcp` (which embeds the `wiki` engine); both are consumed as TS *source*, so
 * tsup (esbuild) **bundles them in from source** and keeps the npm deps **external** so
 * the native/WASM ones (the lmdb-backed `@durable-streams/server`, PGlite, pg) load from
 * `node_modules` at runtime. Dev (typecheck/test) is unchanged — it resolves the
 * workspace packages to source via `Bundler` resolution / vitest.
 */
export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  bundle: true,
  // Inline the hosted module + engine (consumed as source); everything else external.
  noExternal: ["wiki", "wiki-mcp"],
  external: [
    /^@durable-streams\//,
    /^@electric-sql\//,
    /^@modelcontextprotocol\//,
    /^kysely($|\/)/,
    /^pg($|\/)/,
    /^zod($|\/)/,
    /^zod-to-json-schema($|\/)/,
  ],
  // The package `bin` is `dist/main.js`; tsup prepends the shebang.
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: true,
  clean: true,
  dts: false,
});
