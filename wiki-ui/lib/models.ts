/**
 * Configured page-type bundles (Q6). In a client-side app the model bundle must be
 * resolvable at BUILD time — there is no Node-style runtime `import()` of an arbitrary
 * specifier in the browser — so we static-import the bundle here. To support more
 * schemas, add their static imports and concat them into `pageTypes`.
 */
import type { IPageType } from "wiki";
import featurePageTypes from "wiki-models/feature";

export const pageTypes: readonly IPageType[] = [...featurePageTypes];
