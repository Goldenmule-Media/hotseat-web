/**
 * Display-label helpers. The friendly default title for a
 * page is its type def's `label`, falling back to a deterministic title-cased type id.
 * Pure and locale-INDEPENDENT (no `toLocale*`) so it respects the engine's
 * byte-identical-render rule.
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

/** The handful of named HTML entities a title realistically arrives pre-escaped with. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Decode HTML entities in a page title so a title authored as `"Build &amp; Distribution"`
 * is stored canonically as `"Build & Distribution"`. Titles are plain text, never markup —
 * an entity in one is always an upstream escaping accident (e.g. a title lifted out of
 * rendered markdown, where `&` shows as `&amp;`). Normalizing on write keeps the persisted
 * event, the rendered H1, and every read byte-clean.
 *
 * Conservative and deterministic: only well-formed named entities from {@link NAMED_ENTITIES}
 * and numeric (`&#38;` / `&#x26;`) references are decoded — a bare `&` (`"AT&T"`) or an
 * unrecognized `&foo;` is left exactly as typed. A single pass (not a fixpoint) mirrors the
 * single level of escaping these accidents introduce.
 */
export function decodeTitleEntities(title: string): string {
  return title.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.charCodeAt(0) === 35 /* '#' */) {
      const cp =
        body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88 /* 'x'/'X' */
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return match;
      try {
        return String.fromCodePoint(cp);
      } catch {
        return match;
      }
    }
    const decoded = NAMED_ENTITIES[body.toLowerCase()];
    return decoded ?? match;
  });
}
