/**
 * Dynamic model-bundle loader (wiki-mcp ADR-M6). Loads a built model bundle — ESM with
 * the engine inlined — by path and returns its page-type defs.
 *
 * To HOT-RELOAD edited code, each load appends a cache-busting query (`?v=<token>`) to the
 * module URL: a plain `import()` of the same path returns Node's CACHED module, so the
 * query string is the whole trick that makes a rebuild actually take effect. Trade-off:
 * old module instances leak until GC — acceptable for a local/dev reload loop.
 */
import { isAbsolute, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import type { IPageType } from "wiki/authoring";

/** The page-type defs a bundle contributes (what the engine `Registry` consumes). */
export type PageTypeSet = readonly IPageType[];

/** A loaded bundle's page-type defs plus the resolved URL (for logging). */
export interface LoadedBundle {
  readonly pageTypes: PageTypeSet;
  readonly url: string;
}

/**
 * Resolve `spec` to an importable URL. A filesystem path (absolute or `./`-relative) or a
 * `file:` URL is **cache-busted** with `?v=<token>`; a bare package specifier is imported
 * as-is (a bare specifier can't carry a query, so it cannot hot-reload).
 */
function toImportUrl(spec: string, cacheBust: string | undefined): string {
  const bust = cacheBust !== undefined ? `?v=${cacheBust}` : "";
  if (spec.startsWith("file:")) return `${spec}${bust}`;
  if (spec.startsWith(".") || isAbsolute(spec)) return `${pathToFileURL(resolvePath(spec)).href}${bust}`;
  return spec; // bare specifier — no cache-busting
}

/** Pull the page-type array from a loaded module: the default export, else a `pageTypes` named export. */
function extractPageTypes(mod: Record<string, unknown>, spec: string): PageTypeSet {
  const candidate = mod.default ?? mod.pageTypes;
  if (!Array.isArray(candidate)) {
    throw new Error(
      `model bundle "${spec}" must default-export an array of page types (got ${typeof candidate})`,
    );
  }
  return candidate as PageTypeSet;
}

/** Dynamically import a model bundle and return its page-type defs. */
export async function loadModelBundle(spec: string, cacheBust?: string): Promise<LoadedBundle> {
  const url = toImportUrl(spec, cacheBust);
  const mod = (await import(url)) as Record<string, unknown>;
  return { pageTypes: extractPageTypes(mod, spec), url };
}
