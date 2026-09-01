/**
 * Which files in the Braindump vault belong to which importer.
 *
 * Shared by `import-engagement-logs.ts` (the meeting/1-on-1/interview threads under
 * `Jobs/`) and `import-vault.ts` (everything else). The split lives here rather than in
 * either script because it is ONE rule read from two sides: the general importer's job is
 * defined as "the vault minus what the engagement pass consumed", and re-deriving that
 * from the same folder names would drift the moment one of them gained an exception.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Directories whose contents are counterparty threads. */
export const THREAD_DIRS = new Set([
  "Meetings",
  "C-Staff",
  "Personnel",
  "1 on 1s",
  "External Relationships",
  "Interviews",
  "Dedalord",
  "HR",
  "Coworkers",
  "Recommendations",
  "Training",
]);

/**
 * Files that sit in a thread directory but are NOT a thread — the folders leak. A
 * directory-driven import would otherwise create a person called "TRI Team Shape".
 * Matched on the basename, case-insensitively.
 */
export const NOT_A_THREAD = [
  /^tri team shape$/i,
  /^the case for a platform engineer$/i,
  /^offer notes$/i,
  /^pf review.*outline$/i,
  /^self review/i,
  /^.*\btemplate\b.*$/i,
  /^interview questions$/i,
  /^exit interview/i,
  /^jd[ _:]/i,
  /^untitled/i,
];

/** A trailing date on a filename: `Foo 8_3_20`, `Foo - 9_28_20`, `Foo: 1_19_2021`. */
export const DATED_NAME = /^(.{4,}?)[\s:—-]+\d{1,2}[ ._/-]\d{1,2}(?:[ ._/-]\d{2,4})?$/;

/**
 * Undo the Evernote export's filename encoding. It could not put `:` or `<>` in a name, so
 * `Michael Voigt_ 1 on 1` is a colon, `Azumo __ Big Run Studios` is a "between these two"
 * thread, and a bare `Paul_Foster` is just a space. A trailing `.1`/`.2` is a collision
 * suffix, stripped so the halves fold into one thread.
 */
export function normalizeTitle(base: string): string {
  return base
    .replace(/\.\d+$/, "")
    .replace(/\s*__\s*/g, " <> ")
    .replace(/_\s+/g, ": ")
    .replace(/_/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Every `.md` under `dir`, recursively. Dotfiles and Obsidian's `_resources` bins are
 *  not content — the bins are the attachment store, reached by name, never by the tree. */
export function walkVault(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name === "_resources") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkVault(p, out);
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

export interface Candidate {
  path: string;
  rel: string;
  title: string;
  employer: string;
  dir: string;
}

/** The files the ENGAGEMENT importer owns: thread notes under `Jobs/`. */
export function engagementCandidates(vault: string): Candidate[] {
  const out: Candidate[] = [];
  for (const p of walkVault(join(vault, "Jobs"))) {
    const rel = relative(vault, p);
    const parts = rel.split(sep);
    if (!parts.some((seg) => THREAD_DIRS.has(seg))) continue;
    // `Name.1.md` / `Name.2.md` are Evernote export collision suffixes, not distinct threads.
    const base = parts[parts.length - 1].replace(/\.md$/, "");
    const title = normalizeTitle(base);
    if (NOT_A_THREAD.some((re) => re.test(base))) continue;
    // `Jobs/<Employer>/…` — but `Jobs/Interviews/` is a thread directory at the top level,
    // with no employer above it.
    const employer = parts[1] !== undefined && !THREAD_DIRS.has(parts[1]) ? parts[1] : "";
    out.push({ path: p, rel, title, employer, dir: parts.slice(0, -1).join("/") });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * Top-level vault folders the general importer leaves alone, and why. `Recipes` belongs to
 * `import-recipes.ts`, which reads each file with human eyes before writing a typed
 * `recipe` page — sweeping the rest in as plain documents would put a `document` in the
 * seat a `recipe` needs. `Templates` is Obsidian scaffolding with `{{date}}` placeholders,
 * not notes.
 */
export const SKIP_ROOTS = new Map([
  ["Recipes", "belongs to import-recipes.ts"],
  ["Templates", "Obsidian scaffolding, not notes"],
]);

/** Directories skipped wherever they appear. `Writing/Medium` is 162 HTML files (no
 *  markdown) — a Medium export needing HTML→Markdown and a dedup pass of its own. */
export const SKIP_DIRS = new Map([["Writing/Medium", "Medium HTML export — no markdown"]]);

export interface Skipped {
  rel: string;
  reason: string;
}

/**
 * The files the GENERAL importer owns: every `.md` in the vault minus the engagement
 * pass's, minus the folders above. Returns the skips too, so a dry run can account for
 * every file it saw rather than only the ones it means to write.
 */
export function importableFiles(vault: string): { files: string[]; skipped: Skipped[] } {
  const consumed = new Set(engagementCandidates(vault).map((c) => c.rel));
  const files: string[] = [];
  const skipped: Skipped[] = [];
  for (const p of walkVault(vault)) {
    const rel = relative(vault, p).split(sep).join("/");
    const root = rel.split("/")[0];
    const skipDir = [...SKIP_DIRS].find(([d]) => rel.startsWith(`${d}/`));
    if (consumed.has(relative(vault, p))) skipped.push({ rel, reason: "already imported as an engagement thread" });
    else if (SKIP_ROOTS.has(root)) skipped.push({ rel, reason: SKIP_ROOTS.get(root)! });
    else if (skipDir !== undefined) skipped.push({ rel, reason: skipDir[1] });
    else files.push(p);
  }
  return { files: files.sort(), skipped };
}
