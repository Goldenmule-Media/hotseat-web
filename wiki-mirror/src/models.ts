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
import { existsSync, readdirSync, type Dirent } from "node:fs";
import { extname, isAbsolute, join as joinPath, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import type { IPageType } from "wiki/authoring";

import type { Logger } from "./logger.js";

/** A `<bundle>/index.*` inside a source-layout directory. */
const BUNDLE_INDEX_NAMES = ["index.ts", "index.js", "index.mjs"] as const;
/** Loose bundle files in a built (flat `dist`) layout. */
const BUNDLE_FILE_EXTS = new Set([".js", ".mjs", ".ts"]);

/** One bundle found under a `--models-dir`. */
export interface DiscoveredBundle {
  /** Directory name (source layout) or file basename (built layout). */
  readonly id: string;
  /** Absolute path to import. */
  readonly specifier: string;
}

/** Resolve `spec` to an importable URL: a path/`file:` → a `file://` URL; a bare specifier as-is. */
function toImportUrl(spec: string): string {
  if (spec.startsWith("file:")) return spec;
  if (spec.startsWith(".") || isAbsolute(spec)) return pathToFileURL(resolvePath(spec)).href;
  return spec; // bare package specifier
}

/** The page-type array a module exports (default, else a `pageTypes` named export), or undefined. */
function tryExtractPageTypes(mod: Record<string, unknown>): readonly IPageType[] | undefined {
  const candidate = mod.default ?? mod.pageTypes;
  return Array.isArray(candidate) ? (candidate as readonly IPageType[]) : undefined;
}

/** Pull the page-type array from a loaded module. Throws — an EXPLICIT specifier must be a bundle. */
function extractPageTypes(mod: Record<string, unknown>, spec: string): readonly IPageType[] {
  const types = tryExtractPageTypes(mod);
  if (types === undefined) {
    throw new Error(
      `wiki-mirror: model bundle "${spec}" must default-export an array of page types (got ${typeof (mod.default ?? mod.pageTypes)})`,
    );
  }
  return types;
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

/**
 * Bundles directly under `dir`, one level deep — the same shape wiki-server's `--models-dir`
 * accepts: a source tree of `<bundle>/index.ts`, or a flat built tree of `<bundle>.js`. Sorted
 * by id so load order is deterministic. Pure: nothing is imported here.
 */
export function discoverModelBundles(dir: string): DiscoveredBundle[] {
  const root = resolvePath(dir);
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    throw new Error(
      `wiki-mirror: --models-dir "${dir}" could not be read (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const found: DiscoveredBundle[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      const index = BUNDLE_INDEX_NAMES.map((n) => joinPath(root, entry.name, n)).find((p) => existsSync(p));
      if (index !== undefined) found.push({ id: entry.name, specifier: index });
      continue;
    }
    const ext = extname(entry.name);
    if (!BUNDLE_FILE_EXTS.has(ext) || entry.name.endsWith(".d.ts")) continue;
    found.push({ id: entry.name.slice(0, -ext.length), specifier: joinPath(root, entry.name) });
  }
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Load every bundle discovered under `dir`, TOLERANTLY: a built tree also contains shared
 * chunks that are not bundles, and one unloadable file must not cost the whole schema. Each
 * failure is warned and skipped — unlike an explicit `models` entry, which is a hard error.
 */
export async function loadModelsDir(dir: string, logger: Logger): Promise<IPageType[]> {
  const all: IPageType[] = [];
  for (const bundle of discoverModelBundles(dir)) {
    try {
      const mod = (await import(toImportUrl(bundle.specifier))) as Record<string, unknown>;
      const types = tryExtractPageTypes(mod);
      if (types === undefined) {
        // Expected, not a problem: a built tree is full of shared chunks that are not bundles.
        logger.info("wiki-mirror: ignored a file that is not a model bundle", { id: bundle.id });
        continue;
      }
      all.push(...types);
    } catch (err) {
      logger.warn("wiki-mirror: skipped an unloadable discovered bundle", {
        id: bundle.id,
        specifier: bundle.specifier,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return all;
}

/** Merge two page-type sets, keeping the FIRST definition of a type and warning on collisions. */
export function dedupePageTypes(types: readonly IPageType[], logger: Logger): IPageType[] {
  const byType = new Map<string, IPageType>();
  for (const type of types) {
    const id = type.__def.type;
    if (byType.has(id)) {
      logger.warn("wiki-mirror: ignoring a duplicate page type", { type: id });
      continue;
    }
    byType.set(id, type);
  }
  return [...byType.values()];
}
