/**
 * Import the Braindump vault's meeting / 1-on-1 / interview / vendor notes into a wiki
 * workspace as `engagement-log` pages.
 *
 * SAFE BY DEFAULT: parses everything, prints the plan, and writes NOTHING. Pass `--apply`
 * to commit. Re-running with `--apply` is idempotent — a page whose `provenance.source`
 * already names a file is skipped, so an interrupted run resumes rather than duplicating.
 *
 *   tsx scripts/import-engagement-logs.ts --vault ~/Documents/Braindump --workspace ws:…
 *   tsx scripts/import-engagement-logs.ts --vault … --workspace ws:… --apply
 *
 * Against the DEPLOYED server, once `engagement-log` has shipped there (the bundle is
 * bind-mounted from `~/wiki-server/models`, so it takes a `./deploy.sh` run — a page type
 * cannot be pushed to it remotely):
 *
 *   tsx scripts/import-engagement-logs.ts --stream-url https://hotseat.thegoldenmule.com \
 *     --workspace ws:… --apply
 *
 * Auth follows the shared CLI precedence: `--token` / `$WIKI_TOKEN`, else a stored grant
 * from `wiki-mirror login --stream-url <url>`.
 *
 * TWO SOURCE FORMATS, both present in the vault:
 *
 *  (a) Obsidian era — entries are `### MM/DD/YY` headings, newest first in the file.
 *      Anything before the first dated heading is page-level STANDING content (an
 *      `### On Deck` list, a `Feedback items:` block).
 *
 *  (b) Evernote era — no headings at all. Each entry is TERMINATED by an indented footer
 *      block (`    Created at: YYYY-MM-DD`), so the text runs body-then-footer, and a file
 *      is a concatenation of those. Evernote merged them in arbitrary order, so entries
 *      must be re-sorted by date — 20 files hold ~206 entries this way.
 *
 * ORDERING CONTRACT: `recordEntry` inserts at index 0, so entries are fed OLDEST-FIRST
 * and the newest ends up on top. Getting this backwards silently inverts every log.
 *
 * BACKDATING: a page's `createdAt` is stamped from the event's `occurredAt`, which comes
 * from `IWikiConfig.clock` — so the clock is a mutable box set to each file's own date
 * before its writes. Without that every imported page would claim to be created today.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import { createWiki } from "wiki";
import type { IStreamConfig, IWorkspaceHandle, WorkspaceId } from "wiki";
import { resolveAuthorization } from "wiki/auth-client";
import engagementPageTypes from "wiki-models/engagement";
// The folder tree is `toc` pages, so the importer's engine must know that type too.
import tocPageTypes from "wiki-models/toc";

// ────────────────────────────────────────────────────────────────────────────
// Flags
// ────────────────────────────────────────────────────────────────────────────

interface Flags {
  vault: string;
  workspace: string;
  streamUrl: string;
  namespace: string;
  apply: boolean;
  limit: number;
  only: string | undefined;
  token: string | undefined;
}

function parseFlags(argv: readonly string[]): Flags {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i < 0 || i + 1 >= argv.length) return undefined;
    const v = argv[i + 1];
    return v.startsWith("--") ? undefined : v;
  };
  const vault = flag("vault") ?? join(homedir(), "Documents", "Braindump");
  return {
    vault: resolve(vault.replace(/^~(?=$|\/)/, homedir())),
    workspace: flag("workspace") ?? "",
    streamUrl: flag("stream-url") ?? process.env.WIKI_STREAM_URL ?? "http://127.0.0.1:4437",
    namespace: flag("namespace") ?? process.env.WIKI_NAMESPACE ?? "default",
    apply: argv.includes("--apply"),
    limit: Number(flag("limit") ?? "0") || 0,
    only: flag("only"),
    token: flag("token") ?? process.env.WIKI_TOKEN,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Candidate selection
// ────────────────────────────────────────────────────────────────────────────

/** Directories whose contents are counterparty threads. */
const THREAD_DIRS = new Set([
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
const NOT_A_THREAD = [
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
const DATED_NAME = /^(.{4,}?)[\s:—-]+\d{1,2}[ ._/-]\d{1,2}(?:[ ._/-]\d{2,4})?$/;

/**
 * Undo the Evernote export's filename encoding. It could not put `:` or `<>` in a name, so
 * `Michael Voigt_ 1 on 1` is a colon, `Azumo __ Big Run Studios` is a "between these two"
 * thread, and a bare `Paul_Foster` is just a space. A trailing `.1`/`.2` is a collision
 * suffix, stripped so the halves fold into one thread.
 */
function normalizeTitle(base: string): string {
  return base
    .replace(/\.\d+$/, "")
    .replace(/\s*__\s*/g, " <> ")
    .replace(/_\s+/g, ": ")
    .replace(/_/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

interface Candidate {
  path: string;
  rel: string;
  title: string;
  employer: string;
  dir: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name === "_resources") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

function candidates(vault: string): Candidate[] {
  const jobs = join(vault, "Jobs");
  const out: Candidate[] = [];
  for (const p of walk(jobs)) {
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

interface Thread {
  key: string;
  title: string;
  employer: string;
  dir: string;
  files: Candidate[];
}

/**
 * Fold candidate files into threads. One page per (employer, title): the Evernote export
 * split a single note into `Name.md`, `Name.1.md`, `Name.2.md`, and those are the same
 * conversation. Where one title occurs under SEVERAL employers it is genuinely several
 * threads, so the employer disambiguates — the engine enforces unique sibling titles and
 * would otherwise reject the second one.
 */
function threads(found: readonly Candidate[]): Thread[] {
  // A RECURRING SERIES writes the date into the filename — `Sprint Planning 8_3_20`,
  // `Sprint Planning - 9_28_20`, `Sprint Planning_ 1_19_2021` — with the separator drifting
  // over the years, so the titles all differ and none of them collide. Those are one
  // meeting, not eleven. Collapse a dated name onto its base, but ONLY where the same
  // directory holds two or more of them: a lone `Sprint Review 3_9_16` keeps its date,
  // since one dated note is a note, not a series.
  //
  // The date is dropped rather than used — every one of these files carries its own
  // `Created at:` footer, and where the two disagree the footer is machine-stamped while
  // the filename is hand-typed (two of them are off by a year, both fitting their series
  // better on the footer's reading).
  const seriesCount = new Map<string, number>();
  for (const c of found) {
    const base = DATED_NAME.exec(c.title);
    if (base !== null) seriesCount.set(`${c.dir}/${base[1].trim()}`, (seriesCount.get(`${c.dir}/${base[1].trim()}`) ?? 0) + 1);
  }
  const seriesTitle = (c: Candidate): string => {
    const m = DATED_NAME.exec(c.title);
    if (m === null) return c.title;
    const base = m[1].trim();
    return (seriesCount.get(`${c.dir}/${base}`) ?? 0) >= 2 ? base : c.title;
  };

  const groups = new Map<string, Thread>();
  for (const raw of found) {
    const c = { ...raw, title: seriesTitle(raw) };
    const key = `${c.employer}/${c.title}`;
    const g = groups.get(key);
    if (g === undefined) groups.set(key, { key, title: c.title, employer: c.employer, dir: c.dir, files: [c] });
    else g.files.push(c);
  }
  const byTitle = new Map<string, number>();
  for (const g of groups.values()) byTitle.set(g.title, (byTitle.get(g.title) ?? 0) + 1);
  for (const g of groups.values()) {
    if ((byTitle.get(g.title) ?? 0) > 1 && g.employer.length > 0) g.title = `${g.title} (${g.employer})`;
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

// ────────────────────────────────────────────────────────────────────────────
// Parsing
// ────────────────────────────────────────────────────────────────────────────

interface Entry {
  date: string;
  iso: string | undefined;
  attendees: string | undefined;
  prep: string | undefined;
  notes: string;
}

interface Parsed {
  format: "headings" | "footers" | "single" | "merged";
  standing: string | undefined;
  entries: Entry[];
  actionItems: { text: string; on: string | undefined }[];
  onDeck: string[];
  created: string | undefined;
}

const FOOTER = /^[ \t]+(?:Created|Updated) at:[ \t]*(\d{4}-\d{2}-\d{2})/gm;
/** `### 10/26/2023`, `#### 12.9`, `### 5-3`, optionally bolded, optionally with a trailing label. */
const DATE_HEADING = /^#{2,4}\s*\**\s*(\d{1,2}[/.\-]\d{1,2}(?:[/.\-]\d{2,4})?)\b[^\n]*$/gm;
/** A labelled part inside an entry: `Notes:`, `**Notes**:`, `#### Notes`, `Action items:` … */
const LABEL = /^\s*(?:#{1,5}\s*)?\**\s*(Notes|Prep|Attendees|Agenda|Action items|Thoughts|Summary)\s*\**\s*:?\s*\**\s*$/i;

/** Strip the Evernote footer lines from a body. */
function stripFooters(s: string): string {
  return s.replace(/^[ \t]+(?:Created|Updated) at:.*$/gm, "").trimEnd();
}

/** ISO-normalize a heading date. Two-digit years map to 2000+; a bare M/D takes `fallbackYear`. */
function toIso(raw: string, fallbackYear: number | undefined): string | undefined {
  const m = raw.match(/^(\d{1,2})[/.\-](\d{1,2})(?:[/.\-](\d{2,4}))?$/);
  if (!m) return undefined;
  const month = Number(m[1]);
  const day = Number(m[2]);
  let year: number;
  if (m[3] === undefined) {
    if (fallbackYear === undefined) return undefined;
    year = fallbackYear;
  } else {
    year = Number(m[3]);
    if (year < 100) year += 2000;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Split a chunk of entry text into its labelled parts. Everything before the first label
 * is notes (the bare-bullet-list case, which is the majority).
 */
function splitParts(chunk: string): { attendees?: string; prep?: string; notes: string; actions: string[] } {
  const lines = chunk.split("\n");
  const buckets: Record<string, string[]> = { _: [], notes: [], prep: [], attendees: [], agenda: [], actions: [] };
  let current = "_";
  for (const line of lines) {
    const m = line.match(LABEL);
    if (m) {
      const key = m[1].toLowerCase();
      current =
        key === "action items" ? "actions" : key === "attendees" ? "attendees" : key === "agenda" ? "agenda" : key === "prep" ? "prep" : "notes";
      continue;
    }
    // An `Action items:` run ends at the next heading or divider. Without this the bucket
    // swallows whatever follows — one file turned a `### Proposal Review` section and its
    // paragraphs into fourteen "action items".
    if (current === "actions" && (/^\s*#{1,6}\s/.test(line) || /^\s*-{3,}\s*$/.test(line))) {
      current = "notes";
    }
    buckets[current].push(line);
  }
  const clean = (xs: string[]): string => xs.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  // Unlabelled leading text and an explicit Notes block are the same thing.
  const notes = [clean(buckets["_"]), clean(buckets["notes"])].filter((x) => x.length > 0).join("\n\n");
  // The 1-on-1 template's fixed Agenda script rides along as prep.
  const prep = [clean(buckets["prep"]), clean(buckets["agenda"])].filter((x) => x.length > 0).join("\n\n");
  // Only TOP-LEVEL bullets are commitments; indented lines are their supporting detail and
  // stay attached to the bullet above them.
  const actions: string[] = [];
  for (const raw of buckets["actions"]) {
    const m = raw.match(/^[-*]\s+(?:\[[ xX]\]\s*)?(.+)$/);
    if (m !== null && m[1].trim().length > 0) actions.push(m[1].trim());
    else if (/^\s+\S/.test(raw) && actions.length > 0) actions[actions.length - 1] += ` ${raw.trim()}`;
  }
  return {
    ...(clean(buckets["attendees"]).length > 0
      ? { attendees: clean(buckets["attendees"]).replace(/^\s*[-*]\s*/gm, "").replace(/\n+/g, ", ") }
      : {}),
    ...(prep.length > 0 ? { prep } : {}),
    notes,
    actions,
  };
}

/**
 * Oldest first — the order `recordEntry` must be fed, since each insert lands at index 0.
 * Sort by date when every entry has one (Evernote stored its entries in arbitrary order,
 * so file order is meaningless there); otherwise fall back to reversing the file, whose
 * convention is newest-at-top.
 */
function oldestFirst(entries: Entry[]): Entry[] {
  if (entries.every((e) => e.iso !== undefined)) {
    return [...entries].sort((a, b) => a.iso!.localeCompare(b.iso!));
  }
  return [...entries].reverse();
}

function parseFile(text: string): Parsed {
  const footers = [...text.matchAll(FOOTER)];
  const created = footers.length > 0 ? footers[footers.length - 1][1] : undefined;
  const headings = [...text.matchAll(DATE_HEADING)];

  const actionItems: { text: string; on: string | undefined }[] = [];
  const onDeck: string[] = [];

  // ── (a) Obsidian era: dated headings ──
  if (headings.length > 0) {
    const preamble = stripFooters(text.slice(0, headings[0].index ?? 0))
      .replace(/^\s*-{3,}\s*$/gm, "")
      .trim();
    const standing = preamble.length > 0 ? preamble : undefined;
    // A file's headings run newest→oldest; the fallback year comes from the footer, else
    // from a sibling heading that carries one.
    const fallbackYear = created !== undefined ? Number(created.slice(0, 4)) : undefined;
    const entries: Entry[] = [];
    for (let i = 0; i < headings.length; i++) {
      const start = (headings[i].index ?? 0) + headings[i][0].length;
      const end = i + 1 < headings.length ? headings[i + 1].index : text.length;
      const chunk = stripFooters(text.slice(start, end)).replace(/^\s*-{3,}\s*$/gm, "").trim();
      const raw = headings[i][1];
      const parts = splitParts(chunk);
      for (const a of parts.actions) actionItems.push({ text: a, on: raw });
      entries.push({
        date: raw,
        iso: toIso(raw, fallbackYear),
        attendees: parts.attendees,
        prep: parts.prep,
        notes: parts.notes,
      });
    }
    return { format: "headings", standing, entries: oldestFirst(entries), actionItems, onDeck, created };
  }

  // ── (b) Evernote era: footer-terminated entries ──
  if (footers.length > 0) {
    const entries: Entry[] = [];
    let cursor = 0;
    for (const f of footers) {
      // The footer block terminates the entry; a Created/Updated PAIR shares one entry, so
      // only advance on the first of a run.
      const at = f.index ?? 0;
      const body = text.slice(cursor, at);
      cursor = at + f[0].length;
      const chunk = stripFooters(body).replace(/^\s*-{3,}\s*$/gm, "").trim();
      if (chunk.length === 0) continue;
      const parts = splitParts(chunk);
      for (const a of parts.actions) actionItems.push({ text: a, on: f[1] });
      entries.push({ date: f[1], iso: f[1], attendees: parts.attendees, prep: parts.prep, notes: parts.notes });
    }
    return {
      format: entries.length > 1 ? "footers" : "single",
      standing: undefined,
      entries: oldestFirst(entries),
      actionItems,
      onDeck,
      created,
    };
  }

  // ── no date signal at all: one undated entry ──
  const parts = splitParts(stripFooters(text).trim());
  for (const a of parts.actions) actionItems.push({ text: a, on: undefined });
  const entries: Entry[] =
    parts.notes.length > 0 || parts.prep !== undefined
      ? [{ date: "undated", iso: undefined, attendees: parts.attendees, prep: parts.prep, notes: parts.notes }]
      : [];
  return { format: "single", standing: undefined, entries, actionItems, onDeck, created };
}

// ────────────────────────────────────────────────────────────────────────────
// Classification
// ────────────────────────────────────────────────────────────────────────────

type Kind = "person" | "series" | "org" | "vendor" | "candidate" | "event" | "client";

function classify(c: { dir: string }): Kind {
  const d = c.dir;
  if (/\/Interviews(\/|$)/.test("/" + d)) return "candidate";
  if (/1 on 1s|Personnel|Coworkers|HR|Recommendations|Training/.test(d)) return "person";
  if (/External Relationships/.test(d)) return "vendor";
  if (/Meetings|C-Staff/.test(d)) return "series";
  return "series";
}

// ────────────────────────────────────────────────────────────────────────────
// Import
// ────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.workspace.length === 0) {
    console.error("--workspace <ws:…> is required (create one first).");
    process.exit(2);
  }

  const found = candidates(flags.vault);
  const all = threads(found);
  const picked = flags.only !== undefined ? all.filter((t) => t.files.some((f) => f.rel.includes(flags.only!))) : all;
  const list = flags.limit > 0 ? picked.slice(0, flags.limit) : picked;

  // The clock is a mutable box: each page's writes are stamped with ITS date, so an
  // imported thread's createdAt is the day it actually started, not today.
  let now = new Date().toISOString();
  // Same auth precedence as the other CLIs (migrate-workspace, wiki-mirror): an explicit
  // token wins, else a stored OAuth grant for the origin (`wiki-mirror login`) becomes a
  // self-refreshing header, else no header at all for an open server. Without this the
  // importer can only ever talk to an unauthenticated local server.
  const authorization = resolveAuthorization(flags.streamUrl, flags.token);
  const stream: IStreamConfig = {
    baseUrl: flags.streamUrl,
    namespace: flags.namespace,
    ...(authorization !== undefined ? { headers: { authorization } } : {}),
  };
  const wiki = createWiki({ stream, pageTypes: [...engagementPageTypes, ...tocPageTypes], clock: () => now });

  const ws: IWorkspaceHandle = await wiki.openWorkspace(flags.workspace as WorkspaceId);

  // Idempotency + placement: remember where each already-imported page lives, so a re-run
  // both skips it AND can move it if the folder tree changed.
  const already = new Map<string, { id: string; parent: string | null }>();
  const tocByPath = new Map<string, string>();
  type Node = { id: string; type?: string; title?: string; children?: readonly Node[] };
  const walk = (n: Node, parent: string | null, out: { node: Node; parent: string | null }[] = []) => {
    out.push({ node: n, parent });
    for (const c of n.children ?? []) walk(c, n.id, out);
    return out;
  };
  const rootNode = (await ws.tree()) as unknown as Node;
  const seen = walk(rootNode, null);
  const rootId = rootNode.id;
  for (const { node, parent } of seen) {
    const at = parent === rootId ? null : parent;
    if (node.type === "engagement-log") {
      const state = await (await ws.page(node.id as never)).state();
      const src = state.sections.find((x) => x.key === "provenance")?.fields["source"];
      if (src !== undefined && src.kind === "scalar" && String(src.value).length > 0) {
        already.set(String(src.value), { id: node.id, parent: at });
      }
    } else if (node.type === "toc") {
      // Rebuild each toc's path from its ancestry, so a re-run reuses the existing tree
      // instead of minting a second "Interviews" beside the first.
      const chain: string[] = [];
      let cur: { node: Node; parent: string | null } | undefined = { node, parent };
      while (cur !== undefined && cur.node.id !== rootId) {
        chain.unshift(cur.node.title ?? "");
        const pid: string | null = cur.parent;
        cur = pid === null ? undefined : seen.find((x) => x.node.id === pid);
      }
      tocByPath.set(chain.join("/"), node.id);
    }
  }

  /**
   * The folder a thread belongs in, as wiki `toc` pages — the vault's own directory tree.
   * `toc` renders a DERIVED view of its children, so a folder needs no content written to
   * it: create the page, parent the threads under it, and the contents list follows.
   * Created lazily and memoized per path, parents before children.
   */
  const folderFor = async (dir: string): Promise<string | null> => {
    const segments = dir.split("/").filter((x) => x.length > 0);
    let parent: string | null = null;
    let path = "";
    for (const segment of segments) {
      path = path.length > 0 ? `${path}/${segment}` : segment;
      const hit = tocByPath.get(path);
      if (hit !== undefined) {
        parent = hit;
        continue;
      }
      if (!flags.apply) {
        parent = `(toc:${path})`;
        tocByPath.set(path, parent);
        foldersPlanned.add(path);
        continue;
      }
      const id = (await ws.createPage("toc", { title: segment, parentId: parent as never })).value;
      tocByPath.set(path, id);
      foldersPlanned.add(path);
      parent = id;
    }
    return parent;
  };

  let created = 0;
  let skipped = 0;
  let moved = 0;
  let entryTotal = 0;
  let actionTotal = 0;
  const byFormat: Record<string, number> = {};
  const foldersPlanned = new Set<string>();
  const problems: string[] = [];

  for (const th of list) {
    const source = th.files.map((f) => f.rel).join("; ");
    const existing = already.get(source);
    if (existing !== undefined) {
      skipped++;
      // Converge an earlier flat import onto the folder tree without re-importing:
      // reparent in place, keeping the page's id and its whole event history.
      const home = await folderFor(th.dir);
      if (flags.apply && home !== null && existing.parent !== home) {
        await ws.reparent(existing.id as never, home as never);
        moved++;
      }
      continue;
    }
    // Merge every file of a thread into one page, then re-sort the union: a thread split
    // across `Name.md` and `Name.1.md` is one conversation, and its two halves interleave
    // in time rather than following one another.
    const parts = th.files.map((f) => parseFile(readFileSync(f.path, "utf8")));
    const parsed: Parsed = {
      format: parts.length > 1 ? "merged" : parts[0].format,
      standing: parts.map((x) => x.standing).filter((x): x is string => x !== undefined).join("\n\n") || undefined,
      entries: oldestFirst(parts.flatMap((x) => x.entries)),
      actionItems: parts.flatMap((x) => x.actionItems),
      onDeck: parts.flatMap((x) => x.onDeck),
      created: parts.map((x) => x.created).filter((x): x is string => x !== undefined).sort()[0],
    };
    byFormat[parsed.format] = (byFormat[parsed.format] ?? 0) + 1;
    entryTotal += parsed.entries.length;
    actionTotal += parsed.actionItems.length;
    if (parsed.entries.length === 0) problems.push(`no entries parsed: ${source}`);

    if (!flags.apply) continue;

    now = parsed.created !== undefined ? `${parsed.created}T12:00:00.000Z` : new Date().toISOString();
    const home = await folderFor(th.dir);
    const pageId = (await ws.createPage("engagement-log", { title: th.title, parentId: home as never })).value;

    // One atomic batch per page: the whole thread lands or none of it does.
    const batch: { command: string; args?: Record<string, unknown> }[] = [
      { command: "setKind", args: { kind: classify(th) } },
      { command: "setSource", args: { source } },
    ];
    if (th.employer.length > 0) batch.push({ command: "setOrg", args: { org: th.employer } });
    if (parsed.standing !== undefined) batch.push({ command: "setStanding", args: { markdown: parsed.standing } });
    // OLDEST FIRST: recordEntry inserts at index 0, so this order puts the newest on top.
    for (const e of parsed.entries) {
      batch.push({
        command: "recordEntry",
        args: {
          date: e.iso ?? e.date,
          ...(e.attendees !== undefined ? { attendees: e.attendees } : {}),
          ...(e.prep !== undefined ? { prep: e.prep } : {}),
          ...(e.notes.length > 0 ? { notes: e.notes } : {}),
        },
      });
    }
    for (const a of parsed.actionItems) {
      batch.push({ command: "addActionItem", args: { text: a.text, ...(a.on !== undefined ? { on: a.on } : {}) } });
    }
    try {
      await ws.mutateMany(pageId, batch as never);
      created++;
    } catch (err) {
      problems.push(`write failed: ${source} — ${(err as Error).message}`);
    }
  }

  console.log(`vault      ${flags.vault}`);
  console.log(`workspace  ${flags.workspace}`);
  console.log(`files      ${found.length}`);
  console.log(`threads    ${all.length}${flags.only !== undefined ? ` (filtered to ${list.length})` : ""}`);
  console.log(`formats    ${Object.entries(byFormat).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  console.log(`entries    ${entryTotal}`);
  console.log(`actions    ${actionTotal}`);
  console.log(`folders    ${foldersPlanned.size}`);
  console.log(
    flags.apply
      ? `created    ${created}  (skipped ${skipped} already imported, moved ${moved} into folders)`
      : `DRY RUN — nothing written. Pass --apply.`,
  );
  if (problems.length > 0) {
    console.log(`\nproblems (${problems.length}):`);
    for (const p of problems.slice(0, 25)) console.log(`  ${p}`);
    if (problems.length > 25) console.log(`  …and ${problems.length - 25} more`);
  }

  await wiki.close();
}

await main();
