/**
 * Public **authoring API** for page-type plugins (DESIGN §16). External schema
 * packages — `wiki-models` and any third-party model bundle — author page/item types
 * against THIS surface only, never the engine's internal module paths, so the engine
 * stays free to refactor internals behind a stable authoring contract.
 *
 * Re-exports: the type-definition combinators (`definePageType`/`defineItemType`/`t`),
 * the Zod schema adapter (`zodSchema`/`z`), the deterministic render helpers, the
 * `InvariantViolationError` an `apply` raises for cross-field/cross-page gates, and the
 * types an `apply`/`render` signature needs.
 */
export { definePageType, defineItemType, t } from "./core/define";
export { zodSchema, z } from "./schema/zod-adapter";
export * from "./render/determinism";
export { InvariantViolationError, WikiError } from "./core/errors";
// Re-export the engine's public TYPE vocabulary (types only — no runtime cost) so an
// authored bundle's INFERRED export types — `IPageType<…>` and the api types nested
// inside it (apply/render contexts, command maps, …) — are all nameable through
// `wiki/authoring`. Without this, a bundle hits TS2742 ("inferred type cannot be named
// without a reference to wiki/src/api"), since the deep `wiki/src/api` path is not public.
export type * from "./api";
