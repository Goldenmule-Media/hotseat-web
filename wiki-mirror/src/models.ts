/**
 * Slim model-bundle loader. Dynamically `import()`s each bundle specifier (a built model
 * bundle — ESM with the engine inlined — addressed by package specifier, file path, or
 * `file:` URL) and flattens their page-type defs into the array the engine `Registry`
 * consumes. Keeps `wiki-mirror` schema-agnostic: it carries no concrete page types, exactly
 * like wiki-server resolving `--models` at boot.
 *
 * Unlike wiki-mcp's loader there is no cache-busting / hot-reload: the mirror reads its model
 * set once at startup and is restarted to change it.
 */
import { isAbsolute, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import type { IPageType } from "wiki/authoring";

/** Resolve `spec` to an importable URL: a path/`file:` → a `file://` URL; a bare specifier as-is. */
function toImportUrl(spec: string): string {
  if (spec.startsWith("file:")) return spec;
  if (spec.startsWith(".") || isAbsolute(spec)) return pathToFileURL(resolvePath(spec)).href;
  return spec; // bare package specifier
}

/** Pull the page-type array from a loaded module: the default export, else a `pageTypes` named export. */
function extractPageTypes(mod: Record<string, unknown>, spec: string): readonly IPageType[] {
  const candidate = mod.default ?? mod.pageTypes;
  if (!Array.isArray(candidate)) {
    throw new Error(
      `wiki-mirror: model bundle "${spec}" must default-export an array of page types (got ${typeof candidate})`,
    );
  }
  return candidate as readonly IPageType[];
}

/** Dynamically import every model-bundle specifier and return their combined page-type defs. */
export async function loadModels(specs: readonly string[]): Promise<IPageType[]> {
  const all: IPageType[] = [];
  for (const spec of specs) {
    const mod = (await import(toImportUrl(spec))) as Record<string, unknown>;
    all.push(...extractPageTypes(mod, spec));
  }
  return all;
}
