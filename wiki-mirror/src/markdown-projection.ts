/**
 * The **Markdown-disk projector** — relocated from wiki-mcp into `wiki-mirror` unchanged
 * (it was always a pure write-side sink depending only on `wiki`'s public types + Node `fs`).
 * It takes a commit's already-rendered {@link SearchDoc}s plus the folded {@link IWorkspaceState}
 * and mirrors a workspace's deterministic Markdown to a directory. In `wiki-mirror` it is no
 * longer a `RenderSink` registered on a shared projection tail — the {@link WorkspaceMirror}
 * tail loop owns it and calls {@link init}/{@link rebuild}/{@link applyDelta}/{@link fail}
 * directly.
 *
 * Layout: the root IS the mirror. A whole-workspace mirror puts its top-level pages directly
 * under `root`; a subtree mirror ({@link IMarkdownProjectionConfig.subtreeRootId}) writes that
 * page to `root/index.md` with its descendants beneath it. `.archived/` and `.assets/` sit at
 * `root` either way. A manifest written under another layout or scope rebuilds on first sight.
 *
 * Design:
 *  - **One render per commit.** The tail renders a commit's pages once and hands the resulting
 *    {@link SearchDoc}s here; this projector consumes `doc.body` (the bytes) and uses the folded
 *    `state` for the tree → path mapping. It never calls `renderPage`.
 *  - **Reconciliation — and archives are never dropped.** The expected file set is computed from
 *    the live tree; any tracked file with no expected path is an orphan and is removed. An
 *    ARCHIVED page (or one whose ancestor — or whole workspace — is archived) stays in the
 *    expected set at a stable id-keyed path under `.archived/`, so archiving MOVES its file there
 *    (and unarchiving moves it back); only hard-deleted pages lose their file.
 *  - **Determinism ⇒ no churn.** Each rendered page is content-hashed; an unchanged page is never
 *    rewritten, so `git status` stays quiet. Writes are atomic (temp file + rename).
 *  - **Crash/restart self-heal.** A small on-disk manifest records the applied version + the
 *    path/hash of every written file. On boot the mirror reconciles disk against the stream head
 *    (a whole-workspace {@link rebuild}); a lost manifest just forces a full rebuild.
 *  - **Structural commits rebuild.** A content edit cannot move a path; a STRUCTURAL commit
 *    (rename/reparent/create/archive) can move a whole subtree, so {@link rebuildOnStructural}
 *    routes it to a whole rebuild (the mirror's loop always reconciles to head, so this is moot
 *    there, but the flag is preserved for parity).
 *
 * Single-writer (one owning process per `root`, documented not enforced); writes ONLY under `root`.
 */
import { mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, posix } from "node:path";

import type { IWorkspaceState, PageId, SearchDoc, WorkspaceId } from "wiki";
import { attachmentRefsIn, type AttachmentClient } from "wiki/attachments";

import type { Logger } from "./logger.js";

/** Where + how the Markdown-disk mirror writes (the projector's config surface). */
export interface IMarkdownProjectionConfig {
  /** Master switch — the projector is built only when this is true. @default false */
  readonly enabled: boolean;
  /** Output directory; the projector writes ONLY under here, and the tree starts right at it. */
  readonly root: string;
  /** Allowlist of workspace ids to mirror, or `"all"` for every workspace in the namespace. */
  readonly workspaces: "all" | readonly string[];
  /** Tree layout: nested folders mirroring the page tree. `"flat"` is reserved for later. */
  readonly layout: "tree";
  /**
   * Mirror only this page and its descendants: the page renders to `<root>/index.md` and its
   * descendants nest beneath it. Absent = the whole workspace, top-level pages at `<root>/`.
   */
  readonly subtreeRootId?: string;
}

/** One workspace's persisted state: applied version + every file written (path → hash, page → path). */
interface WorkspaceManifest {
  version: number;
  /** workspace-relative posix path → content hash. */
  files: Record<string, string>;
  /** page id → workspace-relative posix path (tracks moves across renames/reparents). */
  pages: Record<string, string>;
  /**
   * page id → the asset files that page references. Needed only for FROZEN pages: their
   * body is never re-rendered, so nothing else would keep their images out of the orphan
   * sweep, and a partial-registry boot would delete every image under an
   * unregistered-type page while keeping its `.md`. Absent in an older manifest, which
   * simply means "none tracked yet" — the next rebuild populates it.
   */
  assets?: Record<string, string[]>;
  /** {@link LAYOUT_VERSION} the files were written under; absent = the old workspace-slug layout. */
  layout?: number;
  /** The subtree root the files were written for, or null for the whole workspace. */
  scope?: string | null;
}

/** Bumped when the path rule changes, so an old manifest rebuilds and sweeps its files. */
const LAYOUT_VERSION = 2;

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

/**
 * True iff `pageId`'s mirror path can be computed faithfully from this fold: it resolves
 * to the stable id-keyed `.archived/` form before the ancestor walk needs a missing node,
 * or its whole parent chain is present. A chain broken by a page the fold skipped
 * (`state.retired` — a not-yet-loaded or retired type) silently TRUNCATES the path
 * {@link pageRelPath} computes, so such a page must be left where it is on disk rather
 * than moved or swept (boot-race bug: an early partial-registry rebuild deleted the
 * mirrored files of every page under an unregistered-type ancestor).
 */
function hasReliablePath(pageId: PageId, state: IWorkspaceState): boolean {
  if (state.status === "archived") return true; // whole workspace → id-keyed .archived paths
  let cur: PageId | null = pageId;
  const seen = new Set<string>();
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const node = state.pages.get(cur);
    if (node === undefined) return false; // broken chain → pageRelPath would truncate
    if (node.archived === true) return true; // id-keyed .archived path from here up
    cur = node.parentId as PageId | null;
  }
  return true;
}

/**
 * Per-root write serialization. Reconciles and deltas for ONE root can arrive from several
 * callers at once (the live tail, a boot back-fill — possibly via a REPLACED projector
 * instance for the same root), and the manifest + tree mutations interleave destructively. The
 * lock is keyed by root and module-global so it also covers two projector instances over the
 * same directory.
 */
const rootLocks = new Map<string, Promise<unknown>>();
function withRootLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const prev = rootLocks.get(root) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  rootLocks.set(root, run.catch(() => undefined));
  return run;
}

/** The directory archived pages' files live under, at the mirror root. */
const ARCHIVED_DIR = ".archived";

/** Where a workspace's attachment bytes land, beside `.archived` in the same tree. */
const ASSETS_DIR = ".assets";

/** File extension for a stored mime. Unknown types get none — the bytes still resolve. */
const EXT_BY_MIME: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/avif": ".avif",
  "application/pdf": ".pdf",
};

function extForMime(mime: string): string {
  return EXT_BY_MIME[mime.split(";")[0]!.trim().toLowerCase()] ?? "";
}

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
 * The root-relative posix path for a page's Markdown. A live page maps onto the tree: a
 * folder per ancestor slug, then the page's own slug as `index.md` if it has children else
 * `<slug>.md`. With a `subtreeRootId` the walk stops at that page, which itself is always
 * `index.md`. An effectively-archived page (itself, an ancestor, or the whole workspace
 * archived) maps to a FLAT, stable, id-keyed `.archived/<id>.md` instead — so archiving moves
 * the file there rather than deleting it, and the path survives any later tree churn.
 */
export function pageRelPath(pageId: PageId, state: IWorkspaceState, subtreeRootId?: string): string {
  if (effectivelyArchived(pageId, state)) return posix.join(ARCHIVED_DIR, archivedFileName(pageId));
  if (pageId === subtreeRootId) return "index.md";

  const slugs: string[] = [];
  let cur: PageId | null = pageId;
  const seen = new Set<string>();
  while (cur !== null && cur !== subtreeRootId && !seen.has(cur)) {
    seen.add(cur);
    if (state.pages.get(cur) === undefined) break;
    slugs.unshift(siblingSlug(cur, state));
    cur = state.pages.get(cur)!.parentId as PageId | null;
  }
  const rel = slugs.join("/");
  return hasChildren(pageId, state) ? `${rel}/index.md` : `${rel}.md`;
}

/**
 * Whether `pageId` is `subtreeRootId` or one of its descendants: true/false when the parent
 * chain is whole, undefined when it breaks on a page the fold skipped (membership unknown).
 */
export function inSubtree(pageId: PageId, state: IWorkspaceState, subtreeRootId: string): boolean | undefined {
  let cur: PageId | null = pageId;
  const seen = new Set<string>();
  while (cur !== null && !seen.has(cur)) {
    if (cur === subtreeRootId) return true;
    seen.add(cur);
    const node = state.pages.get(cur);
    if (node === undefined) return undefined;
    cur = node.parentId as PageId | null;
  }
  return false;
}

/** The pages a mirror scoped to `subtreeRootId` writes (every page when unscoped). */
export function pagesInScope(state: IWorkspaceState, subtreeRootId?: string): PageId[] {
  const ids = [...state.pages.keys()];
  return subtreeRootId === undefined ? ids : ids.filter((id) => inSubtree(id, state, subtreeRootId) === true);
}

/** Everything a manifest records except its version, for "did this rebuild change anything?". */
function manifestFingerprint(m: WorkspaceManifest): string {
  const sorted = <T>(r: Record<string, T> | undefined): [string, T][] =>
    Object.entries(r ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([sorted(m.files), sorted(m.pages), sorted(m.assets), m.layout ?? null, m.scope ?? null]);
}

/**
 * The Markdown-disk mirror. Constructed per configured workspace by {@link WorkspaceMirror};
 * {@link init} loads + verifies the manifest, then the tail loop drives
 * {@link rebuild}/{@link applyDelta} from each commit's render.
 */
export class MarkdownDiskProjector {
  readonly name = "markdown-disk";
  readonly rebuildOnStructural = true;

  private manifest: Manifest = {};
  private tmpCounter = 0;

  constructor(
    private readonly cfg: IMarkdownProjectionConfig,
    private readonly logger: Logger,
    /**
     * Downloads the bytes an `attachment:` ref points at. Optional: without it the refs
     * stay verbatim in the Markdown (still correct, just not resolvable on disk), which
     * is what keeps every existing test and a blob-less server working unchanged.
     */
    private readonly attachments?: AttachmentClient,
  ) {}

  /** The absolute on-disk root this projector writes under (surfaced in the mirror's status). */
  get root(): string {
    return this.cfg.root;
  }

  /** The page this mirror is scoped to, or undefined for the whole workspace. */
  get subtreeRootId(): string | undefined {
    return this.cfg.subtreeRootId;
  }

  private get scope(): string | null {
    return this.cfg.subtreeRootId ?? null;
  }

  /**
   * Load the persisted manifest (best-effort: a missing/corrupt manifest starts empty →
   * full rebuild), then VERIFY it against disk: a manifest entry whose file is missing —
   * or whose bytes no longer hash to the recorded value (an out-of-band edit, e.g. a git
   * checkout over the mirror) — is dropped and its workspace's version zeroed, so the
   * next reconcile rebuilds instead of hash-skipping stale or absent files. Without this,
   * a partially-wiped or externally-touched output dir never self-heals —
   * `appliedVersion` reports current and `writeIfChanged` dedupes on the recorded hash,
   * so re-registering the emitter is a no-op.
   */
  async init(): Promise<void> {
    return withRootLock(this.cfg.root, () => this.initLocked());
  }

  private async initLocked(): Promise<void> {
    try {
      const raw = await readFile(join(this.cfg.root, MANIFEST_FILE), "utf8");
      this.manifest = JSON.parse(raw) as Manifest;
    } catch {
      this.manifest = {};
      return;
    }
    for (const [workspace, m] of Object.entries(this.manifest)) {
      // A manifest from another layout or scope must not take the "already current" shortcut:
      // the rebuild is what sweeps its old files and writes the new tree.
      if (m.layout !== LAYOUT_VERSION || (m.scope ?? null) !== this.scope) {
        m.version = 0;
        this.logger.info("markdown-disk layout or scope changed; rebuilding", {
          workspace,
          from: m.scope ?? null,
          to: this.scope,
        });
      }
      let stale = 0;
      for (const [rel, hash] of Object.entries(m.files)) {
        let ok = false;
        try {
          // Hash the raw BYTES, not a utf8 decode: an asset (a PNG, a PDF) would not
          // survive the round-trip and would read as stale on every boot, re-downloading
          // every attachment each restart. For text the digest is identical either way.
          ok = createHash("sha256").update(await readFile(join(this.cfg.root, rel))).digest("hex") === hash;
        } catch {
          // missing/unreadable → not ok
        }
        if (!ok) {
          delete m.files[rel];
          stale++;
        }
      }
      if (stale === 0) continue;
      for (const [pageId, rel] of Object.entries(m.pages)) {
        if (m.files[rel] === undefined) delete m.pages[pageId];
      }
      m.version = 0; // lag the sink so the next reconcile/commit takes the rebuild path
      this.logger.warn("markdown-disk manifest disagreed with disk; forcing a rebuild", {
        workspace,
        stale,
      });
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
   * {@link rebuild} by the tail, so no orphan sweep is needed here.
   */
  async applyDelta(
    workspace: WorkspaceId,
    version: number,
    docs: readonly SearchDoc[],
    removed: readonly PageId[],
    state: IWorkspaceState,
  ): Promise<void> {
    if (!this.mirrors(workspace)) return;
    return withRootLock(this.cfg.root, () => this.applyDeltaLocked(workspace, version, docs, removed, state));
  }

  private async applyDeltaLocked(
    workspace: WorkspaceId,
    version: number,
    docs: readonly SearchDoc[],
    removed: readonly PageId[],
    state: IWorkspaceState,
  ): Promise<void> {
    const m = this.wsManifest(workspace);
    const scope = this.cfg.subtreeRootId;
    let written = 0;
    const removedPaths: string[] = [];

    for (const id of removed) {
      // Absent from the fold because its type isn't registered (yet) ≠ deleted — keep the file.
      if (state.retired?.has(id) === true) continue;
      const rel = m.pages[id];
      if (rel !== undefined) {
        removedPaths.push(rel);
        delete m.pages[id];
        delete m.files[rel];
      }
    }
    for (const doc of docs) {
      if (scope !== undefined && inSubtree(doc.pageId as PageId, state, scope) !== true) continue;
      const rel = pageRelPath(doc.pageId as PageId, state, scope);
      if (await this.writeIfChanged(rel, doc.body, m)) written++;
      m.pages[doc.pageId] = rel;
    }

    await this.removeFiles(removedPaths);
    m.version = version;
    if (written > 0 || removedPaths.length > 0) await this.persist();
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
   *
   * Pages the fold could not see are FROZEN, never swept: a page in `state.retired` (its
   * type isn't registered — a boot still loading bundles, or a genuinely retired type) and
   * any page whose path a retired ancestor would truncate ({@link hasReliablePath}) keep
   * their tracked file + manifest entry untouched. "Unfoldable" is not "deleted"; a later
   * rebuild with the full registry converges the tree and sweeps real orphans.
   */
  async rebuild(
    workspace: WorkspaceId,
    version: number,
    docs: readonly SearchDoc[],
    state: IWorkspaceState,
  ): Promise<void> {
    if (!this.mirrors(workspace)) return;
    return withRootLock(this.cfg.root, () => this.rebuildLocked(workspace, version, docs, state));
  }

  private async rebuildLocked(
    workspace: WorkspaceId,
    version: number,
    docs: readonly SearchDoc[],
    state: IWorkspaceState,
  ): Promise<void> {
    const m = this.wsManifest(workspace);
    const scope = this.cfg.subtreeRootId;
    // A vanished subtree root must never read as "everything below it was deleted": refuse,
    // and leave the tree and manifest exactly as they are until the root comes back.
    if (scope !== undefined && !state.pages.has(scope as PageId)) {
      if (state.retired?.has(scope as PageId) === true) {
        throw new Error(`subtree root ${scope} has a page type this mirror hasn't loaded`);
      }
      throw new Error(`subtree root ${scope} not found in workspace ${workspace}`);
    }
    const before = manifestFingerprint(m);
    const bodyByPage = new Map<string, string>(docs.map((d) => [d.pageId, d.body]));

    // Expected: every reliably-pathed page maps to a path — live pages onto the tree,
    // effectively-archived pages (including every page of an archived WORKSPACE) onto stable
    // `.archived/<id>.md` files. Archiving therefore MOVES content; nothing but a hard
    // delete removes it. Pages whose path would be truncated by a retired ancestor are
    // frozen instead of written somewhere wrong.
    const expected = new Map<string, { pageId: string; body: string }>();
    const frozen: string[] = [...(state.retired ?? [])];
    for (const node of state.pages.values()) {
      if (!hasReliablePath(node.id as PageId, state)) {
        frozen.push(node.id);
        continue;
      }
      if (scope !== undefined) {
        const member = inSubtree(node.id as PageId, state, scope);
        if (member === undefined) frozen.push(node.id);
        if (member !== true) continue;
      }
      const pageRel = pageRelPath(node.id as PageId, state, scope);
      expected.set(pageRel, { pageId: node.id, body: bodyByPage.get(node.id) ?? "" });
    }

    // Attachments: download what the bodies reference and rewrite the refs to relative
    // paths. This MUTATES the bodies in `expected`, so it must run before they are written.
    const { assetsByPage, written: assetsWritten } = await this.materializeAssets(workspace, expected, m);

    let written = 0;
    const nextPages: Record<string, string> = {};
    const nextFiles: Record<string, string> = {};
    const nextAssets: Record<string, string[]> = {};
    for (const [rel, { pageId, body }] of expected) {
      if (await this.writeIfChanged(rel, body, m)) written++;
      nextPages[pageId] = rel;
      nextFiles[rel] = m.files[rel]!; // writeIfChanged guarantees a hash for every expected file
      // Re-register this page's assets EVERY rebuild. The orphan sweep below is driven by
      // nextFiles, so an asset left out of it is deleted — and one no longer referenced
      // is collected for free by the same rule.
      const mine = assetsByPage[pageId];
      if (mine !== undefined) {
        nextAssets[pageId] = mine;
        for (const assetRel of mine) nextFiles[assetRel] = m.files[assetRel]!;
      }
    }

    // Frozen pages keep their last-known file + manifest entry verbatim (no write, no move).
    // Their assets come along: nothing re-renders their body, so nothing else would keep
    // those files out of the sweep.
    const kept = new Set<string>();
    for (const pageId of frozen) {
      const rel = m.pages[pageId];
      if (rel === undefined || expected.has(rel)) continue;
      nextPages[pageId] = rel;
      if (m.files[rel] !== undefined) nextFiles[rel] = m.files[rel];
      kept.add(rel);
      const mine = m.assets?.[pageId];
      if (mine !== undefined) {
        nextAssets[pageId] = mine;
        for (const assetRel of mine) {
          if (m.files[assetRel] !== undefined) nextFiles[assetRel] = m.files[assetRel];
          kept.add(assetRel);
        }
      }
    }

    // Orphans: any tracked file not in the new expected set (deletes, archives, old paths
    // after moves, unreferenced assets) — frozen pages' files excepted.
    const orphans = Object.keys(m.files).filter(
      (rel) => !expected.has(rel) && !kept.has(rel) && nextFiles[rel] === undefined,
    );
    await this.removeFiles(orphans);

    m.files = nextFiles;
    m.pages = nextPages;
    m.assets = nextAssets;
    m.layout = LAYOUT_VERSION;
    m.scope = this.scope;
    m.version = version;
    // The version alone changing is not worth a write: the manifest is committed beside the
    // mirror, and a scoped mirror would otherwise churn on every commit outside its subtree.
    if (manifestFingerprint(m) !== before) await this.persist();
    this.logger.info("markdown-disk reconciled", {
      workspace,
      version,
      written,
      removed: orphans.length,
      pages: expected.size,
      ...(assetsWritten > 0 ? { assets: assetsWritten } : {}),
      ...(frozen.length > 0 ? { frozen: frozen.length } : {}),
    });
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

  /** Write bytes to `rel` only when their hash changed; atomic, like {@link writeIfChanged}. */
  private async writeBytesIfChanged(rel: string, bytes: Uint8Array, m: WorkspaceManifest): Promise<boolean> {
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (m.files[rel] === hash) return false;
    const abs = join(this.cfg.root, rel);
    await mkdir(dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp-${process.pid}-${this.tmpCounter++}`;
    await writeFile(tmp, bytes);
    await rename(tmp, abs);
    m.files[rel] = hash;
    return true;
  }

  /**
   * Materialize every attachment the rendered bodies reference, and rewrite those refs
   * to paths relative to the page that carries them.
   *
   * Carrier-blind on purpose: it substitutes the `attachment:<sha>` STRING, so an image
   * block's `![alt](…)` and an attachment-ref field's `[name](…)` both come out correct
   * with no branch, and a PDF needs no more code than a screenshot.
   *
   * Bytes are content-addressed, so a ref already on disk is never re-fetched — the cost
   * is one download the first time a page mentions an attachment, and nothing after.
   */
  private async materializeAssets(
    workspace: WorkspaceId,
    expected: Map<string, { pageId: string; body: string }>,
    m: WorkspaceManifest,
  ): Promise<{ assetsByPage: Record<string, string[]>; written: number }> {
    const assetsByPage: Record<string, string[]> = {};
    if (this.attachments === undefined) return { assetsByPage, written: 0 };

    // Any asset already tracked for this workspace, indexed by its content hash, so a
    // second rebuild resolves refs without touching the network.
    const knownBySha = new Map<string, string>();
    const assetPrefix = `${ASSETS_DIR}/`;
    for (const rel of Object.keys(m.files)) {
      if (!rel.startsWith(assetPrefix)) continue;
      const sha = posix.basename(rel).split(".")[0]!;
      if (/^[0-9a-f]{64}$/.test(sha)) knownBySha.set(sha, rel);
    }

    let written = 0;
    const failed = new Set<string>();
    for (const [pageRel, entry] of expected) {
      const refs = attachmentRefsIn(entry.body);
      if (refs.length === 0) continue;
      const pageDir = posix.dirname(pageRel);
      const mine: string[] = [];
      let body = entry.body;
      for (const sha of refs) {
        if (failed.has(sha)) continue;
        let rel = knownBySha.get(sha);
        if (rel === undefined) {
          let found: Awaited<ReturnType<AttachmentClient["download"]>>;
          try {
            found = await this.attachments.download(workspace, sha);
          } catch (err) {
            // One unreachable attachment must not stall the whole mirror: leave the ref
            // verbatim, say so, and pick it up on a later reconcile.
            this.logger.warn("attachment download failed", { workspace, id: sha, error: (err as Error).message });
            failed.add(sha);
            continue;
          }
          if (found === undefined) {
            this.logger.warn("attachment not found", { workspace, id: sha });
            failed.add(sha);
            continue;
          }
          rel = posix.join(ASSETS_DIR, `${sha}${extForMime(found.meta.mime)}`);
          if (await this.writeBytesIfChanged(rel, found.bytes, m)) written++;
          knownBySha.set(sha, rel);
        }
        mine.push(rel);
        // Relative to the page's OWN directory, so a folder page (index.md) and a leaf
        // page (<slug>.md) both resolve.
        const href = posix.relative(pageDir, rel);
        body = body.split(`attachment:${sha}`).join(href);
      }
      if (mine.length > 0) {
        assetsByPage[entry.pageId] = mine;
        expected.set(pageRel, { pageId: entry.pageId, body });
      }
    }
    return { assetsByPage, written };
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
