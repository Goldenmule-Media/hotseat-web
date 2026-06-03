/**
 * Built-in analyzer registration (wiki-mcp §6.2/§7). Constructs a {@link LanguageRegistry}
 * seeded with the in-tree analyzers (the TS/JS one mirrors the ModelRegistry's built-in
 * default), so the symbol-index projector resolves `get(lang)` synchronously for the
 * languages it covers. Out-of-tree analyzers may still register a lazy specifier and load
 * via `LanguageRegistry.load`.
 */
import { LanguageRegistry, type AnalyzerLoader } from "../language-registry.js";
import { typescriptAnalyzer } from "./typescript.js";

/**
 * Build a {@link LanguageRegistry} with every built-in analyzer registered. The TS/JS
 * analyzer covers `ts` / `tsx` / `js` / `jsx` / `mjs` / `cjs` (plus the `typescript` /
 * `javascript` aliases). `loader` is forwarded for lazy out-of-tree analyzers.
 */
export function createLanguageRegistry(loader?: AnalyzerLoader): LanguageRegistry {
  const registry = new LanguageRegistry(loader);
  registry.registerAnalyzer(typescriptAnalyzer);
  return registry;
}

export { typescriptAnalyzer } from "./typescript.js";
