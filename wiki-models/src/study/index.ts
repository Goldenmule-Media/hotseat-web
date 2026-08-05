/**
 * Study bundle: reading notes plus a glossary the notes feed — terms marked, defined in
 * the human's own words, and evaluated by an async AI critic.
 */
export { StudyNotes } from "./study-notes";

import { StudyNotes } from "./study-notes";

/** The bundle's page types, ready to pass to `createWiki`. */
export const studyPageTypes = [StudyNotes] as const;

/**
 * Default export = the bundle's page-type array, the contract the `ModelRegistry` loader
 * expects (wiki-mcp ADR-M6).
 */
export default studyPageTypes;
