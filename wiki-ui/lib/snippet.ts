/**
 * Pure helpers for engine search snippets — no engine/DOM imports, so they're trivially
 * unit-testable and safe to pull into any layer. The engine's `ts_headline` wraps matched
 * terms in `**` (StartSel/StopSel — see SqlSearchIndex); these turn that into render
 * segments and into scroll-to-match candidate terms.
 */

export interface SnippetSegment {
  readonly text: string;
  readonly hit: boolean;
}

/**
 * Split a snippet into plain / highlighted segments. Even chunks (between `**` pairs) are
 * context, odd chunks are matches. Empty chunks (adjacent markers / leading match) are
 * dropped. Rendered as text nodes by React, so no escaping is needed.
 */
export function parseSnippet(snippet: string): readonly SnippetSegment[] {
  const parts = snippet.split("**");
  const segments: SnippetSegment[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "") continue;
    segments.push({ text: parts[i], hit: i % 2 === 1 });
  }
  return segments;
}

/**
 * Ordered candidate strings to locate in the destination page for scroll-to-match. The
 * snippet's highlighted terms come first (they are exact substrings of the rendered body,
 * so the most reliable target), then the raw query tokens as a fallback (a prefix query
 * like "concur" still finds "concurrency" by substring). Deduped (case-insensitive),
 * length ≥ 2.
 */
export function extractTerms(snippet: string, query: string): string[] {
  const fromSnippet = parseSnippet(snippet)
    .filter((s) => s.hit)
    .map((s) => s.text.trim());
  const fromQuery = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim());
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of [...fromSnippet, ...fromQuery]) {
    const key = term.toLowerCase();
    if (term.length < 2 || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}
