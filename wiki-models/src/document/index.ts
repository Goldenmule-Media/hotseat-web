/**
 * General-purpose `document` bundle: one lifecycle-free page type whose entire content
 * is an ordered list of blocks. Re-exports the type and the array `createWiki` expects.
 */
export { Document } from "./document";

import { Document } from "./document";

/** The bundle's page types, ready to pass to `createWiki`. */
export const documentPageTypes = [Document] as const;

/**
 * Default export = the bundle's page-type array, the contract the `ModelRegistry` loader
 * expects (wiki-mcp ADR-M6). The named `documentPageTypes` stays for source consumers.
 */
export default documentPageTypes;
