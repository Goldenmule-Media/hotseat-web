/**
 * Configured page-type bundles (Q6). In a client-side app the model bundle must be
 * resolvable at BUILD time — there is no Node-style runtime `import()` of an arbitrary
 * specifier in the browser — so we static-import the bundle here. To support more
 * schemas, add their static imports and concat them into `pageTypes`.
 */
import type { IPageType, IPageTypeDef } from "wiki";
import adrPageTypes from "wiki-models/adr";
import architecturePageTypes from "wiki-models/architecture";
import bugPageTypes from "wiki-models/bug";
import documentPageTypes from "wiki-models/document";
import featurePageTypes from "wiki-models/feature";
import tocPageTypes from "wiki-models/toc";

export const pageTypes: readonly IPageType[] = [
  ...featurePageTypes,
  ...tocPageTypes,
  ...architecturePageTypes,
  ...adrPageTypes,
  ...documentPageTypes,
  ...bugPageTypes,
];

/**
 * Types whose render config opts OUT of the engine's auto-appended child-pages section
 * (`render.graphSections === false`) — i.e. they render their own curated child list in
 * the body (the `toc` type's "Contents"). The UI reads this model-declared signal
 * generically and suppresses its own "Child pages" navigation strip for such pages, so a
 * curated TOC isn't shadowed by a raw, duplicate list. No type name is hardcoded.
 */
export const typesRenderingOwnChildren: ReadonlySet<string> = new Set(
  pageTypes.filter((t) => t.__def.render.graphSections === false).map((t) => t.__def.type),
);

/**
 * The full page-type definition (sections / fields / `mutableIn`) for a type, or `null` for an
 * unknown/undefined type. Synchronous and safe in render — the bundles are static-imported above,
 * so `__def` is already in tab memory and needs no worker round-trip (the schema inspector reads it
 * directly, the way {@link typesRenderingOwnChildren} reads `render.graphSections`).
 */
export function defOf(type: string | undefined): IPageTypeDef | null {
  if (type === undefined) return null;
  return pageTypes.find((t) => t.__def.type === type)?.__def ?? null;
}
