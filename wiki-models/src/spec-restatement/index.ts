/**
 * Spec-restatement bundle: an AI-drafted spec whose sections a human verifies by
 * restating them in their own words, then a holistic AI review and a human approve gate.
 */
export { SpecRestatement } from "./spec-restatement";

import { SpecRestatement } from "./spec-restatement";

/** The bundle's page types, ready to pass to `createWiki`. */
export const specRestatementPageTypes = [SpecRestatement] as const;

/**
 * Default export = the bundle's page-type array, the contract the `ModelRegistry` loader
 * expects (wiki-mcp ADR-M6).
 */
export default specRestatementPageTypes;
