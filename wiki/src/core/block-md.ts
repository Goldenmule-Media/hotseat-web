/**
 * Block-level Markdown parser — the block companion of `parseInline` (core/inline-md).
 *
 * Reifies a deliberate CommonMark/GFM SUBSET into the closed `IBlock` vocabulary:
 * blank-line-separated paragraphs, ATX headings, fenced code, blockquotes, (nested)
 * `-`/`*`/`1.` lists, GFM tables, and thematic-break dividers. All inline content goes
 * through `parseInline`, so every text run is inert and the output — once normalized at
 * ingestion like any authored blocks value — is a parse fixed point of the block
 * renderer (render/blocks.ts). Anything outside the subset degrades to a paragraph:
 * never a throw, never silently dropped content.
 *
 * Pure + deterministic — no clock/RNG; every block id comes from the injected `newId`.
 */
import type { BlockId, IBlock, IInline } from "../api";
import { contentHash } from "./ingestion";
import { parseInline } from "./inline-md";

type NewId = () => string;

const FENCE_OPEN = /^(`{3,})(.*)$/;
const FENCE_CLOSE = /^(`{3,})\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const DIVIDER = /^ {0,3}([-_*])(\s*\1){2,}\s*$/;
const UNORDERED_ITEM = /^( {0,3})([-*])\s+(.*)$/;
const ORDERED_ITEM = /^( {0,3})(\d{1,9}\.)\s+(.*)$/;
/**
 * A line that is EXACTLY one image: `![alt](ref)` or `![alt](ref "title")`.
 * Block position only. An image in the middle of a paragraph keeps the historic
 * degradation (a literal `!` followed by a link), which is still a `parseInline`
 * fixed point — so nothing that parses today changes shape.
 */
const IMAGE_LINE = /^ {0,3}!\[([^\]]*)\]\(([^\s()]+)(?:\s+"([^"]*)")?\)\s*$/;

/** Parse a Markdown document into the closed block vocabulary. */
export function parseBlocks(markdown: string, newId: NewId): IBlock[] {
  const lines = markdown.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  return parseLines(lines, newId);
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

/** Does this line begin a non-paragraph block form? Bounds paragraph accumulation. */
function startsBlock(line: string): boolean {
  return (
    isBlank(line) ||
    FENCE_OPEN.test(line) ||
    HEADING.test(line) ||
    QUOTE.test(line) ||
    DIVIDER.test(line) ||
    UNORDERED_ITEM.test(line) ||
    ORDERED_ITEM.test(line) ||
    IMAGE_LINE.test(line)
  );
}

function isDelimiterRow(line: string): boolean {
  return line.includes("|") && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
}

/** Split a table row into cells, honoring `\|` escapes (the renderer's cell escape). */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function alignOf(cell: string): "left" | "center" | "right" | null {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (left) return "left";
  if (right) return "right";
  return null;
}

function parseLines(lines: readonly string[], newId: NewId): IBlock[] {
  const out: IBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }

    const fence = FENCE_OPEN.exec(line);
    if (fence !== null) {
      const openLen = fence[1]!.length;
      const lang = fence[2]!.trim().split(/\s+/)[0] || "text";
      const body: string[] = [];
      i++;
      // An unclosed fence runs to the end of the input (CommonMark).
      while (i < lines.length) {
        const close = FENCE_CLOSE.exec(lines[i]!);
        if (close !== null && close[1]!.length >= openLen) {
          i++;
          break;
        }
        body.push(lines[i]!);
        i++;
      }
      const source = body.join("\n");
      out.push({ kind: "code", id: newId() as BlockId, lang, source, hash: contentHash(source) });
      continue;
    }

    const h = HEADING.exec(line);
    if (h !== null) {
      out.push({
        kind: "heading",
        id: newId() as BlockId,
        level: h[1]!.length as 1 | 2 | 3 | 4 | 5 | 6,
        inlines: parseInline(h[2]!.trim()),
      });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i]!);
        if (q === null) break;
        inner.push(q[1]!);
        i++;
      }
      out.push({ kind: "quote", id: newId() as BlockId, blocks: parseLines(inner, newId) });
      continue;
    }

    if (DIVIDER.test(line)) {
      out.push({ kind: "divider", id: newId() as BlockId });
      i++;
      continue;
    }

    const img = IMAGE_LINE.exec(line);
    if (img !== null) {
      const title = img[3];
      out.push({
        kind: "image",
        id: newId() as BlockId,
        ref: img[2]!,
        alt: img[1]!,
        ...(title !== undefined && title.length > 0 ? { title } : {}),
      });
      i++;
      continue;
    }

    // GFM table: a `|`-bearing header line whose NEXT line is a matching delimiter row.
    if (line.includes("|") && i + 1 < lines.length && isDelimiterRow(lines[i + 1]!)) {
      const header = splitRow(line);
      const delim = splitRow(lines[i + 1]!);
      if (header.length === delim.length) {
        const align = delim.map(alignOf);
        const rows: IInline[][][] = [];
        i += 2;
        while (i < lines.length && !isBlank(lines[i]!) && lines[i]!.includes("|")) {
          const cells = splitRow(lines[i]!);
          const row: IInline[][] = [];
          for (let c = 0; c < align.length; c++) row.push(parseInline(cells[c] ?? ""));
          rows.push(row);
          i++;
        }
        out.push({
          kind: "table",
          id: newId() as BlockId,
          align,
          header: header.map((c) => parseInline(c)),
          rows,
        });
        continue;
      }
      // Width mismatch: not a well-formed table — fall through to a paragraph.
    }

    if (UNORDERED_ITEM.test(line) || ORDERED_ITEM.test(line)) {
      const { block, next } = parseList(lines, i, newId);
      out.push(block);
      i = next;
      continue;
    }

    // Paragraph: accumulate until a blank line or the start of another block form.
    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && !startsBlock(lines[i]!)) {
      para.push(lines[i]!.trim());
      i++;
    }
    out.push({ kind: "paragraph", id: newId() as BlockId, inlines: parseInline(para.join(" ")) });
  }
  return out;
}

/**
 * A run of same-flavor list items. An item's body is its marker line plus any lines
 * indented two-or-more spaces (the renderer's continuation indent), dedented and parsed
 * recursively — so nested lists and fenced code inside an item round-trip. A blank line
 * or a different-flavor marker ends the list.
 */
function parseList(lines: readonly string[], start: number, newId: NewId): { block: IBlock; next: number } {
  const ordered = ORDERED_ITEM.test(lines[start]!);
  const markerRe = ordered ? ORDERED_ITEM : UNORDERED_ITEM;
  const items: string[][] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) break;
    // Continuation before marker: a 2+-space-indented line belongs to the current item
    // (a nested marker there is the ITEM's sublist, not a sibling).
    if (items.length > 0 && /^ {2}/.test(line)) {
      items[items.length - 1]!.push(line.slice(2));
      i++;
      continue;
    }
    const m = markerRe.exec(line);
    if (m !== null) {
      items.push([m[3]!]);
      i++;
      continue;
    }
    break;
  }
  const itemBlocks = items.map((itemLines) => parseLines(itemLines, newId));
  return { block: { kind: "list", id: newId() as BlockId, ordered, items: itemBlocks }, next: i };
}
