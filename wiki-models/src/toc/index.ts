/**
 * The `toc` bundle: a single page type — a generated, curatable Table Of Contents of a
 * page's children (see ./toc.ts). Default-exports the page-type array the `ModelRegistry`
 * loader expects (wiki-mcp ADR-M6); the named export is convenient for source consumers.
 */
export { Toc } from "./toc";

import { Toc } from "./toc";

/** All page types in the `toc` bundle, ready to pass to `createWiki`. */
export const tocPageTypes = [Toc] as const;

export default tocPageTypes;
