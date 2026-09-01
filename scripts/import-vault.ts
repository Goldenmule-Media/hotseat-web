/**
 * Import the REST of the Braindump vault — everything the engagement and recipe passes
 * did not claim — into a wiki workspace as a `toc` tree mirroring the vault's folders with
 * one `document` per file.
 *
 * SAFE BY DEFAULT: reads everything, prints the plan, and writes NOTHING. Pass `--apply`
 * to commit. Idempotent per FILE (not per folder, and not per thread as the engagement
 * importer is): a page whose title already sits at its folder path is skipped unless it is
 * blank, in which case it is refilled — so an interrupted run resumes exactly where it
 * stopped.
 *
 *   tsx scripts/import-vault.ts --workspace ws:… --stream-url https://hotseat.thegoldenmule.com
 *   tsx scripts/import-vault.ts --workspace ws:… --only Drums --apply
 *
 * Auth follows the shared CLI precedence: `--token` / `$WIKI_TOKEN`, else a stored grant
 * from `wiki-mirror login --stream-url <url>`.
 *
 * WHY THE MARKDOWN IS PREPROCESSED. The engine's `parseBlocks` implements CommonMark's
 * paragraph rule: consecutive lines are ONE paragraph, joined with a space. This corpus
 * does not write that way — its median plain line is 26 characters and only 13% end in
 * sentence punctuation, because it is poetry, verse citations, itinerary fields and
 * line-per-thought capture. Handing it over unchanged would silently merge ~4,250 lines.
 * So a run of consecutive plain lines is split into a paragraph each BEFORE the engine
 * sees it. The 4% that really is wrapped prose becomes two paragraphs instead of one,
 * which is the cheaper of the two errors.
 *
 * ATTACHMENTS. `![[Foo.png]]` is an Obsidian embed, resolved by name against the whole
 * vault. Each resolves to a blob uploaded to the workspace's own store and rewritten to
 * `![Foo](attachment:<sha256>)` on a line of its own — whole-line is the only position
 * `parseBlocks` reads as an image. Uploads are content-addressed, so a re-run re-uploads
 * nothing. An embed whose file never made the Evernote export becomes a visible
 * `_missing attachment_` line: never dropped, never fatal.
 *
 * BACKDATING: a page's `createdAt` is stamped from `IWikiConfig.clock`, so the clock is a
 * mutable box set to each file's own date — frontmatter `date`, else the Evernote
 * `Created at:` footer, else the file's mtime. Without it every page claims to be created
 * today, and a decade of notes lands on one afternoon.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

import { createWiki } from "wiki";
import type { IStreamConfig, IWorkspaceHandle, PageId, WorkspaceId } from "wiki";
import { AttachmentClient } from "wiki/attachments";
import { resolveAuthorization } from "wiki/auth-client";
// The importer's OWN engine must register every type it creates: `toc` for the folders,
// `document` for the notes. A missing one is rejected by the local registry before any
// write, which is loud but only at the moment it first creates that type.
import documentPageTypes from "wiki-models/document";
import tocPageTypes from "wiki-models/toc";

import { importableFiles, normalizeTitle } from "./vault-source.js";
import type { Skipped } from "./vault-source.js";

// ────────────────────────────────────────────────────────────────────────────
// Flags
// ────────────────────────────────────────────────────────────────────────────

interface Flags {
  vault: string;
  workspace: string;
  streamUrl: string;
  namespace: string;
  apply: boolean;
  createWorkspace: string | undefined;
  limit: number;
  only: string[];
  skipAttachments: boolean;
  print: boolean;
  token: string | undefined;
}

function parseFlags(argv: readonly string[]): Flags {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i < 0 || i + 1 >= argv.length) return undefined;
    const v = argv[i + 1];
    return v.startsWith("--") ? undefined : v;
  };
  const many = (name: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] !== `--${name}` || i + 1 >= argv.length) continue;
      const v = argv[i + 1];
      if (!v.startsWith("--")) out.push(v);
    }
    return out;
  };
  const vault = flag("vault") ?? join(homedir(), "Documents", "Braindump");
  return {
    vault: resolve(vault.replace(/^~(?=$|\/)/, homedir())),
    workspace: flag("workspace") ?? "",
    streamUrl: flag("stream-url") ?? process.env.WIKI_STREAM_URL ?? "http://127.0.0.1:4437",
    namespace: flag("namespace") ?? process.env.WIKI_NAMESPACE ?? "default",
    apply: argv.includes("--apply"),
    createWorkspace: flag("create-workspace"),
    limit: Number(flag("limit") ?? "0") || 0,
    only: many("only"),
    skipAttachments: argv.includes("--skip-attachments"),
    print: argv.includes("--print"),
    token: flag("token") ?? process.env.WIKI_TOKEN,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Notes — one page per (folder, title), merging the Evernote `.N` split
// ────────────────────────────────────────────────────────────────────────────

interface Note {
  /** Vault-relative folder, `/`-joined. `""` for a note at the vault root. */
  dir: string;
  title: string;
  /** Absolute paths, in `.N` order: `Foo.md`, `Foo.1.md`, `Foo.2.md`. */
  files: string[];
}

/**
 * Fold the importable files into pages. `Name.md` / `Name.1.md` / `Name.2.md` are one
 * Evernote note the export split, not three — the engine's unique-sibling-title rule would
 * reject the second anyway, and a `(2)` suffix would enshrine an export artifact as
 * content. 21 groups in this vault merge this way.
 */
function notes(vault: string, files: readonly string[]): Note[] {
  const groups = new Map<string, Note>();
  const order = (p: string): number => Number(/\.(\d+)\.md$/.exec(p)?.[1] ?? "0");
  for (const p of files) {
    const rel = relative(vault, p).split(sep).join("/");
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const title = normalizeTitle(basename(rel, ".md"));
    const key = `${dir}/${title}`;
    const hit = groups.get(key);
    if (hit === undefined) groups.set(key, { dir, title, files: [p] });
    else hit.files.push(p);
  }
  for (const n of groups.values()) n.files.sort((a, b) => order(a) - order(b));
  return [...groups.values()].sort((a, b) => `${a.dir}/${a.title}`.localeCompare(`${b.dir}/${b.title}`));
}

// ────────────────────────────────────────────────────────────────────────────
// Attachments
// ────────────────────────────────────────────────────────────────────────────

/**
 * Does this line begin a block form `parseBlocks` reads structurally? Those already carry
 * their own line semantics and must not be split apart.
 */
const STRUCTURAL = /^\s*(?:[-*+]\s|\d{1,9}\.\s|#{1,6}\s|>|\||!\[)/;

/** Obsidian's embed syntax: `![[Foo.png]]`, optionally `![[Foo.png|300]]` or `#heading`. */
const EMBED = /!\[\[([^\]]+)\]\]/g;

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".heic": "image/heic",
  ".pdf": "application/pdf",
};

/** Every file in the vault by lowercased basename — Obsidian resolves a bare `![[Foo.png]]`
 *  against the whole vault, so the importer has to as well. First match wins, as it does
 *  there; the duplicates are Evernote's `Snapshot.png` bins and either will do. */
function fileIndex(vault: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (!out.has(name.toLowerCase())) out.set(name.toLowerCase(), p);
    }
  };
  walk(vault);
  return out;
}

/** Every embed target in a note, in first-seen order. */
function embedsIn(text: string): string[] {
  return [...text.matchAll(EMBED)].map((m) => m[1]);
}

/** Resolve one embed target to an absolute path: relative to the note, then vault-absolute,
 *  then by bare name. `undefined` when the export dropped the binary (47 of these). */
function resolveEmbed(target: string, noteDir: string, vault: string, index: Map<string, string>): string | undefined {
  const clean = target.split("|")[0].split("#")[0].trim();
  if (clean.length === 0) return undefined;
  for (const cand of [resolve(noteDir, clean), resolve(vault, clean)]) {
    try {
      if (statSync(cand).isFile()) return cand;
    } catch {
      /* not there — try the next form */
    }
  }
  return index.get(basename(clean).toLowerCase());
}

// ────────────────────────────────────────────────────────────────────────────
// Markdown preprocessing
// ────────────────────────────────────────────────────────────────────────────

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const FOOTER_LINE = /^[ \t]+(?:Created|Updated) at:.*$/gm;
const FOOTER_DATE = /^[ \t]+Created at:[ \t]*(\d{4}-\d{2}-\d{2})/m;

/**
 * Fuse the ADJACENT emphasis runs a Google Docs export leaves behind:
 * `**Responsibilities****:**` is `**Responsibilities**` followed immediately by `**:**`,
 * and `_simpler problems__?_` is the same in italics. One bold phrase was cut into two,
 * so deleting the seam restores it.
 *
 * This is not cosmetic. `parseInline` reads the orphaned half as literal text — its
 * opening delimiter is not left-flanking after a closing one — and the engine then refuses
 * the commit, because that text run is not a parse fixed point of itself. Five files in
 * this vault fail to import without this.
 *
 * Both sides must be non-space, so the legitimate `__bold at a word boundary__` and two
 * genuinely separate runs (`**a** **b**`) are left alone.
 */
function fuseAdjacentEmphasis(text: string): string {
  return text.replace(/(?<=[^\s*])\*{4}(?=[^\s*])/g, "").replace(/(?<=[^\s_])__(?=[^\s_])/g, "");
}

/** Strip the YAML block 116 files carry, handing back its `date` for the clock. */
function stripFrontmatter(text: string): { body: string; date: string | undefined } {
  const m = FRONTMATTER.exec(text);
  if (m === null) return { body: text, date: undefined };
  const date = /^date:\s*(\d{4}-\d{2}-\d{2})/m.exec(m[1])?.[1];
  return { body: text.slice(m[0].length), date };
}

/** Drop the indented `Created at:` / `Updated at:` block the Evernote export left on 67%
 *  of these files, handing back the creation date for the clock. */
function stripFooter(text: string): { body: string; date: string | undefined } {
  const date = FOOTER_DATE.exec(text)?.[1];
  return { body: text.replace(FOOTER_LINE, "").trimEnd(), date };
}

/**
 * Split runs of consecutive plain lines into a paragraph each. Fence-aware, and blind to
 * anything structural — a list, table, quote or heading keeps its own shape. This is the
 * whole reason this importer preprocesses at all; see the header.
 */
function splitSoftLines(text: string): { body: string; splits: number } {
  const out: string[] = [];
  let fenced = false;
  let splits = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) fenced = !fenced;
    out.push(line);
    if (fenced) continue;
    const next = lines[i + 1];
    if (next === undefined) continue;
    const plain = (l: string): boolean => l.trim().length > 0 && !STRUCTURAL.test(l);
    if (plain(line) && plain(next)) {
      out.push("");
      splits++;
    }
  }
  return { body: out.join("\n"), splits };
}

interface Rewrite {
  body: string;
  /** Embed targets whose file is nowhere in the vault. */
  missing: string[];
}

/**
 * Rewrite `![[Foo.png]]` embeds to `attachment:` refs, each on a line of its own —
 * `parseBlocks` reads an image only at whole-line position, and three embeds sharing one
 * line (`Drums/Drum Flow Exercises.md`) would otherwise degrade to text. A PDF becomes a
 * LINK rather than an image; wiki-ui resolves `attachment:` in an href the same way.
 */
function rewriteEmbeds(
  text: string,
  noteDir: string,
  vault: string,
  index: Map<string, string>,
  refOf: (path: string) => string | undefined,
): Rewrite {
  const missing: string[] = [];
  const lines = text.split("\n");
  const out: string[] = [];
  /** One embed's replacement text: an image, a PDF link, or a visible placeholder. */
  const replace = (raw: string): string => {
    const target = raw.split("|")[0].split("#")[0].trim();
    const name = basename(target);
    const path = resolveEmbed(raw, noteDir, vault, index);
    if (path === undefined) {
      missing.push(target);
      return `_missing attachment: ${name}_`;
    }
    const ref = refOf(path);
    if (ref === undefined) return `_attachment not uploaded: ${name}_`;
    return extname(path).toLowerCase() === ".pdf" ? `[${name}](${ref})` : `![${name}](${ref})`;
  };

  for (const line of lines) {
    EMBED.lastIndex = 0;
    if (!EMBED.test(line)) {
      out.push(line);
      continue;
    }
    // A line that already has a structural prefix keeps it: a list item, a quote, a
    // heading. Replacing in place is enough — a list item's body is parsed as its own
    // block sequence, so `* ![[x.png]]` still becomes a real image block, INSIDE the item.
    // Exploding it instead would break the marker off and end the list on a blank line.
    // A link-wrapped embed (`[![[logo.webp]]](https://…)`, the BookIt vouchers) stays put
    // for the same reason: split apart, its `[` and `](url)` halves become paragraphs.
    if (STRUCTURAL.test(line) || /\[\s*!\[\[/.test(line)) {
      out.push(line.replace(EMBED, (_, raw: string) => replace(raw)));
      continue;
    }
    EMBED.lastIndex = 0;
    // An embed becomes its own line, so the remainder of a mixed line survives as prose.
    const pieces: string[] = [];
    let cursor = 0;
    let m: RegExpExecArray | null;
    while ((m = EMBED.exec(line)) !== null) {
      const before = line.slice(cursor, m.index).trim();
      if (before.length > 0) pieces.push(before);
      cursor = m.index + m[0].length;
      pieces.push(replace(m[1]));
    }
    const after = line.slice(cursor).trim();
    if (after.length > 0) pieces.push(after);
    // Blank lines around the run, so an image lands as its own block rather than joining
    // the paragraph above it.
    out.push("", ...pieces, "");
  }
  return { body: out.join("\n"), missing };
}

// ────────────────────────────────────────────────────────────────────────────
// Read-back helpers
// ────────────────────────────────────────────────────────────────────────────

type Node = { id: string; type?: string; title?: string; children?: readonly Node[] };

/** Every page in the workspace keyed by its slash-path, so a re-run reuses the tree it
 *  already built instead of minting a second "Interviews" beside the first. Covers EVERY
 *  page type, not just `toc`: this importer's skip grain is the file, so it has to
 *  recognize a `document` it wrote last time. */
function pathIndex(root: Node): Map<string, Node> {
  const out = new Map<string, Node>();
  const walk = (node: Node, path: string): void => {
    for (const child of node.children ?? []) {
      const p = path.length > 0 ? `${path}/${child.title ?? ""}` : (child.title ?? "");
      out.set(p, child);
      walk(child, p);
    }
  };
  walk(root, "");
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

// ────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.workspace.length === 0 && flags.createWorkspace === undefined) {
    console.error("--workspace <ws:…> or --create-workspace <name> is required.");
    process.exit(2);
  }

  const { files, skipped } = importableFiles(flags.vault);
  const all = notes(flags.vault, files);
  const picked =
    flags.only.length > 0
      ? all.filter((n) => flags.only.some((o) => n.files.some((f) => relative(flags.vault, f).includes(o))))
      : all;
  const list = flags.limit > 0 ? picked.slice(0, flags.limit) : picked;
  const index = fileIndex(flags.vault);

  // The clock is a mutable box: each page's writes are stamped with ITS date, so an
  // imported note's createdAt is the day it was written, not today.
  let now = new Date().toISOString();
  const authorization = resolveAuthorization(flags.streamUrl, flags.token);
  const stream: IStreamConfig = {
    baseUrl: flags.streamUrl,
    namespace: flags.namespace,
    ...(authorization !== undefined ? { headers: { authorization } } : {}),
  };
  const wiki = createWiki({ stream, pageTypes: [...tocPageTypes, ...documentPageTypes], clock: () => now });

  // `createWorkspace` APPENDS — it is a write like any other, and running it in a dry run
  // would put a real workspace on the server under a banner saying nothing was written.
  if (flags.createWorkspace !== undefined && !flags.apply) {
    console.error("--create-workspace writes; pass --apply, or target an existing --workspace.");
    process.exit(2);
  }
  const ws: IWorkspaceHandle =
    flags.createWorkspace !== undefined
      ? await wiki.createWorkspace({ name: flags.createWorkspace })
      : await wiki.openWorkspace(flags.workspace as WorkspaceId);
  if (flags.createWorkspace !== undefined) console.log(`created workspace ${ws.id}`);

  const attachments = new AttachmentClient(stream);
  const uploaded = new Map<string, string>();
  const uploadFailures: string[] = [];
  /** Upload a blob once and hand back its `attachment:` ref. Content-addressed, so a
   *  re-run costs a request and mints nothing. */
  const upload = async (path: string): Promise<string | undefined> => {
    const hit = uploaded.get(path);
    if (hit !== undefined) return hit;
    const mime = MIME[extname(path).toLowerCase()];
    if (mime === undefined) {
      uploadFailures.push(`${relative(flags.vault, path)} — no mime for ${extname(path)}`);
      return undefined;
    }
    if (!flags.apply) {
      const ref = `attachment:${"0".repeat(64)}`;
      uploaded.set(path, ref);
      return ref;
    }
    try {
      const meta = await attachments.upload(ws.id, readFileSync(path), mime, basename(path));
      const ref = `attachment:${meta.id}`;
      uploaded.set(path, ref);
      return ref;
    } catch (err) {
      uploadFailures.push(`${relative(flags.vault, path)} — ${(err as Error).message}`);
      return undefined;
    }
  };

  const byPath = pathIndex((await ws.tree()) as unknown as Node);
  const foldersPlanned = new Set<string>();

  /**
   * The folder a note belongs in, as wiki `toc` pages — the vault's own directory tree.
   * `toc` renders a DERIVED view of its children, so a folder needs no content written to
   * it. Created lazily and memoized per path, parents before children — so a folder
   * holding only attachments never becomes a page.
   */
  const folderFor = async (dir: string): Promise<string | null> => {
    let parent: string | null = null;
    let path = "";
    for (const segment of dir.split("/").filter((x) => x.length > 0)) {
      path = path.length > 0 ? `${path}/${segment}` : segment;
      const hit = byPath.get(path);
      if (hit !== undefined) {
        parent = hit.id;
        continue;
      }
      foldersPlanned.add(path);
      if (!flags.apply) {
        const fake = { id: `(toc:${path})` };
        byPath.set(path, fake);
        parent = fake.id;
        continue;
      }
      const id: string = (await ws.createPage("toc", { title: segment, parentId: parent as never })).value;
      byPath.set(path, { id, type: "toc", title: segment });
      parent = id;
    }
    return parent;
  };

  let created = 0;
  let refilled = 0;
  let skippedPages = 0;
  let merged = 0;
  let empty = 0;
  let splitCount = 0;
  const missingEmbeds: string[] = [];
  const problems: string[] = [];
  const perRoot = new Map<string, number>();

  for (const note of list) {
    if (note.files.length > 1) merged++;
    const path = note.dir.length > 0 ? `${note.dir}/${note.title}` : note.title;
    const existing = byPath.get(path);
    // `--print` is a preview of what this importer WOULD emit, so it never consults the
    // server: in an already-imported workspace the skip below would silence all of it.
    const blank =
      !flags.print && existing !== undefined && !existing.id.startsWith("(") && (await isBlank(ws, existing.id as PageId));
    if (!flags.print && existing !== undefined && !blank) {
      skippedPages++;
      continue;
    }

    // Merged halves are concatenated in `.N` order behind a divider: they are one note the
    // export cut in two, and the seam is worth seeing.
    const parts: string[] = [];
    let date: string | undefined;
    for (const file of note.files) {
      const fm = stripFrontmatter(fuseAdjacentEmphasis(readFileSync(file, "utf8")));
      const ft = stripFooter(fm.body);
      date ??= fm.date ?? ft.date;
      // Upload before rewriting: the rewrite needs every ref to already exist, and an
      // upload is async while a rewrite is not.
      if (!flags.skipAttachments) {
        for (const target of embedsIn(ft.body)) {
          const path = resolveEmbed(target, dirname(file), flags.vault, index);
          if (path !== undefined) await upload(path);
        }
      }
      const rw = flags.skipAttachments
        ? { body: ft.body, missing: [] as string[] }
        : rewriteEmbeds(ft.body, dirname(file), flags.vault, index, (p) => uploaded.get(p));
      missingEmbeds.push(...rw.missing.map((t) => `${relative(flags.vault, file)} → ${t}`));
      const split = splitSoftLines(rw.body);
      splitCount += split.splits;
      const trimmed = split.body.trim();
      if (trimmed.length > 0) parts.push(trimmed);
    }
    const body = parts.join("\n\n---\n\n");
    if (flags.print) {
      console.log(`\n═══ ${path} ═══\n${body}`);
      continue;
    }
    if (body.length === 0) empty++;
    // A note that is nothing but an Evernote footer has no body to write. Once its page
    // exists there is nothing a re-run could add, and `isBlank` would call it a refill
    // every time — so it is left alone, and the report says so.
    if (blank && body.length === 0) {
      skippedPages++;
      continue;
    }

    const root = note.dir.split("/")[0] || "(root)";
    perRoot.set(root, (perRoot.get(root) ?? 0) + 1);

    if (!flags.apply) {
      if (existing === undefined) created++;
      else refilled++;
      await folderFor(note.dir);
      continue;
    }

    // The stat is the last resort for a note with neither frontmatter nor a footer date.
    now = date !== undefined ? `${date}T12:00:00.000Z` : statSync(note.files[0]).mtime.toISOString();
    try {
      let pageId: string;
      if (existing !== undefined) {
        pageId = existing.id;
        refilled++;
      } else {
        const home = await folderFor(note.dir);
        pageId = (await ws.createPage("document", { title: note.title, parentId: home as never })).value;
        byPath.set(path, { id: pageId, type: "document", title: note.title });
        created++;
      }
      if (body.length > 0) await ws.mutate(pageId as never, "setMarkdown" as never, { markdown: body } as never);
    } catch (err) {
      problems.push(`${path} — ${(err as Error).message}`);
    }
  }

  const bytes = [...uploaded.keys()].reduce((n, p) => n + statSync(p).size, 0);
  console.log(`vault       ${flags.vault}`);
  console.log(`server      ${flags.streamUrl}`);
  console.log(`workspace   ${ws.id}`);
  console.log(`files       ${files.length} importable, ${skipped.length} skipped`);
  console.log(`pages       ${list.length}${flags.only.length > 0 || flags.limit > 0 ? ` (filtered from ${all.length})` : ""}`);
  console.log(`  merged    ${merged} (Evernote .N splits folded into one page)`);
  console.log(`  empty     ${empty} (page created, no body)`);
  console.log(`folders     ${foldersPlanned.size} toc pages`);
  console.log(`splits      ${splitCount} soft line breaks made paragraphs`);
  console.log(
    `attachments ${uploaded.size} blobs, ${(bytes / 1e6).toFixed(1)} MB${flags.skipAttachments ? " (SKIPPED)" : ""}`,
  );
  console.log(`  missing   ${missingEmbeds.length} embeds whose file is not in the vault`);
  const byReason = new Map<string, number>();
  for (const s of skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
  for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) console.log(`skipped     ${n} — ${reason}`);
  console.log("\nby top-level folder:");
  for (const [root, n] of [...perRoot].sort((a, b) => b[1] - a[1])) console.log(`  ${root.padEnd(16)} ${n}`);
  console.log(
    flags.apply
      ? `\ncreated ${created}, refilled ${refilled}, left alone ${skippedPages}`
      : `\nwould create ${created}, refill ${refilled}, leave alone ${skippedPages}` +
          `\nDRY RUN — nothing written. Pass --apply.`,
  );
  const report = (label: string, xs: readonly string[]): void => {
    if (xs.length === 0) return;
    console.log(`\n${label} (${xs.length}):`);
    for (const x of xs.slice(0, 20)) console.log(`  ${x}`);
    if (xs.length > 20) console.log(`  …and ${xs.length - 20} more`);
  };
  report("missing attachments", missingEmbeds);
  report("upload failures", uploadFailures);
  report("problems", problems);

  await wiki.close();
}

await main();
