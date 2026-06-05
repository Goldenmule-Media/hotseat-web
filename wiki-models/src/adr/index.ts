/**
 * The `adr` bundle: one page type — `decision-record` (human label "ADR"), an Architecture
 * Decision Record as a first-class, FSM-governed wiki page (see ./adr.ts). Default-exports the
 * page-type array the `ModelRegistry` loader expects (wiki-mcp ADR-M6); the named export is
 * convenient for source consumers (the engine tests).
 */
export { DecisionRecord } from "./adr";

import { DecisionRecord } from "./adr";

/** All page types in the `adr` bundle, ready to pass to `createWiki`. */
export const adrPageTypes = [DecisionRecord] as const;

export default adrPageTypes;
