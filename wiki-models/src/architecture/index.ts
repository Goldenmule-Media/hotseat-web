/**
 * The `architecture` bundle: one page type — a node in a typed graph describing the codebase
 * (see ./architecture.ts). Default-exports the page-type array the `ModelRegistry` loader
 * expects (wiki-mcp ADR-M6); the named export is convenient for source consumers.
 */
export { Architecture } from "./architecture";

import { Architecture } from "./architecture";

/** All page types in the `architecture` bundle, ready to pass to `createWiki`. */
export const architecturePageTypes = [Architecture] as const;

export default architecturePageTypes;
