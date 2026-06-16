/**
 * Security-review bundle: a single page type modeling a living security/architecture audit
 * whose emitted Markdown shows only OPEN findings, renumbered at render time, with internal
 * cross-references that renumber with them.
 */
export { SecurityReview } from "./security-review";

import { SecurityReview } from "./security-review";

/** The bundle's page types, ready to pass to `createWiki`. */
export const securityPageTypes = [SecurityReview] as const;

/**
 * Default export = the bundle's page-type array, the contract the `ModelRegistry` loader
 * expects (wiki-mcp ADR-M6).
 */
export default securityPageTypes;
