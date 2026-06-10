/**
 * The **Markdown-disk projection** (feature: "Markdown projection to disk — live filesystem
 * mirror"). A {@link RenderSink} that mirrors a workspace's deterministic Markdown to a
 * directory and keeps it current off the SAME projection tail as the SQL read model and the
 * search index — a second consumer of the ONE per-commit render, never a second renderer.
 *
 * Design (see the feature-spec in the wiki):
 *  - **One render per commit, fanned out.** The tailer renders a commit's affected pages once
 *    and hands the resulting {@link SearchDoc}s here; this sink consumes `doc.body` (the bytes)
 *    and uses the folded `state` for the tree → path mapping. It never calls `renderPage`.
 *  - **Reconciliation — and archives are never dropped.** The set of expected files is computed
 *    from the live tree; any tracked file with no corresponding expected path is an orphan and
 *    is removed. An ARCHIVED page (or one whose ancestor — or whole workspace — is archived)
 *    stays in the expected set at a stable id-keyed path under `.archived/`, so archiving MOVES
 *    its file there (and unarchiving moves it back); only hard-deleted pages lose their file.
 *  - **Determinism ⇒ no churn.** Each rendered page is content-hashed; an unchanged page is
 *    never rewritten, so `git status` stays quiet. Writes are atomic (temp file + rename).
 *  - **Crash/restart self-heal.** A small on-disk manifest records the applied version + the
 *    path/hash of every written file. On boot the tailer reconciles disk against the stream
 *    head (a whole-workspace {@link rebuild}); a lost manifest just forces a full rebuild.
 *  - **Structural commits rebuild.** A content edit cannot move a path, so it takes the cheap
 *    affected-delta {@link applyDelta}; a STRUCTURAL commit (rename/reparent/create/archive)
 *    can move a whole subtree, so {@link rebuildOnStructural} routes it to a whole rebuild.
 *
 * It is OFF by default, scoped to an allowlist of workspaces, single-writer (one owning
 * process per `root`, documented not enforced), and writes ONLY under `root`.
 */
import { mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, posix } from "node:path";

import type { IWorkspaceState, PageId, SearchDoc, WorkspaceId } from "wiki";

import type { Logger } from "../logger.js";
import type { RenderSink } from "./render-sink.js";

/** Where + how the Markdown-disk mirror writes (the feature's config surface). */
export interface IMarkdownProjectionConfig {
  /** Master switch — the projector is built only when this is true. @default false */
  readonly enabled: boolean;
  /** Output directory; the projector writes ONLY under here (per-workspace subdirectories). */
  readonly root: string;
  /** Allowlist of workspace ids to mirror, or `"all"` for every workspace in the namespace. */
  readonly workspaces: "all" | readonly string[];
  /** Tree layout: nested folders mirroring the page tree. `"flat"` is reserved for later. */
  readonly layout: "tree";
}

/** One workspace's persisted state: applied version + every file written (path → hash, page → path). */
interface WorkspaceManifest {
  version: number;
  /** workspace-relative posix path → content hash. */
  files: Record<string, string>;
  /** page id → workspace-relative posix path (tracks moves across renames/reparents). */
  pages: Record<string, string>;
}

/** The persisted manifest for the whole `root`: workspace id → its {@link WorkspaceManifest}. */
type Manifest = Record<string, WorkspaceManifest>;

/** The manifest file name, written at the root (hidden; add to `.gitignore` if undesired). */
const MANIFEST_FILE = ".wiki-md-manifest.json";

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** A filesystem-safe slug from a title: lowercase, non-alphanumerics → `-`, collapsed/trimmed. */
export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return s.length > 0 ? s : "untitled";
}

/** The stable local part of a page/workspace id (after the `type:` prefix) — used to disambiguate. */
function shortId(id: string): string {
  const colon = id.indexOf(":");
  return slugify(colon >= 0 ? id.slice(colon + 1) : id);
}

/** True iff some page in `state` is a child of `pageId` (so it becomes a folder with `index.md`). */
function hasChildren(pageId: PageId, state: IWorkspaceState): boolean {
  for (const p of state.pages.values()) if ((p.parentId as PageId | null) === pageId) return true;
  return false;
}

/**
 * True iff the page is hidden from default wiki views: its WORKSPACE is archived, or it — or
 * any ancestor — is an archived page (matching the wiki hiding an archived subtree).
 */
function effectivelyArchived(pageId: PageId, state: IWorkspaceState): boolean {
  if (state.status === "archived") return true;
  let cur: PageId | null = pageId;
  const seen = new Set<string>();
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const node = state.pages.get(cur);
    if (node === undefined) return false;
    if (node.archived === true) return true;
    cur = node.parentId as PageId | null;
  }
  return false;
}

/**
 * This page's slug among its siblings: the title slug, suffixed with the page's short id ONLY
 * when a sibling's title slugifies to the same base (so the common case stays clean + readable
 * and a rare collision is still unique + deterministic). The engine's unique-sibling-title
 * invariant means a collision needs two DISTINCT titles with the same slug.
 */
function siblingSlug(pageId: PageId, state: IWorkspaceState): string {
  const node = state.pages.get(pageId);
  if (node === undefined) return shortId(pageId);
  const base = slugify(node.title);
  for (const p of state.pages.values()) {
    if (p.id === pageId) continue;
    if ((p.parentId as PageId | null) === (node.parentId as PageId | null) && slugify(p.title) === base) {
      return `${base}-${shortId(pageId)}`;
    }
  }
  return base;
}

/** The directory archived pages' files live under, inside the workspace directory. */
const ARCHIVED_DIR = ".archived";

/**
 * The filesystem-safe file name for an archived page, derived from its ID — not its tree
 * position — so the file NEVER moves again once archived (renames/reparents above it, even a
 * later hard-delete of an ancestor, leave it untouched). Ids are `type:localpart` (lowercase
 * base36); the `:` separator is the one filesystem-unsafe character, mapped to `--`, and any
 * other unexpected character is defensively mapped to `-`.
 */
export function archivedFileName(pageId: string): string {
  return `${pageId.replace(/:/g, "--").replace(/[^A-Za-z0-9._-]+/g, "-")}.md`;
}

/**
 * The workspace-relative posix path for a page's Markdown. A live page maps onto the tree: a
 * folder per ancestor slug, then the page's own slug as `index.md` if it has children else
 * `<slug>.md`. An effectively-archived page (itself, an ancestor, or the whole workspace
 * archived) maps to a FLAT, stable, id-keyed `.archived/<id>.md` instead — so archiving moves
 * the file there rather than deleting it, and the path survives any later tree churn.
 */
export function pageRelPath(pageId: PageId, state: IWorkspaceState): string {
  if (effectivelyArchived(pageId, state)) return posix.join(ARCHIVED_DIR, archivedFileName(pageId));

  const slugs: string[] = [];
  let cur: PageId | null = pageId;
  const seen = new Set<string>();
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    if (state.pages.get(cur) === undefined) break;
    slugs.unshift(siblingSlug(cur, state));
    cur = state.pages.get(cur)!.parentId as PageId | null;
  }
  const rel = slugs.join("/");
  return hasChildren(pageId, state) ? `${rel}/index.md` : `${rel}.md`;
}

/** The per-workspace subdirectory under `root` (workspace name slug, id-disambiguated if empty). */
function workspaceDir(state: IWorkspaceState): string {
  const base = slugify(state.name);
  return base === "untitled" ? shortId(state.id) : base;
}

/**
 * The Markdown-disk mirror. Constructed only when enabled; {@link init} loads the manifest, then
 * it is registered as a {@link RenderSink} on the projection tailer.
 */
export class MarkdownDiskProjector implements RenderSink {
  readonly name = "markdown-disk";
  readonly rebuildOnStructural = true;

  private manifest: Manifest = {};
  private tmpCounter = 0;

  constructor(
    private readonly cfg: IMarkdownProjectionConfig,
    private readonly logger: Logger,
  ) {}

  /** Load the persisted manifest (best-effort: a missing/corrupt manifest starts empty → full rebuild). */
  async init(): Promise<void> {
    try {
      const raw = await readFile(join(this.cfg.root, MANIFEST_FILE), "utf8");
      this.manifest = JSON.parse(raw) as Manifest;
    } catch {
      this.manifest = {};
    }
  }

  /** Whether this workspace is in the configured allowlist. */
  private mirrors(workspace: WorkspaceId): boolean {
    return this.cfg.workspaces === "all" || this.cfg.workspaces.includes(workspace);
  }

  async appliedVersion(workspace: WorkspaceId): Promise<number> {
    if (!this.mirrors(workspace)) return Number.MAX_SAFE_INTEGER; // not mirrored → never "behind"
    return this.manifest[workspace]?.version ?? 0;
  }

  /**
   * A content commit (no path can move): write the changed pages' bytes at their stable paths
   * and drop any `removed` pages' files. Path-moving commits — including page/workspace
   * archive + unarchive, which relocate files to/from `.archived/` — are routed to
   * {@link rebuild} by the tailer ({@link rebuildOnStructural}), so no orphan sweep is needed here.
   */
  async applyDelta(
    workspace: WorkspaceId,
    version: number,
    docs: readonly SearchDoc[],
    removed: readonly PageId[],
    state: IWorkspaceState,
  ): Promise<void> {
    if (!this.mirrors(workspace)) return;
    const m = this.wsManifest(workspace);
    const wsDir = workspaceDir(state);
    let written = 0;
    const removedPaths: string[] = [];

    for (const id of removed) {
      const rel = m.pages[id];
      if (rel !== undefined) {
        removedPaths.push(rel);
        delete m.pages[id];
        delete m.files[rel];
      }
    }
    for (const doc of docs) {
      const rel = posix.join(wsDir, pageRelPath(doc.pageId as PageId, state));
      if (await this.writeIfChanged(rel, doc.body, m)) written++;
      m.pages[doc.pageId] = rel;
    }

    await this.removeFiles(removedPaths);
    m.version = version;
    await this.persist();
    this.logger.info("markdown-disk applied", {
      workspace,
      version,
      written,
      removed: removedPaths.length,
      unchanged: docs.length - written,
    });
  }

  /**
   * A whole-workspace reconcile (boot, lag-recovery, or a structural commit): compute the
   * expected file set from the LIVE tree, write changed pages, and remove every tracked file
   * with no corresponding expected path (deletes, the old path after a reparent/rename, a live
   * path after its page is archived — its content is in the expected set at `.archived/`).
   * `docs` is every page's render (the shared whole render), archived pages included.
   */
  async rebuild(
    workspace: WorkspaceId,
    version: number,
    docs: readonly SearchDoc[],
    state: IWorkspaceState,
  ): Promise<void> {
    if (!this.mirrors(workspace)) return;
    const m = this.wsManifest(workspace);
    const wsDir = workspaceDir(state);
    const bodyByPage = new Map<string, string>(docs.map((d) => [d.pageId, d.body]));

    // Expected: every page maps to a path — live pages onto the tree, effectively-archived
    // pages (including every page of an archived WORKSPACE) onto stable `.archived/<id>.md`
    // files. Archiving therefore MOVES content; nothing but a hard delete removes it.
    const expected = new Map<string, { pageId: string; body: string }>();
    for (const node of state.pages.values()) {
      const pageRel = pageRelPath(node.id as PageId, state);
      expected.set(posix.join(wsDir, pageRel), { pageId: node.id, body: bodyByPage.get(node.id) ?? "" });
    }

    let written = 0;
    const nextPages: Record<string, string> = {};
    const nextFiles: Record<string, string> = {};
    for (const [rel, { pageId, body }] of expected) {
      if (await this.writeIfChanged(rel, body, m)) written++;
      nextPages[pageId] = rel;
      nextFiles[rel] = m.files[rel]!; // writeIfChanged guarantees a hash for every expected file
    }

    // Orphans: any tracked file not in the new expected set (deletes, archives, old paths after moves).
    const orphans = Object.keys(m.files).filter((rel) => !expected.has(rel));
    await this.removeFiles(orphans);

    m.files = nextFiles;
    m.pages = nextPages;
    m.version = version;
    await this.persist();
    this.logger.info("markdown-disk reconciled", { workspace, version, written, removed: orphans.length, pages: expected.size });
  }

  /** Disk has no token-gated waiters; just surface the failure for operability. */
  fail(workspace: WorkspaceId, version: number, err: unknown): void {
    this.logger.warn("markdown-disk update failed", {
      workspace,
      version,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────────

  private wsManifest(workspace: WorkspaceId): WorkspaceManifest {
    const existing = this.manifest[workspace];
    if (existing !== undefined) return existing;
    const fresh: WorkspaceManifest = { version: 0, files: {}, pages: {} };
    this.manifest[workspace] = fresh;
    return fresh;
  }

  /** Write `body` to `rel` only when its hash changed; atomic (temp + rename). Returns true if written. */
  private async writeIfChanged(rel: string, body: string, m: WorkspaceManifest): Promise<boolean> {
    const hash = sha256(body);
    if (m.files[rel] === hash) return false; // determinism ⇒ no churn
    const abs = join(this.cfg.root, rel);
    await mkdir(dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp-${process.pid}-${this.tmpCounter++}`;
    await writeFile(tmp, body, "utf8");
    await rename(tmp, abs); // atomic replace on POSIX
    m.files[rel] = hash;
    return true;
  }

  /** Remove files (drop) and prune now-empty parent directories; best-effort. */
  private async removeFiles(rels: readonly string[]): Promise<void> {
    for (const rel of rels) {
      const abs = join(this.cfg.root, rel);
      await rm(abs, { force: true });
      await this.pruneEmptyDirs(dirname(abs));
    }
  }

  /** Remove empty directories upward until a non-empty one or `root` is reached (best-effort). */
  private async pruneEmptyDirs(dir: string): Promise<void> {
    let cur = dir;
    const root = this.cfg.root;
    while (cur.length > root.length && cur.startsWith(root)) {
      try {
        await rmdir(cur); // throws if non-empty → stop
      } catch {
        return;
      }
      cur = dirname(cur);
    }
  }

  /** Persist the manifest atomically (temp + rename) under `root`. */
  private async persist(): Promise<void> {
    await mkdir(this.cfg.root, { recursive: true });
    const abs = join(this.cfg.root, MANIFEST_FILE);
    const tmp = `${abs}.tmp-${process.pid}-${this.tmpCounter++}`;
    await writeFile(tmp, `${JSON.stringify(this.manifest, null, 2)}\n`, "utf8");
    await rename(tmp, abs);
  }
}
