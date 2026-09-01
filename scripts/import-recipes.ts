/**
 * Import the Braindump vault's `Recipes` folder into a wiki workspace as `recipe` pages.
 *
 * SAFE BY DEFAULT: parses everything, prints the plan, and writes NOTHING. Pass `--apply`
 * to commit. Re-running with `--apply` is idempotent — a recipe whose title already exists
 * under `--parent` is skipped, and an existing page that is still EMPTY (an interrupted run
 * created the page but never landed its content) is filled in rather than skipped.
 *
 *   tsx scripts/import-recipes.ts --workspace ws:… --parent toc:…
 *   tsx scripts/import-recipes.ts --workspace ws:… --parent toc:… --apply
 *   tsx scripts/import-recipes.ts --workspace ws:… --only "Chili.md" --only "Pie Crust.md"
 *
 * Auth follows the shared CLI precedence: `--token` / `$WIKI_TOKEN`, else a stored grant
 * from `wiki-mirror login --stream-url <url>`. `--stream-url` defaults to LOCAL (and
 * `$WIKI_STREAM_URL` can redirect that default, so the resolved target is printed in the
 * plan header); running this against the deployed server is a deliberate act, never a
 * default. `--create-workspace` also writes NOTHING without `--apply`.
 *
 * FULLY DETERMINISTIC. This is a parser, not a model: no network beyond the stream, no
 * clock in anything that gets written, no LLM. The same file always produces the same page.
 *
 * NOTHING IS EVER DROPPED. A line that cannot be confidently structured is preserved
 * verbatim — an unparseable ingredient line becomes an ingredient whose whole text is its
 * name, a vault-local embed becomes a note — and every such decision is REPORTED per file.
 * A slightly unstructured page beats a lossy one.
 *
 * THE SHAPES THIS PARSER READS, in the order it decides them:
 *
 *  - A file is a sequence of blank-line-separated BLOCKS. A block whose lines mostly parse
 *    as `<qty> <unit> <name>` is an ingredient block; prose after the first ingredient
 *    block is the method; prose BEFORE it is commentary, not a step.
 *  - GROUPS come from a label line (`Filling:`) or from an instruction that introduces a
 *    block (`Whisk together in stand mixer:`). A label applies to the NEXT block only —
 *    under-labelling is a recoverable error, inventing a group is not. Blocks separated by
 *    nothing but a blank line (a dry group and a wet group) stay UNGROUPED on purpose.
 *  - A DIVIDED ingredient (`1 egg + 1 egg (wash)`) is split into two rows, which is exactly
 *    what the model wants: the steps address them separately and the shopping list adds
 *    them back up.
 *  - NOTES begin at the first note heading (`**12/29/24**`, `##### 2/6/24`, `Notes:`) and
 *    run to the end of the file. Dated notes are re-sorted OLDEST FIRST; an undated heading
 *    that follows a dated one (`Reviews:`) travels with it rather than floating loose.
 *  - EMBEDS (`![[Something.pdf]]`, `obsidian://…`) are NOT uploaded in this pass. Their
 *    references land verbatim in a trailing note so the pointer survives, and every one is
 *    reported as deferred work.
 *
 * KNOWN LIMITATION, deferred: a multi-line step or note body is joined with "\n" and
 * handed to `parseBlocks`, which folds soft-wrapped lines into ONE paragraph — the line
 * boundaries are then irrecoverable in the event store. No file in the default set is
 * affected (every default-set note is a single line or a bullet list), but this must be
 * settled before widening to files that wrap their prose.
 *
 * BACKDATING: a page's `createdAt` is stamped from the event's `occurredAt`, which comes
 * from `IWikiConfig.clock` — so the clock is a mutable box set to each source file's own
 * mtime before its writes. Without that every imported recipe would claim to be new.
 *
 * `scripts/` is NOT covered by the root `npm run typecheck` (it fans out to the five
 * workspace packages only). Typecheck this file directly:
 *
 *   npx tsc --noEmit --strict --target ES2022 --module ESNext \
 *     --moduleResolution Bundler --skipLibCheck --types node scripts/import-recipes.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";

import { createWiki } from "wiki";
import type { ITreeNode, IStreamConfig, IWorkspaceHandle, PageId, WorkspaceId } from "wiki";
import { resolveAuthorization } from "wiki/auth-client";
// The importer's OWN engine must register every type it touches: `recipe` for the pages it
// creates, `toc` for the parent it hangs them under (the fold rejects an unknown type
// before any write).
import recipePageTypes, { canonicalUnit, parseQuantity } from "wiki-models/recipe";
import tocPageTypes from "wiki-models/toc";

// ────────────────────────────────────────────────────────────────────────────
// Flags
// ────────────────────────────────────────────────────────────────────────────

interface Flags {
  corpus: string;
  workspace: string;
  parent: string | undefined;
  streamUrl: string;
  namespace: string;
  apply: boolean;
  createWorkspace: string | undefined;
  only: readonly string[];
  token: string | undefined;
}

function parseFlags(argv: readonly string[]): Flags {
  const one = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i < 0 || i + 1 >= argv.length) return undefined;
    const v = argv[i + 1]!;
    return v.startsWith("--") ? undefined : v;
  };
  // `--only` is repeatable — the whole point is picking a handful of files by hand.
  const many = (name: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] !== `--${name}` || i + 1 >= argv.length) continue;
      const v = argv[i + 1]!;
      if (!v.startsWith("--")) out.push(v);
    }
    return out;
  };
  const corpus = one("corpus") ?? join(homedir(), "Documents", "Braindump", "Recipes");
  return {
    corpus: resolve(corpus.replace(/^~(?=$|\/)/, homedir())),
    workspace: one("workspace") ?? "",
    parent: one("parent"),
    streamUrl: one("stream-url") ?? process.env.WIKI_STREAM_URL ?? "http://127.0.0.1:4437",
    namespace: one("namespace") ?? process.env.WIKI_NAMESPACE ?? "default",
    apply: argv.includes("--apply"),
    createWorkspace: one("create-workspace"),
    only: many("only"),
    token: one("token") ?? process.env.WIKI_TOKEN,
  };
}

/**
 * The curated default set — the files this parser has actually been read against, in the
 * order they were widened to. Everything else in the corpus needs `--only` until it has
 * been looked at, because a wrong guess here writes a wrong page.
 */
const DEFAULT_SET: readonly string[] = [
  "Bread/Burger Buns.md",
  "Bread/Hotteok.md",
  "Chili.md",
  "Potato Salad.md",
  "Pie Crust.md",
  "Carbonara.md",
  "Sausage.md",
];

/** Files in the corpus that are NOT one recipe, with the reason they are passed over. */
const SKIP: readonly { readonly file: string; readonly why: string }[] = [
  { file: "Bread/Bread Book.md", why: "21 recipes in one file — needs a splitter, not this importer" },
  {
    file: "Coffee Recipes.md",
    why: "brew-trial parameter tables this parser cannot read; the one real AeroPress procedure in it sits under a `###` heading that would flip the whole file into notes mode",
  },
  { file: "Tea.md", why: "brew-trial parameter tables, not a recipe" },
  { file: "Eggnog.md", why: "a product letter-grade, not a recipe" },
];

/** Every `.md` in the corpus, as corpus-relative paths. `_resources` is Obsidian's
 *  attachment bin, not recipes. */
function corpusFiles(dir: string, root = dir, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".") || name === "_resources") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) corpusFiles(p, root, out);
    else if (name.endsWith(".md")) out.push(relative(root, p).split(sep).join("/"));
  }
  return out;
}

/** Resolve a `--only` value against the corpus: an exact relative path, else the one file
 *  whose path ends with it (so `--only "Burger Buns.md"` finds `Bread/Burger Buns.md`). */
function resolveOnly(value: string, all: readonly string[]): { rel: string } | { error: string } {
  const wanted = value.replace(/^\.?\//, "").toLowerCase();
  const exact = all.find((f) => f.toLowerCase() === wanted);
  if (exact !== undefined) return { rel: exact };
  const hits = all.filter((f) => f.toLowerCase().endsWith(`/${wanted}`));
  if (hits.length === 1) return { rel: hits[0]! };
  if (hits.length > 1) return { error: `--only "${value}" is ambiguous: ${hits.join(", ")}` };
  return { error: `--only "${value}" matches no .md file under the corpus` };
}

// ────────────────────────────────────────────────────────────────────────────
// Preprocessing
// ────────────────────────────────────────────────────────────────────────────

/** Joplin left a `---` fenced block behind — usually on line 2 rather than line 1 — holding
 *  `Tag(s): #Bread` and nothing a recipe needs. */
function stripFrontmatter(lines: readonly string[], report: string[]): string[] {
  let start = 0;
  while (start < lines.length && lines[start]!.trim() === "") start++;
  if (start >= lines.length || lines[start]!.trim() !== "---") return [...lines];
  for (let j = start + 1; j < lines.length && j < start + 8; j++) {
    if (lines[j]!.trim() === "---") {
      report.push(`dropped Joplin frontmatter: ${lines.slice(start + 1, j).map((l) => l.trim()).join(" / ")}`);
      return [...lines.slice(0, start), ...lines.slice(j + 1)];
    }
  }
  return [...lines];
}

function preprocess(text: string, report: string[]): string[] {
  const raw = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    // Evernote escaped punctuation on the way out: `1/4\-inch` is a hyphen. Trailing
    // whitespace is Obsidian's hard-line-break marker and would defeat every
    // ends-with-a-period test below.
    .map((l) => l.replace(/\\([-.*_+#[\]()])/g, "$1").replace(/\s+$/, ""));
  const footers = raw.filter((l) => /^[ \t]+(?:Created|Updated) at:/.test(l));
  if (footers.length > 0) {
    report.push(`dropped ${footers.length} Evernote export footer line(s): ${footers.map((l) => l.trim()).join(" / ")}`);
  }
  return stripFrontmatter(raw.filter((l) => !/^[ \t]+(?:Created|Updated) at:/.test(l)), report);
}

/** Blocks, split on blank lines and horizontal rules. A rule separates as firmly as a
 *  blank line, and the vault writes them as `---`, `----`, and `--—`. */
function blocksOf(lines: readonly string[]): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t === "" || /^[-—]{3,}$/.test(t)) {
      if (cur.length > 0) out.push(cur);
      cur = [];
      continue;
    }
    cur.push(line);
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Line classification
// ────────────────────────────────────────────────────────────────────────────

const EMBED_LINE = /^\s*(?:!\[\[[^\]]+\]\]|\[[^\]]*\]\(obsidian:\/\/[^)]*\))\s*$/;
const URL_LINE = /^\s*(?:[-*•]\s+)?(?:\[[^\]]*\]\()?<?(https?:\/\/[^\s>)]+)>?\)?\.?\s*$/;
const YIELD_LINE = /^\s*(?:makes|serves|yields?)\b[:\s]+(.+?)\.?\s*$/i;
/** `1/2 Batch` is a yield too, and it is the only shape in the corpus that says so without
 *  a verb. */
const BATCH_LINE = /^\s*([\d\s/.¼½¾⅓⅔]*\s*batch(?:es)?)\.?\s*$/i;
const NOTE_KEYWORD =
  /^\s*\**\s*(notes?|reviews?|verdict|thoughts|results?|for next time|next time|a few things)\s*\**\s*:\s*(.*)$/i;
const NOTE_DATE = /^\s*#{0,6}\s*\**\s*(\d{1,2}[/.\-]\d{1,2}(?:[/.\-]\d{2,4})?)\s*\**\s*$/;
const HEADING_LINE = /^\s*#{1,6}\s+(.+?)\s*$/;
const BOLD_LINE = /^\s*\*\*([^*]+)\*\*:?\s*$/;
const LABEL_LINE = /^\s*(.{1,80}?):\s*$/;
const BULLET = /^\s*[-*•]\s+/;
/** An ordered-list marker. `1. Quite good…` is a numbered verdict, never `1` of something —
 *  without this the quantity parser reads the list number as a measure. */
const ORDERED = /^\s*\d+[.)]\s+/;

const VULGAR = "¼½¾⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞";
/** Ordered alternation, longest form first: a bare `\d*\.?\d+` would swallow the `15` of
 *  `2 15-ounce cans` into the quantity and then fail to parse `2 15` at all. */
const QTY = new RegExp(
  `^(\\d+\\s+\\d+\\s*/\\s*\\d+|\\d+\\s*[${VULGAR}]|\\d+\\s*/\\s*\\d+|[${VULGAR}]|\\d*\\.\\d+|\\d+)\\s*`,
);

interface ParsedIngredient {
  readonly title: string;
  readonly qty?: number;
  readonly unit?: string;
  readonly prep?: string;
  readonly note?: string;
  readonly group?: string;
}

function parseIngredient(raw: string): ParsedIngredient | null {
  if (ORDERED.test(raw)) return null;
  const line = raw.replace(BULLET, "").trim();
  if (line === "") return null;
  const m = QTY.exec(line);
  if (m === null) return null;
  const qty = parseQuantity(m[1]!);
  if (qty === null) return null;
  let rest = line.slice(m[0].length).trim();
  let unit: string | undefined;
  // `640g flour` attaches the unit to the number; `3.5 C all purpose flour` does not. Both
  // land here as the first token of the remainder, and it is a unit only if the shared
  // vocabulary says so — `1 head garlic` keeps "head" in the name.
  const token = /^([A-Za-z]+\.?)\b/.exec(rest);
  if (token !== null && canonicalUnit(token[1]!) !== null) {
    unit = token[1]!;
    rest = rest.slice(token[0].length).trim();
  }
  rest = rest.replace(/^of\s+/i, "");
  let note: string | undefined;
  // The trailing parenthetical comes off BEFORE the comma split, or a comma inside it
  // ("… – I use ancho, chipotle and Mexican") tears the name in half.
  const paren = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(rest);
  if (paren !== null && paren[1]!.trim() !== "") {
    rest = paren[1]!.trim();
    note = paren[2]!.trim();
  }
  const comma = rest.indexOf(", ");
  const title = (comma === -1 ? rest : rest.slice(0, comma)).trim();
  const prep = comma === -1 ? "" : rest.slice(comma + 2).trim();
  if (title === "") return null;
  return {
    title,
    qty,
    ...(unit !== undefined ? { unit } : {}),
    ...(prep !== "" ? { prep } : {}),
    ...(note !== undefined && note !== "" ? { note } : {}),
  };
}

/** `1 egg + 1 egg (wash)` is two rows, not one — split only when BOTH halves parse, so
 *  "more salt + cheese" in a tasting note stays a single line of prose. */
function parseIngredientLine(raw: string): readonly ParsedIngredient[] | null {
  const line = raw.replace(BULLET, "").trim();
  const halves = line.split(/\s+\+\s+/);
  if (halves.length > 1) {
    const parts = halves.map(parseIngredient);
    if (parts.every((p): p is ParsedIngredient => p !== null)) return parts;
  }
  const one = parseIngredient(line);
  return one === null ? null : [one];
}

/** A short, unpunctuated line — a floating `Sesame seeds` garnish. Only ever read as an
 *  ingredient between the first ingredient block and the first step. */
function isBareItem(line: string): boolean {
  const t = line.replace(BULLET, "").trim();
  return t !== "" && !/[.!?:]$/.test(t) && t.split(/\s+/).length <= 4;
}

/** Function words a derived label must never end on — cutting a phrase after "to" or "and"
 *  reads as a truncation even when the cut landed on a word boundary. */
const TRAILING = new Set([
  "a", "an", "and", "at", "but", "by", "for", "from", "in", "into", "of", "on", "or", "the",
  "then", "to", "until", "up", "with",
]);

function trimTrailing(words: readonly string[]): string[] {
  const out = [...words];
  while (out.length > 1 && TRAILING.has(out[out.length - 1]!.toLowerCase().replace(/[^a-z]/g, ""))) out.pop();
  return out;
}

/** Clip to `max` characters ON A WORD BOUNDARY. A mid-word `…` is never acceptable, so a
 *  single over-long word is kept whole rather than cut. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const at = text.slice(0, max + 1).lastIndexOf(" ");
  const head = at > 0 ? text.slice(0, at) : (text.split(" ")[0] ?? text);
  return `${trimTrailing(head.replace(/[\s,;:.]+$/, "").split(/\s+/)).join(" ")}…`;
}

/**
 * The short label above an instruction: its first sentence, narrowed to the first comma
 * clause. `as: "sections"` renders it as `### {n}. {title}` and the model requires it to be
 * non-empty, so this always returns something.
 *
 * A heading that restates the whole line beneath it is not a heading. When the first clause
 * IS the entire body, the label falls back to a leading verb phrase strictly shorter than
 * the body ("Preheat oven" over "Preheat oven to 375."), which is the difference between a
 * label and an echo.
 */
function titleFrom(markdown: string, fallback: string): string {
  const body = markdown
    .trim()
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (body === "") return fallback;
  const sentence = body.split(/(?<=[.!?;:])\s/)[0] ?? body;
  const clause = sentence.split(/,\s/)[0] ?? sentence;
  const bare = (s: string): string => s.replace(/[.,;:!?]+$/, "").trim();
  const label = bare(clause);
  if (label === "") return fallback;
  if (label.toLowerCase() === bare(body).toLowerCase()) {
    const words = label.split(" ");
    return clip(trimTrailing(words.slice(0, Math.max(1, Math.min(4, words.length - 1)))).join(" "), 60);
  }
  return clip(label, 60);
}

/** ISO-normalize a note heading's date, so `12/29/24` and `2/6/24` sort in the right order.
 *  Two-digit years map to 2000+. */
function toIso(raw: string): string | undefined {
  const m = /^(\d{1,2})[/.\-](\d{1,2})(?:[/.\-](\d{2,4}))?$/.exec(raw);
  if (m === null || m[3] === undefined) return undefined;
  const month = Number(m[1]);
  const day = Number(m[2]);
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// ────────────────────────────────────────────────────────────────────────────
// File → recipe
// ────────────────────────────────────────────────────────────────────────────

interface Step {
  readonly title: string;
  readonly markdown: string;
  readonly group?: string;
}
interface Note {
  readonly title: string;
  readonly markdown: string;
}
interface DraftNote {
  title: string;
  iso: string | undefined;
  lines: string[];
}

interface Recipe {
  readonly rel: string;
  readonly title: string;
  readonly mtime: string;
  readonly url: string | undefined;
  readonly sourceYield: string | undefined;
  readonly ingredients: readonly ParsedIngredient[];
  readonly steps: readonly Step[];
  readonly notes: readonly Note[];
  /** Decisions a human should check — derived groups, verbatim fallbacks, deferrals. */
  readonly report: readonly string[];
}

/** Note headings, in priority order. A `Notes:` keyword may carry its body inline. */
function noteHeading(line: string): { title: string; iso?: string; inline?: string; why?: string } | null {
  const date = NOTE_DATE.exec(line);
  if (date !== null) {
    const iso = toIso(date[1]!);
    return { title: date[1]!, ...(iso !== undefined ? { iso } : {}) };
  }
  const keyword = NOTE_KEYWORD.exec(line);
  if (keyword !== null) {
    const inline = keyword[2]!.trim();
    return { title: keyword[1]!.trim(), ...(inline !== "" ? { inline } : {}) };
  }
  const heading = HEADING_LINE.exec(line);
  if (heading !== null) return { title: heading[1]!, why: `Markdown heading "${heading[1]!}" read as a note heading` };
  const bold = BOLD_LINE.exec(line);
  if (bold !== null) return { title: bold[1]!.replace(/:$/, ""), why: `bold line "${bold[1]!}" read as a note heading` };
  return null;
}

function parseRecipe(rel: string, path: string): Recipe {
  const stat = statSync(path);
  const report: string[] = [];
  const blocks = blocksOf(preprocess(readFileSync(path, "utf8"), report));

  const ingredients: ParsedIngredient[] = [];
  const steps: Step[] = [];
  const drafts: DraftNote[] = [];
  const embeds: string[] = [];
  const extraUrls: string[] = [];
  const ungrouped: number[] = [];
  let url: string | undefined;
  let sourceYield: string | undefined;
  let pendingLabel: string | undefined;
  let sawIngredients = false;
  let sawSteps = false;
  let notesMode = false;

  const openNote = (title: string, iso: string | undefined): DraftNote => {
    const draft: DraftNote = { title, iso, lines: [] };
    drafts.push(draft);
    return draft;
  };
  let current: DraftNote | undefined;
  /** Everything after the first note heading becomes note prose. When that prose is really
   *  an ingredient list — a second recipe under its own heading — nothing is lost, but the
   *  page is not the structured one the source could have produced. */
  const absorbed = (lines: readonly string[]): void => {
    const hits = lines.filter((l) => parseIngredientLine(l) !== null).length;
    if (hits >= 1 && hits * 2 >= lines.length) {
      report.push(
        `${hits} ingredient-shaped line(s) absorbed into note prose instead of the ingredients list (content follows the first note heading): "${lines[0]!.trim()}"…`,
      );
    }
  };

  for (const block of blocks) {
    let rest: string[] = block;

    // Metadata and embeds come out of any block, wherever they sit — but only outside a
    // note, where a bare URL is part of what was written rather than a source pointer.
    if (!notesMode) {
      const kept: string[] = [];
      for (const line of rest) {
        if (EMBED_LINE.test(line)) {
          embeds.push(line.trim());
          continue;
        }
        const bare = line.replace(/\*\*/g, "");
        const link = URL_LINE.exec(bare);
        if (link !== null) {
          if (url === undefined) url = link[1]!;
          else extraUrls.push(link[1]!);
          continue;
        }
        const yields = YIELD_LINE.exec(line) ?? BATCH_LINE.exec(line);
        if (yields !== null && sourceYield === undefined) {
          sourceYield = yields[1]!.trim();
          continue;
        }
        kept.push(line);
      }
      rest = kept;
    }
    if (rest.length === 0) continue;

    // Notes run from the first note heading to the end of the file: a recipe does not go
    // back to its method after it starts recording how it turned out.
    if (notesMode) {
      absorbed(rest);
      for (const line of rest) {
        const head = noteHeading(line);
        if (head !== null) {
          if (head.why !== undefined) report.push(head.why);
          current = openNote(head.title, head.iso);
          if (head.inline !== undefined) current.lines.push(head.inline);
          continue;
        }
        (current ?? (current = openNote("Notes", undefined))).lines.push(line);
      }
      continue;
    }
    const startsNotes = rest.findIndex((line) => noteHeading(line) !== null);
    if (startsNotes !== -1) {
      const before = rest.slice(0, startsNotes);
      if (before.length > 0) report.push(`kept verbatim above a note heading: ${before.join(" / ")}`);
      for (const line of before) drafts.push({ title: titleFrom(line, "Note"), iso: undefined, lines: [line] });
      notesMode = true;
      absorbed(rest.slice(startsNotes));
      for (const line of rest.slice(startsNotes)) {
        const head = noteHeading(line);
        if (head !== null) {
          if (head.why !== undefined) report.push(head.why);
          current = openNote(head.title, head.iso);
          if (head.inline !== undefined) current.lines.push(head.inline);
          continue;
        }
        (current ?? (current = openNote("Notes", undefined))).lines.push(line);
      }
      continue;
    }

    // A label heads the block it introduces — `Filling:` on its own line, or leading the
    // very block it names. It applies to that ONE block: under-labelling is recoverable,
    // an invented group is not.
    const label = LABEL_LINE.exec(rest[0]!);
    if (label !== null) {
      // Only one label can be pending: a second one before the first reaches a block
      // discards it, and that discard is a source line that reaches no page.
      if (pendingLabel !== undefined) {
        report.push(`label "${pendingLabel}" was discarded by "${label[1]!.trim()}" before either reached a block`);
      }
      pendingLabel = label[1]!.trim();
      rest = rest.slice(1);
      if (rest.length === 0) continue;
    }

    const parsedRows = rest.map(parseIngredientLine);
    const hits = parsedRows.filter((p) => p !== null).length;
    const isIngredientBlock =
      (hits >= 1 && hits * 2 >= rest.length) || (sawIngredients && !sawSteps && rest.every(isBareItem));

    if (isIngredientBlock) {
      const group = pendingLabel;
      pendingLabel = undefined;
      if (group === undefined) ungrouped.push(rest.length);
      else if (/\s/.test(group) && group.split(/\s+/).length > 3) report.push(`group "${group}" derived from the instruction line above the block`);
      for (let i = 0; i < rest.length; i++) {
        const rows = parsedRows[i];
        if (rows === null) {
          // Kept whole rather than guessed at: the name carries the author's line exactly.
          const verbatim = rest[i]!.replace(BULLET, "").trim();
          report.push(`unstructured ingredient kept verbatim: "${verbatim}"`);
          ingredients.push({ title: verbatim, ...(group !== undefined ? { group } : {}) });
          continue;
        }
        for (const row of rows) ingredients.push({ ...row, ...(group !== undefined ? { group } : {}) });
      }
      sawIngredients = true;
      continue;
    }

    // Prose BEFORE any ingredient is commentary, not method — a bare URL plus a verdict is
    // the commonest file in this corpus, and reading its verdict as step 1 would be wrong.
    if (!sawIngredients) {
      // A numbered run before any ingredient is a stack of dated-in-spirit verdicts, one
      // note each; anything else is one note for the whole block.
      const items = rest.every((l) => ORDERED.test(l)) ? rest.map((l) => l.replace(ORDERED, "")) : [rest.join("\n")];
      for (const text of items) {
        report.push(`prose before any ingredient kept as a note, not a step: "${titleFrom(text, "Note")}"`);
        drafts.push({ title: titleFrom(text, "Note"), iso: undefined, lines: text.split("\n") });
      }
      continue;
    }

    const group = pendingLabel;
    pendingLabel = undefined;
    // A step's `group` is data the model deliberately does not render, so say so — this is
    // the one place a source line survives in the page without appearing in its Markdown.
    if (group !== undefined) report.push(`label "${group}" stored as the following step(s)' group (step groups are not rendered)`);
    for (const body of stepBodies(rest)) {
      steps.push({ title: titleFrom(body, "Step"), markdown: body, ...(group !== undefined ? { group } : {}) });
    }
    sawSteps = true;
  }

  // One ungrouped block is just an ingredient list. TWO or more is a recipe that separated
  // its dry and wet halves with nothing but a blank line, and that is what a human has to
  // decide about — a group is never invented from a gap.
  if (ungrouped.length >= 2) {
    report.push(`${ungrouped.length} ingredient blocks left ungrouped (blank-line separated, no label in the source): ${ungrouped.join(" + ")} line(s)`);
  }

  for (const line of blocks.flat()) {
    if (line.includes("obsidian://") && !EMBED_LINE.test(line)) {
      report.push(`vault-local link kept verbatim inside prose: "${line.trim()}"`);
    }
  }

  return {
    rel,
    title: basename(rel, ".md"),
    mtime: stat.mtime.toISOString(),
    url,
    sourceYield,
    ingredients,
    steps,
    notes: orderNotes(drafts, embeds, extraUrls, report),
    report,
  };
}

/**
 * One step per LINE when every line of the block is its own finished sentence — the vault
 * writes a four-instruction method as four unnumbered lines — and one step for the whole
 * block otherwise, which is what keeps a wrapped paragraph in one piece.
 */
// DEFERRED: joining with "\n" lets `parseBlocks` fold soft-wrapped lines into one
// paragraph, and the line boundaries are then gone from the event store. Settle this
// before widening past the default set (see the file header).
function stepBodies(block: readonly string[]): string[] {
  const lines = block.map((l) => l.trim()).filter((l) => l !== "");
  if (lines.length <= 1) return [lines.join("\n")];
  if (!lines.every((l) => /[.!?]$/.test(l))) return [lines.join("\n")];
  const listed = lines.every((l) => BULLET.test(l)) || lines.every((l) => ORDERED.test(l));
  return listed ? lines.map((l) => l.replace(BULLET, "").replace(ORDERED, "")) : lines;
}

/**
 * Notes oldest first. Dated headings are re-sorted (the vault writes attempts newest-first),
 * and an UNDATED heading that follows a dated one — a `Reviews:` block belonging to that
 * attempt — travels with it instead of floating loose. Anything before the first date keeps
 * its position at the front.
 */
function orderNotes(
  drafts: readonly DraftNote[],
  embeds: readonly string[],
  extraUrls: readonly string[],
  report: string[],
): Note[] {
  const runs: { iso: string | undefined; notes: DraftNote[] }[] = [];
  for (const draft of drafts) {
    if (draft.iso !== undefined || runs.length === 0) runs.push({ iso: draft.iso, notes: [draft] });
    else runs[runs.length - 1]!.notes.push(draft);
  }
  const inFile = runs.filter((r) => r.iso !== undefined);
  const dated = [...inFile].sort((a, b) => a.iso!.localeCompare(b.iso!));
  const undated = runs.filter((r) => r.iso === undefined);
  // The vault writes attempts newest-first, so this re-sort is usually right — but a
  // mistyped year reorders a stack silently, and only the author can tell which it is.
  if (inFile.some((run, i) => run !== dated[i])) {
    report.push(
      `notes RE-SORTED oldest-first: file order ${inFile.map((r) => r.notes[0]!.title).join(", ")} → rendered ${dated.map((r) => r.notes[0]!.title).join(", ")} — check the dates if that looks wrong`,
    );
  }
  const out: Note[] = [];
  for (const run of [...undated, ...dated]) {
    for (const draft of run.notes) {
      const markdown = draft.lines.join("\n").trim();
      if (markdown === "" && draft.title.trim() === "") continue;
      out.push({ title: draft.title.trim() === "" ? "Note" : draft.title.trim(), markdown });
    }
  }
  // Attachment bytes are out of scope for this pass; the POINTER is not. It lands verbatim
  // so re-uploading later is a lookup rather than an archaeology exercise.
  const refs = [...embeds, ...extraUrls];
  if (refs.length > 0) {
    for (const ref of refs) report.push(`DEFERRED — file reference kept as text, not uploaded: ${ref}`);
    out.push({ title: "Attached files", markdown: refs.join("\n\n") });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Import
// ────────────────────────────────────────────────────────────────────────────

/** The command batch that fills a blank recipe page, in render order. One atomic commit. */
function commandsFor(r: Recipe): { command: string; args?: Record<string, unknown> }[] {
  const out: { command: string; args?: Record<string, unknown> }[] = [];
  if (r.url !== undefined) out.push({ command: "setSourceUrl", args: { value: r.url } });
  if (r.sourceYield !== undefined) out.push({ command: "setSourceYield", args: { value: r.sourceYield } });
  for (const i of r.ingredients) out.push({ command: "addIngredient", args: { ...i } });
  for (const s of r.steps) out.push({ command: "addStep", args: { title: s.title, markdown: s.markdown, ...(s.group !== undefined ? { group: s.group } : {}) } });
  for (const n of r.notes) out.push({ command: "addNote", args: { title: n.title, markdown: n.markdown } });
  return out;
}

/** True when a page carries no authored content at all — an interrupted run's leftover,
 *  which a re-run should FILL rather than skip. */
async function isBlank(ws: IWorkspaceHandle, id: PageId): Promise<boolean> {
  const state = await (await ws.page(id)).state();
  for (const section of state.sections) {
    for (const field of Object.values(section.fields)) {
      if (field.kind === "list" && field.elements.length > 0) return false;
      if (field.kind === "blocks" && field.blocks.length > 0) return false;
      if (field.kind === "scalar" && String(field.value).trim() !== "") return false;
      if (field.kind === "prose" && field.value.trim() !== "") return false;
    }
  }
  return true;
}

function childrenOf(root: ITreeNode, parentId: string | undefined): readonly ITreeNode[] {
  if (parentId === undefined) return root.children;
  const find = (node: ITreeNode): ITreeNode | undefined => {
    if (node.id === parentId) return node;
    for (const child of node.children) {
      const hit = find(child);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  const node = find(root);
  if (node === undefined) throw new Error(`--parent ${parentId} is not a page in this workspace`);
  return node.children;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.workspace.length === 0 && flags.createWorkspace === undefined) {
    console.error("--workspace <ws:…> or --create-workspace <name> is required.");
    process.exit(2);
  }

  const all = corpusFiles(flags.corpus);
  const failures: string[] = [];
  const files: string[] = [];
  for (const value of flags.only.length > 0 ? flags.only : DEFAULT_SET) {
    const hit = resolveOnly(value, all);
    if ("error" in hit) failures.push(hit.error);
    else files.push(hit.rel);
  }
  const skipped = SKIP.filter((s) => files.some((f) => f.toLowerCase() === s.file.toLowerCase()));
  const selected = files.filter((f) => !SKIP.some((s) => s.file.toLowerCase() === f.toLowerCase()));

  const recipes: Recipe[] = [];
  for (const rel of selected) {
    try {
      recipes.push(parseRecipe(rel, join(flags.corpus, rel)));
    } catch (err) {
      failures.push(`${rel} — ${(err as Error).message}`);
    }
  }

  // The clock is a mutable box: each recipe's writes are stamped with ITS source file's
  // mtime, so an imported page's createdAt is when the recipe was last written down. The
  // wall-clock seed is only ever seen by an explicit --create-workspace scaffold.
  let now = new Date().toISOString();
  const authorization = resolveAuthorization(flags.streamUrl, flags.token);
  const stream: IStreamConfig = {
    baseUrl: flags.streamUrl,
    namespace: flags.namespace,
    ...(authorization !== undefined ? { headers: { authorization } } : {}),
  };
  const wiki = createWiki({ stream, pageTypes: [...tocPageTypes, ...recipePageTypes], clock: () => now });

  // `createWorkspace` APPENDS — it is a write like any other, and running it in a dry run
  // would put a real workspace on the server under a banner saying nothing was written.
  // Without --apply the workspace is only described, and there is then nothing to read
  // existing titles from.
  const ws: IWorkspaceHandle | undefined =
    flags.createWorkspace !== undefined
      ? flags.apply
        ? await wiki.createWorkspace({ name: flags.createWorkspace })
        : undefined
      : await wiki.openWorkspace(flags.workspace as WorkspaceId);
  if (flags.createWorkspace !== undefined && ws !== undefined) console.log(`created workspace ${ws.id}`);

  const existing = new Map<string, PageId>();
  if (ws !== undefined) {
    for (const child of childrenOf(await ws.tree(), flags.parent)) existing.set(child.title, child.id as PageId);
  }

  let created = 0;
  let refilled = 0;
  let untouched = 0;

  console.log(`corpus     ${flags.corpus}`);
  // The resolved target, not the flag: $WIKI_STREAM_URL can redirect the default, and a
  // run has to say on its face which server it reached.
  console.log(`stream     ${flags.streamUrl}  (namespace ${flags.namespace})`);
  console.log(`workspace  ${ws?.id ?? `would create "${flags.createWorkspace ?? ""}"`}`);
  console.log(`parent     ${flags.parent ?? "(workspace root)"}`);
  console.log(`selected   ${selected.length} of ${all.length} corpus file(s)${flags.only.length > 0 ? " via --only" : " (default set)"}`);
  console.log("");

  for (const r of recipes) {
    const groups = new Set(r.ingredients.map((i) => i.group).filter((g): g is string => g !== undefined));
    console.log(`${r.rel}  →  "${r.title}"   (mtime ${r.mtime.slice(0, 10)})`);
    console.log(
      `    source ${r.url ?? "—"}${r.sourceYield !== undefined ? `  |  makes ${r.sourceYield}` : ""}`,
    );
    console.log(`    ${r.ingredients.length} ingredient(s) in ${groups.size} group(s), ${r.steps.length} step(s), ${r.notes.length} note(s)`);
    for (const line of r.report) console.log(`    · ${line}`);

    // The blank-page probe runs in BOTH modes, or a dry run would print "SKIP" for a page
    // that `--apply` is about to refill — the plan has to be what actually happens.
    const hit = existing.get(r.title);
    const resumable = ws !== undefined && hit !== undefined && (await isBlank(ws, hit));
    if (hit !== undefined && !resumable) {
      untouched++;
      console.log(`    SKIP — a page titled "${r.title}" already exists under this parent`);
      console.log("");
      continue;
    }
    if (!flags.apply || ws === undefined) {
      if (resumable) console.log(`    would REFILL ${hit} — the page exists but is blank`);
      else console.log(`    would CREATE a "${r.title}" recipe page`);
      console.log("");
      continue;
    }

    now = r.mtime;
    try {
      const pageId =
        hit ??
        (await ws.createPage("recipe", { title: r.title, parentId: (flags.parent ?? null) as PageId | null })).value;
      await ws.mutateMany(pageId, commandsFor(r));
      existing.set(r.title, pageId);
      if (hit === undefined) created++;
      else refilled++;
      console.log(`    ${hit === undefined ? "CREATED" : "REFILLED"} ${pageId}`);
    } catch (err) {
      failures.push(`${r.rel} — ${(err as Error).message}`);
      console.log(`    FAILED — ${(err as Error).message}`);
    }
    console.log("");
  }

  for (const s of skipped) console.log(`skipped ${s.file} — ${s.why}`);
  console.log(
    flags.apply
      ? `created ${created}, refilled ${refilled}, left alone ${untouched}`
      : "DRY RUN — nothing written. Pass --apply.",
  );
  if (failures.length > 0) {
    console.log(`\nfailures (${failures.length}):`);
    for (const f of failures) console.log(`  ${f}`);
  }

  await wiki.close();
}

await main();
