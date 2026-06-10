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

import type { IBundleSkillDecl, IPageType } from "wiki/authoring";

/** The page-type defs a bundle contributes (what the engine `Registry` consumes). */
export type PageTypeSet = readonly IPageType[];

/** The Claude skills a bundle declares it ships with (a named `skills` export). */
export type SkillSet = readonly IBundleSkillDecl[];

/** A loaded bundle's page-type defs + declared skills plus the resolved URL (for logging). */
export interface LoadedBundle {
  readonly pageTypes: PageTypeSet;
  /** Skills the bundle declares via a named `skills` export; `[]` when absent. */
  readonly skills: SkillSet;
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

/** The string fields every skill declaration must carry. */
const SKILL_REQUIRED = ["name", "description", "plugin", "marketplace", "marketplaceSource"] as const;

/**
 * Pull the OPTIONAL `skills` named export from a loaded module. Absent → `[]`; present
 * but malformed → a descriptive contract error (same style as {@link extractPageTypes}).
 */
function extractSkills(mod: Record<string, unknown>, spec: string): SkillSet {
  const candidate = mod.skills;
  if (candidate === undefined) return [];
  if (!Array.isArray(candidate)) {
    throw new Error(`model bundle "${spec}" has a \`skills\` export that is not an array (got ${typeof candidate})`);
  }
  for (const [i, entry] of candidate.entries()) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`model bundle "${spec}" skills[${i}] must be an object (got ${typeof entry})`);
    }
    const skill = entry as Record<string, unknown>;
    for (const key of SKILL_REQUIRED) {
      if (typeof skill[key] !== "string" || skill[key] === "") {
        throw new Error(`model bundle "${spec}" skills[${i}] is missing the string field "${key}"`);
      }
    }
    if (skill.command !== undefined && typeof skill.command !== "string") {
      throw new Error(`model bundle "${spec}" skills[${i}].command must be a string when present`);
    }
  }
  return candidate as SkillSet;
}

/** Dynamically import a model bundle and return its page-type defs + declared skills. */
export async function loadModelBundle(spec: string, cacheBust?: string): Promise<LoadedBundle> {
  const url = toImportUrl(spec, cacheBust);
  const mod = (await import(url)) as Record<string, unknown>;
  return { pageTypes: extractPageTypes(mod, spec), skills: extractSkills(mod, spec), url };
}
