/**
 * Pure canonicalization helpers for deterministic Markdown rendering. Equal input →
 * byte-identical output. No wall clock, no randomness,
 * no external lookups — every function here is a total, pure transform of its arguments.
 *
 * Formatting contract: fixed heading levels, `\n` line endings, a single
 * blank line between blocks, exactly one trailing newline, no trailing whitespace.
 */

/**
 * Join rendered blocks into one document. Empty/blank-only blocks are dropped, the rest
 * are separated by exactly one blank line, and the result ends with exactly one trailing
 * newline character. An all-empty input yields "" (no spurious newline).
 */
export function joinBlocks(blocks: string[]): string {
  const kept = blocks
    // Trim trailing whitespace/newlines so the inter-block spacing is canonical, then drop empties.
    .map((b) => b.replace(/\s+$/, ""))
    .filter((b) => b.length > 0);
  if (kept.length === 0) return "";
  return kept.join("\n\n") + "\n";
}

/**
 * A Markdown ATX heading at `level` (1–6, clamped) with collapsed surrounding whitespace,
 * e.g. `heading(2, "Summary")` → `"## Summary"`.
 */
export function heading(level: number, text: string): string {
  const clamped = Math.min(6, Math.max(1, Math.trunc(level)));
  return "#".repeat(clamped) + " " + text.trim();
}

/**
 * A section block: a heading immediately followed by its body on the next line
 * (no blank line between them), e.g. `section("## Summary", "Text.")` →
 * `"## Summary\nText."`. Sections are emitted as a SINGLE block so {@link joinBlocks}
 * places the canonical blank line BETWEEN sections, never between a heading and its
 * body. An empty body falls back to a {@link placeholder}.
 */
export function section(headingLine: string, body: string): string {
  const content = body.length > 0 ? body : placeholder();
  return `${headingLine}\n${content}`;
}

/** A single unordered list item, e.g. `bullet("web-app")` → `"- web-app"`. */
export function bullet(text: string): string {
  return "- " + text;
}

/**
 * An unordered list block: one `- ` item per line in the given order. Returns "" for an
 * empty list so callers can fall back to a {@link placeholder}.
 */
export function bulletList(items: string[]): string {
  return items.map((i) => bullet(i)).join("\n");
}

/**
 * An ordered list block: `1. `, `2. `, … in the given order. Returns "" for an empty list
 * so callers can fall back to a {@link placeholder}.
 */
export function numbered(items: string[]): string {
  return items.map((item, i) => `${i + 1}. ${item}`).join("\n");
}

/**
 * Canonical status badge line, e.g. `statusBadge("building")` → `"**Status:** building"`.
 */
export function statusBadge(status: string): string {
  return `**Status:** ${status}`;
}

/**
 * Placeholder for an empty/optional section so diffs stay local.
 * Defaults to `_None._`.
 */
export function placeholder(text: string = "_None._"): string {
  return text;
}

/**
 * Return a new array sorted by a string key, stably and deterministically: equal keys
 * preserve their original (insertion) order. Does not mutate the input. Keys are compared
 * with a fixed code-unit ordering (no locale, so output is reproducible everywhere).
 */
export function stableBy<T>(arr: readonly T[], keyFn: (item: T) => string): T[] {
  return arr
    .map((item, index) => ({ item, index, key: keyFn(item) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index))
    .map((entry) => entry.item);
}
