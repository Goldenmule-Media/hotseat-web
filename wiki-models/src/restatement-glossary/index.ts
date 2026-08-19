/**
 * Restatement-glossary bundle: a standalone glossary page — terms marked, defined in the
 * human's own words, and evaluated by an async AI critic.
 */
export { RestatementGlossary } from "./restatement-glossary";

import { RestatementGlossary } from "./restatement-glossary";

/** The bundle's page types, ready to pass to `createWiki`. */
export const restatementGlossaryPageTypes = [RestatementGlossary] as const;

/**
 * Default export = the bundle's page-type array, the contract the `ModelRegistry` loader
 * expects (wiki-mcp ADR-M6).
 */
export default restatementGlossaryPageTypes;
