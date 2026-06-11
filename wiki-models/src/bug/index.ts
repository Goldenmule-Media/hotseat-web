/**
 * Bug-tracking page types. Re-exports the `bug-report` page type and the
 * default-exported bundle array the `ModelRegistry` loader expects.
 */
export { BugReport } from "./bug-report";

import { BugReport } from "./bug-report";

/** The bundle's page types, ready to pass to `createWiki`. */
export const bugPageTypes = [BugReport] as const;

/** Default export = the bundle's page-type array (the loader contract, wiki-mcp ADR-M6). */
export default bugPageTypes;
