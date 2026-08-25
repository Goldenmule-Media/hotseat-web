/**
 * Engagement page types. Re-exports the `engagement-log` page type and the
 * default-exported bundle array the `ModelRegistry` loader expects.
 */
export { EngagementLog } from "./engagement-log";

import { EngagementLog } from "./engagement-log";

/** The bundle's page types, ready to pass to `createWiki`. */
export const engagementPageTypes = [EngagementLog] as const;

/** Default export = the bundle's page-type array (the loader contract, wiki-mcp ADR-M6). */
export default engagementPageTypes;
