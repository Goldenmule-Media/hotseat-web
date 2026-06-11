/**
 * Public **authoring API** for page-type plugins. External schema packages —
 * `wiki-models` and any third-party model bundle — author page types against THIS
 * surface only, never the engine's internal module paths.
 *
 * Re-exports: the declarative combinators (`definePageType`/`t`/`arg`), the Zod
 * schema adapter (`zodSchema`/`z`), the `InvariantViolationError`, and the engine's
 * public TYPE vocabulary. Authors no longer write `apply`/`render`/`produces`, so the
 * determinism render helpers are NOT re-exported (the render read model owns them).
 */
export { definePageType, t, arg } from "./core/define";
export { zodSchema, z } from "./schema/zod-adapter";
export { InvariantViolationError, WikiError } from "./core/errors";
// Inline-Markdown → canonical inline runs, for building `blocks`-field text. A text leaf
// rejects significant Markdown (it must be reified); this parser does the reification, so a
// model command can accept a plain Markdown string and store structured runs. See core/inline-md.
export { parseInline } from "./core/inline-md";
// Re-export the engine's public TYPE vocabulary (types only — no runtime cost) so an
// authored bundle's INFERRED export types are all nameable through `wiki/authoring`.
export type * from "./api";
