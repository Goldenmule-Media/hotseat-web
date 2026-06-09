/**
 * Configured page-type bundles (Q6). In a client-side app the model bundle must be
 * resolvable at BUILD time — there is no Node-style runtime `import()` of an arbitrary
 * specifier in the browser — so we static-import the bundle here. To support more
 * schemas, add their static imports and concat them into `pageTypes`.
 */
import type { IPageType } from "wiki";
import adrPageTypes from "wiki-models/adr";
import architecturePageTypes from "wiki-models/architecture";
import featurePageTypes from "wiki-models/feature";
import tocPageTypes from "wiki-models/toc";

export const pageTypes: readonly IPageType[] = [
  ...featurePageTypes,
  ...tocPageTypes,
  ...architecturePageTypes,
  ...adrPageTypes,
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
