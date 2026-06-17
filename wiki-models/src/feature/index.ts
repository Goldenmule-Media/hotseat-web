/**
 * Worked-example feature page types. Re-exports the four page types and a
 * convenience array for `createWiki({ pageTypes })`.
 */
import type { IBundleSkillDecl } from "wiki/authoring";

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
 * The Claude skills this bundle ships with (the loader's OPTIONAL named `skills` export).
 * Points at the existing `hotseat` plugin — the repo root is its own marketplace
 * (`.claude-plugin/marketplace.json`); the skill files live in `plugins/hotseat`.
 */
export const skills: readonly IBundleSkillDecl[] = [
  {
    name: "plan-feature",
    description:
      "Ground, author, and review a build-ready feature plan in the hotseat structured wiki, then stop (no code).",
    plugin: "hotseat",
    marketplace: "hotseat",
    marketplaceSource: "Goldenmule-Media/hotseat-web",
    command: "/plan-feature",
  },
  {
    name: "build-feature",
    description: "Agentic, FSM-gated feature builds driven by the hotseat structured wiki.",
    plugin: "hotseat",
    marketplace: "hotseat",
    marketplaceSource: "Goldenmule-Media/hotseat-web",
    command: "/build-feature",
  },
];

/**
 * Default export = the bundle's page-type array, the contract the `ModelRegistry` loader
 * expects (wiki-mcp ADR-M6). Keeping the named `featurePageTypes` too is convenient for
 * source consumers (the engine tests).
 */
export default featurePageTypes;
