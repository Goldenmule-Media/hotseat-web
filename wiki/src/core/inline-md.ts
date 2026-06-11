/**
 * Inline-Markdown parser — the INVERSE of `render/blocks.ts`'s `renderInline`.
 *
 * A `blocks`-field text leaf must hold no significant Markdown (so the stored AST is
 * canonical and `render` is an injective projection — see `ingestion.ts`). Rather than
 * make every author hand-build structured runs, this reifies a deliberate CommonMark
 * SUBSET into the closed inline vocabulary at authoring time:
 *   - `` `code` ``           → `{ kind: "code-span" }`
 *   - `*x*` / `_x_`          → a text run with an `emphasis` mark
 *   - `**x**` / `__x__`      → a text run with a `strong` mark
 *   - `[label](href)`        → the label's runs, each carrying a `link` mark
 *   - everything else        → plain text runs
 *
 * Emphasis follows CommonMark flanking + the intraword-`_` restriction, so an identifier
 * like `import_etc2_astc` stays literal text (NOT emphasis) and a bare `2 * 3` stays
 * literal — exactly the cases a blunt character ban used to reject. The parser is the
 * single source of truth for "what is significant Markdown": {@link isInertText} (used by
 * the leaf validator) is defined as "parses back to itself", so render-verbatim → reparse
 * is a fixed point.
 *
 * Deliberately OUT of this v1 subset (treated as literal text): backslash escapes, images,
 * autolinks, raw HTML, nested links, and marks ON a code span (the inline model gives a
 * `code-span` no marks). Pure + deterministic — no clock/RNG — so it is safe in `produces`
 * and on the validation path.
 */
import type { IInline, Mark } from "../api";

// ASCII punctuation (CommonMark's ascii-punctuation set) — used for flanking decisions.
const PUNCT = /[!-/:-@[-`{-~]/;

function isWhitespaceOrEdge(ch: string): boolean {
  return ch === "" || /\s/.test(ch);
}
function isPunct(ch: string): boolean {
  return ch !== "" && PUNCT.test(ch);
}

// ── Token model ─────────────────────────────────────────────────────────────

interface TextTok {
  t: "text";
  value: string;
  marks: Mark[];
}
interface CodeTok {
  t: "code";
  value: string;
}
/** A finished link: its label already parsed to inlines; an enclosing emphasis adds marks. */
interface LinkTok {
  t: "link";
  children: IInline[];
  href: string;
}
/** A run of `*` or `_` delimiters, not yet paired. `count` is decremented as it is consumed. */
interface DelimTok {
  t: "delim";
  ch: "*" | "_";
  count: number;
  canOpen: boolean;
  canClose: boolean;
}
type Tok = TextTok | CodeTok | LinkTok | DelimTok;

// ── Phase 1: scan into tokens (code spans + links greedily; emphasis as delimiters) ──

/** Length of the backtick run starting at `i`. */
function backtickRun(text: string, i: number): number {
  let n = 0;
  while (text[i + n] === "`") n++;
  return n;
}

/** CommonMark code-span content normalization: strip ONE leading+trailing space when the
 *  content both begins and ends with a space and is not made up solely of spaces. */
function normalizeCodeSpan(raw: string): string {
  if (raw.length >= 2 && raw.startsWith(" ") && raw.endsWith(" ") && raw.trim().length > 0) {
    return raw.slice(1, -1);
  }
  return raw;
}

/** Try to read `[label](href)` at `i`. Returns the link token + next index, or null. */
function tryLink(text: string, i: number): { tok: LinkTok; next: number } | null {
  // Find the matching `]` for the `[` at i, allowing balanced nested brackets in the label.
  let depth = 0;
  let j = i;
  for (; j < text.length; j++) {
    const c = text[j];
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (j >= text.length || text[j] !== "]") return null;
  if (text[j + 1] !== "(") return null;
  // href runs to the matching `)` (balanced parens), taken literally.
  let k = j + 2;
  let pd = 1;
  let href = "";
  for (; k < text.length; k++) {
    const c = text[k]!;
    if (c === "(") pd++;
    else if (c === ")") {
      pd--;
      if (pd === 0) break;
    }
    href += c;
  }
  if (k >= text.length || text[k] !== ")") return null;
  const label = text.slice(i + 1, j);
  if (label.length === 0) return null;
  return { tok: { t: "link", children: parseInline(label), href }, next: k + 1 };
}

function scan(text: string): Tok[] {
  const toks: Tok[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf.length > 0) {
      toks.push({ t: "text", value: buf, marks: [] });
      buf = "";
    }
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "`") {
      const n = backtickRun(text, i);
      // closing run of EXACTLY n backticks
      let j = i + n;
      let found = -1;
      while (j < text.length) {
        if (text[j] === "`") {
          const m = backtickRun(text, j);
          if (m === n) {
            found = j;
            break;
          }
          j += m;
        } else j++;
      }
      if (found >= 0) {
        flush();
        toks.push({ t: "code", value: normalizeCodeSpan(text.slice(i + n, found)) });
        i = found + n;
        continue;
      }
      buf += "`".repeat(n);
      i += n;
      continue;
    }
    if (ch === "[") {
      const link = tryLink(text, i);
      if (link !== null) {
        flush();
        toks.push(link.tok);
        i = link.next;
        continue;
      }
      buf += "[";
      i += 1;
      continue;
    }
    if (ch === "*" || ch === "_") {
      let n = 0;
      while (text[i + n] === ch) n++;
      const before = i > 0 ? text[i - 1]! : "";
      const after = i + n < text.length ? text[i + n]! : "";
      // CommonMark flanking.
      const leftFlanking =
        !isWhitespaceOrEdge(after) && (!isPunct(after) || isWhitespaceOrEdge(before) || isPunct(before));
      const rightFlanking =
        !isWhitespaceOrEdge(before) && (!isPunct(before) || isWhitespaceOrEdge(after) || isPunct(after));
      let canOpen = leftFlanking;
      let canClose = rightFlanking;
      if (ch === "_") {
        // Underscore can't open/close intraword — only at word boundaries.
        canOpen = leftFlanking && (!rightFlanking || isPunct(before));
        canClose = rightFlanking && (!leftFlanking || isPunct(after));
      }
      flush();
      toks.push({ t: "delim", ch, count: n, canOpen, canClose });
      i += n;
      continue;
    }
    buf += ch;
    i += 1;
  }
  flush();
  return toks;
}

// ── Phase 2: pair emphasis delimiters (CommonMark process_emphasis, scoped to */_ ) ──

function isDelim(tok: Tok): tok is DelimTok {
  return tok.t === "delim";
}

/** Add a mark to every text/link run between `open` and `close` token indices (exclusive). */
function applyMark(toks: Tok[], open: number, close: number, mark: Mark): void {
  for (let k = open + 1; k < close; k++) {
    const tok = toks[k]!;
    if (tok.t === "text") tok.marks = [mark, ...tok.marks];
    else if (tok.t === "link") {
      tok.children = tok.children.map((run) =>
        run.kind === "text" ? { kind: "text", value: run.value, marks: [mark, ...run.marks] } : run,
      );
    }
  }
}

function processEmphasis(toks: Tok[]): void {
  // Walk closers left→right; for each, repeatedly pair with the nearest eligible opener to
  // its left until the closer is spent or none is left. `openersBottom` floors the opener
  // search per (char, closer%3) to keep it linear and honor CommonMark's "rule of 3".
  const openersBottom = new Map<string, number>();
  const key = (ch: string, closerMod: number): string => `${ch}|${closerMod}`;

  for (let c = 0; c < toks.length; c++) {
    const closer = toks[c];
    if (closer === undefined || !isDelim(closer) || !closer.canClose) continue;
    while (closer.count > 0) {
      const floorKey = key(closer.ch, closer.count % 3);
      const bottom = openersBottom.get(floorKey) ?? -1;
      // Find the nearest eligible opener strictly left of the closer.
      let o = -1;
      for (let s = c - 1; s > bottom; s--) {
        const cand = toks[s];
        if (cand === undefined || !isDelim(cand) || cand.ch !== closer.ch || !cand.canOpen || cand.count === 0) continue;
        // Rule of 3: when either side can be BOTH opener and closer, the original-length sum
        // must not be a multiple of 3 (unless both are) — else skip to an earlier opener.
        const oddMatch =
          (closer.canOpen || cand.canClose) && closer.count % 3 !== 0 && (cand.count + closer.count) % 3 === 0;
        if (oddMatch) continue;
        o = s;
        break;
      }
      if (o < 0) {
        openersBottom.set(floorKey, c - 1);
        break;
      }
      const opener = toks[o] as DelimTok;
      const use = closer.count >= 2 && opener.count >= 2 ? 2 : 1;
      applyMark(toks, o, c, use === 2 ? "strong" : "emphasis");
      opener.count -= use;
      closer.count -= use;
      // Delimiters trapped between a matched opener/closer can never pair — drop them.
      for (let m = o + 1; m < c; m++) {
        const mid = toks[m];
        if (mid !== undefined && isDelim(mid)) mid.count = 0;
      }
    }
  }
}

// ── Phase 3: flatten tokens → canonical inline runs ──

function marksEqual(a: Mark[], b: Mark[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((m, i) => {
    const n = b[i]!;
    if (typeof m === "string" || typeof n === "string") return m === n;
    return m.kind === "link" && n.kind === "link" && m.href === n.href;
  });
}

/** Append a text run, merging into the previous run when marks match — so literal-delimiter
 *  splits (e.g. `import` `_` `etc2`) collapse back to one run and `isInertText` holds. */
function pushText(out: IInline[], value: string, marks: Mark[]): void {
  if (value.length === 0) return;
  const prev = out[out.length - 1];
  if (prev !== undefined && prev.kind === "text" && marksEqual(prev.marks, marks)) {
    out[out.length - 1] = { kind: "text", value: prev.value + value, marks: prev.marks };
    return;
  }
  out.push({ kind: "text", value, marks });
}

function flatten(toks: Tok[]): IInline[] {
  const out: IInline[] = [];
  for (const tok of toks) {
    switch (tok.t) {
      case "text":
        pushText(out, tok.value, tok.marks);
        break;
      case "code":
        out.push({ kind: "code-span", value: tok.value });
        break;
      case "link":
        // Each label run gains the link mark; if the label was plain, that's one run.
        for (const run of tok.children) {
          if (run.kind === "text") pushText(out, run.value, [...run.marks, { kind: "link", href: tok.href }]);
          else out.push(run);
        }
        break;
      case "delim":
        // Unconsumed delimiters are literal text.
        if (tok.count > 0) pushText(out, tok.ch.repeat(tok.count), []);
        break;
    }
  }
  return out.length > 0 ? out : [{ kind: "text", value: "", marks: [] }];
}

/**
 * Parse a string of inline Markdown (the supported subset) into canonical inline runs.
 * Pure + deterministic. Marks are emitted inner→outer; `ingestion.normalizeInlines`
 * canonical-sorts and merges, so the exact order/segmentation here need not be canonical.
 */
export function parseInline(text: string): IInline[] {
  if (text.length === 0) return [{ kind: "text", value: "", marks: [] }];
  const toks = scan(text);
  processEmphasis(toks);
  return flatten(toks);
}

/**
 * Whether `value` is free of SIGNIFICANT Markdown — i.e. parsing it yields exactly one
 * plain, unmarked text run equal to the input. The leaf validator uses this in place of a
 * blunt character ban: a text run is canonical iff it is a parse fixed point, which is what
 * makes render-verbatim round-trip (an inert value re-parses to itself). Inert values MAY
 * contain delimiter characters that aren't significant in context (intraword `_`, a bare
 * `*`), which the old regex wrongly rejected.
 */
export function isInertText(value: string): boolean {
  const runs = parseInline(value);
  return runs.length === 1 && runs[0]!.kind === "text" && runs[0]!.marks.length === 0 && runs[0]!.value === value;
}
