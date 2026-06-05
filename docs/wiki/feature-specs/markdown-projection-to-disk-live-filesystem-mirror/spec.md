# Spec

**Status:** sealed

## Overview
A filesystem projection in `wiki-mcp` mirrors a workspace's deterministic Markdown to a directory and keeps it current by tailing the same Durable Stream the SQL read model follows. On each commit the changed pages are re-rendered and written; the on-disk tree mirrors the page tree; unchanged pages touch no file. It is off by default, scoped to an allowlist of workspaces, and writes atomically under one configured root — a second consumer of the existing projection tail, not a new event loop.

## Design
## A second projection on the same tail

The host already runs a projection tailer that folds the stream and serializes state into SQL (ADR-M3). This adds a second consumer on that same cursor: a MarkdownDiskProjector. On each advance it learns which page versions changed, re-renders just those through the engine, maps each to a path, and writes. It runs behind the commit on the read side, so it never blocks or slows a write.

## Reconciliation, not append

Correctness on deletes, archives, and reparents comes from treating the output as a reconciliation against the live tree rather than an append-only log. The expected set of files is computed from the current tree; any file on disk with no corresponding live page is an orphan and is removed (or moved, on reparent; or archived, per policy). On boot the projector rebuilds this picture from the stream head and reconciles, so it self-heals after offline edits or a wiped directory.

## Determinism keeps the diff honest

The engine's guarantee that equal state renders identical bytes is what makes a disk mirror safe to commit. Each rendered page is content-hashed; a page whose bytes are unchanged is never rewritten, so git status stays quiet and a pull request shows only real spec changes. When a write is needed it goes to a temp file and is atomically renamed into place, so no reader ever sees a half-written page.

```typescript
interface IMarkdownProjectionConfig {
  enabled: boolean;             // default false — opt-in
  root: string;                 // the projector writes ONLY under here
  workspaces: "all" | string[]; // allowlist of workspace ids / namespaces
  archive: "drop" | "mirror";   // archived page: remove its file, or move it aside
}

// write only on change; atomic replace:
const hash = sha256(md);
if (manifest.get(path) === hash) return;   // determinism => no churn
await fs.writeFile(tmp, md);
await fs.rename(tmp, path);                 // atomic on POSIX
```

## One render per commit, fanned out to many sinks

Full-text search already renders each affected page to Markdown on this same projection tailer (renderAffectedDocs), so the disk mirror must not render a second time. The tailer renders a commit's affected pages exactly once and fans the resulting SearchDoc list out to every render sink: the search index and the disk mirror both consume the same rendered docs rather than each calling renderPage. The hot path, where all sinks are current, costs one affected-only render regardless of how many sinks consume it; a sink that has fallen behind (a dropped best-effort update, a fresh or wiped sink) rebuilds from a whole-workspace render, which is the rare path. Each sink stays best-effort: a sink failure is caught, surfaced so token-gated waiters fast-fail, and never halts projection because the durable write already committed. The SearchDoc already carries everything a disk mirror needs per page (pageId, type, status, archived, title, and body, the deterministic Markdown), and the full folded workspace state is passed alongside for sinks that need the tree for path mapping and orphan reconciliation.

```typescript
// wiki-mcp/src/tail/render-sink.ts — a render-side consumer fed by the
// tailer's SINGLE per-commit render. Search index + Markdown disk mirror are both sinks.
export interface RenderSink {
  readonly name: string;
  appliedVersion(ws: WorkspaceId): Promise<number>;
  // Hot path: consume the SHARED affected-page render (docs) + removed ids.
  applyDelta(ws: WorkspaceId, version: number,
             docs: readonly SearchDoc[], removed: readonly PageId[],
             state: IWorkspaceState): Promise<void>;
  // Lagged / fresh sink: rebuild from a whole-workspace render (rare).
  rebuild(ws: WorkspaceId, version: number,
          docs: readonly SearchDoc[], state: IWorkspaceState): Promise<void>;
  fail(ws: WorkspaceId, version: number, err: unknown): void;
}

// ProjectionService.project(): render the affected pages ONCE, then fan out.
const affected = affectedPageIds(newEvents, state);
const docs    = renderAffectedDocs(state, affected, registry, opts); // the ONE render
const removed = [...affected].filter((id) => !state.pages.has(id));
for (const sink of this.renderSinks) {            // search index, disk mirror, ...
  const applied = await sink.appliedVersion(ws);
  if (applied >= priorApplied) await sink.applyDelta(ws, version, docs, removed, state);
  else if (applied < version)  await sink.rebuild(ws, version, renderWhole(), state);
}
```

## Decisions
It lives in wiki-mcp (a read-model concern); wiki-server only hosts it and passes config through (ADR-M5). Where does it live — `wiki-mcp` or `wiki-server`? wiki-server owns process wiring; wiki-mcp owns the read-model/projection logic.

Push, not poll: tail the Durable Stream via the existing projection tailer and re-render on each advance. Push or pull? Subscribe to the stream and react to each commit, or poll the read model on an interval?

Re-render only the pages whose version changed, but reconcile the full expected file set each tick to catch deletes and moves. Re-render the whole workspace on every commit, or only the pages that changed? The former is simplest; the latter is bounded work per commit.

Reconcile against the live tree, not append: orphan files (deleted, archived, or the old path after a reparent) are removed or moved; archive handling is a config knob. How are deletes, archives, and reparents reflected on disk? An append-only writer would leave stale files behind.

Content-hash to skip unchanged writes (no churn), and temp-file plus atomic rename so a reader never sees a partial file. How do we avoid git churn and partial reads when writing files?

Mirror the page tree as nested folders, one file per page plus a per-folder index; a flat layout is reserved for later. File layout / path strategy: mirror the page tree as nested folders, or one flat file per workspace?

An allowlist of workspaces mapped to output roots, off by default, with a single-writer assumption documented rather than coordinated. What is exported, and how do we stay safe with multiple writers?

Build on the wiki-mcp projection tailer (shared cursor, replay, backpressure), which itself wraps the engine's lower-level subscribe primitive. Reuse the engine's `subscribe` primitive, or the `wiki-mcp` projection tailer?

## References
_None._

## Child pages
_None._
