/**
 * Worked-example feature page types (BUILD_NOTES §6, DESIGN §13). Re-exports the
 * five page types and a convenience array for `createWiki({ pageTypes })`.
 */
export { FeatureBrief } from "./feature-brief";
export { ImplementationPlan } from "./implementation-plan";
export { ImplementationChecklist } from "./implementation-checklist";
export { TestingPlan } from "./testing-plan";
export { FeatureSpec } from "./feature-spec";

import { FeatureBrief } from "./feature-brief";
import { ImplementationPlan } from "./implementation-plan";
import { ImplementationChecklist } from "./implementation-checklist";
import { TestingPlan } from "./testing-plan";
import { FeatureSpec } from "./feature-spec";

/** All five worked-example page types, ready to pass to `createWiki`. */
export const featurePageTypes = [
  FeatureBrief,
  ImplementationPlan,
  ImplementationChecklist,
  TestingPlan,
  FeatureSpec,
] as const;

/**
 * Default export = the bundle's page-type array, the contract the `ModelRegistry` loader
 * expects (wiki-mcp ADR-M6). Keeping the named `featurePageTypes` too is convenient for
 * source consumers (the engine tests).
 */
export default featurePageTypes;
