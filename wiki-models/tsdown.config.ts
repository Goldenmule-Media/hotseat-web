import { defineConfig } from "tsdown";

/**
 * Build each model bundle to a SELF-CONTAINED, runtime-loadable ESM file under `dist/`
 * (wiki-models/DESIGN.md §5, wiki-mcp ADR-M6). A bundle is authored against `wiki`'s
 * public authoring API (consumed as TS *source* with extensionless imports), so tsdown
 * (Rolldown) **inlines the engine authoring code from source** and emits a stand-alone
 * `dist/<bundle>.js` that `wiki-mcp`'s `ModelRegistry` can `import()` at runtime.
 *
 * The `alwaysBundle` regex (not a bare string) is REQUIRED so subpath exports like
 * `wiki/authoring` are inlined; left external, Node would load the engine's extensionless
 * TS source at runtime (ERR_MODULE_NOT_FOUND).
 */
export default defineConfig({
  // One named entry per bundle → `dist/feature.js`, `dist/toc.js`, etc.
  entry: {
    feature: "src/feature/index.ts",
    toc: "src/toc/index.ts",
    architecture: "src/architecture/index.ts",
    adr: "src/adr/index.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node20",
  outExtensions: () => ({ js: ".js" }),
  deps: { alwaysBundle: [/^wiki(\/|$)/] },
  sourcemap: true,
  clean: true,
  dts: false,
});
