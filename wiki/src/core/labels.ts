/**
 * Display-label helpers (feature-review.md Item 4). The friendly default title for a
 * page is its type def's `label`, falling back to a deterministic title-cased type id.
 * Pure and locale-INDEPENDENT (no `toLocale*`) so it respects the engine's
 * byte-identical-render rule (§10).
 */

/**
 * Title-case a type id for display: hyphens become spaces and the first character is
 * upper-cased — `"implementation-plan"` → `"Implementation plan"`. Sentence case (not
 * Word Case) keeps multi-word type ids reading naturally as a heading.
 */
export function titleCase(typeId: string): string {
  const spaced = typeId.replace(/-/g, " ");
  return spaced.length === 0 ? spaced : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
