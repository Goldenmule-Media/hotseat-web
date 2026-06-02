import { defineConfig } from "tsup";

/**
 * Build a SELF-CONTAINED, runnable `dist/main.js` (DESIGN §10). `wiki-mcp` embeds the
 * `wiki` engine, which is consumed as TS *source* with extensionless relative imports
 * (the engine's `Bundler`-style convention), so a plain `tsc` emit would NOT run under
 * raw Node ESM. tsup (esbuild) **bundles the workspace lib in from source** — resolving
 * those extensionless imports at build time — and keeps the npm deps **external** so the
 * native/WASM ones (PGlite, pg, the lmdb-backed `@durable-streams` server) load from
 * `node_modules` at runtime rather than being inlined. Dev (typecheck/test) is unchanged:
 * it still resolves the workspace packages to source via `Bundler` resolution / vitest.
 */
export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  bundle: true,
  // Inline the workspace engine (consumed as source); everything else stays external.
  noExternal: ["wiki"],
  external: [
    /^@durable-streams\//,
    /^@electric-sql\//,
    /^@modelcontextprotocol\//,
    /^kysely($|\/)/,
    /^pg($|\/)/,
    /^zod($|\/)/,
    /^zod-to-json-schema($|\/)/,
  ],
  // The package `bin` is `dist/main.js`; tsup prepends the shebang (the source has none).
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: true,
  clean: true,
  dts: false,
});
