/**
 * Worked-example feature page types. Re-exports the four page types and a
 * convenience array for `createWiki({ pageTypes })`.
 */
export { FeatureBrief } from "./feature-brief";
export { ImplementationPlan } from "./implementation-plan";
export { TestingPlan } from "./testing-plan";
export { FeatureSpec } from "./feature-spec";

import { FeatureBrief } from "./feature-brief";
import { ImplementationPlan } from "./implementation-plan";
import { TestingPlan } from "./testing-plan";
import { FeatureSpec } from "./feature-spec";

/** All four worked-example page types, ready to pass to `createWiki`. */
export const featurePageTypes = [
  FeatureBrief,
  ImplementationPlan,
  TestingPlan,
  FeatureSpec,
] as const;

/**
 * Default export = the bundle's page-type array, the contract the `ModelRegistry` loader
 * expects (wiki-mcp ADR-M6). Keeping the named `featurePageTypes` too is convenient for
 * source consumers (the engine tests).
 */
export default featurePageTypes;
