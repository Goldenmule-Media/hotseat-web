/**
 * Article bundle: notes taken on one article, plus the summary written afterwards.
 */
export { ArticleNotes } from "./article-notes";

import { ArticleNotes } from "./article-notes";

/** The bundle's page types, ready to pass to `createWiki`. */
export const articlePageTypes = [ArticleNotes] as const;

/**
 * Default export = the bundle's page-type array, the contract the `ModelRegistry`
 * loader expects (wiki-mcp ADR-M6).
 */
export default articlePageTypes;
