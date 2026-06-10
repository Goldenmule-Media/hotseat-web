# Feature: Markdown projection to disk — live filesystem mirror

**Status:** shipped

## Summary
The wiki is the source of truth, but a design artifact is most useful when it is also a plain file in the repo — greppable at edit time, reviewable in a pull-request diff, and readable with no server running. Today the only way to get a page's Markdown onto disk is to call `renderPage` by hand and paste the result; nothing keeps it current. We want the on-disk Markdown to track the wiki automatically: when the stream advances, the files update.

This feature adds a filesystem projection in `wiki-mcp` that mirrors a workspace's deterministic Markdown render to a directory and keeps it current by tailing the same Durable Stream the SQL read model already follows. Each committed event advances a cursor; the pages whose state changed are re-rendered and written, and the on-disk tree mirrors the page tree. It is opt-in, scoped to configured workspaces, and writes only under a configured root.

Architecturally this is the projection pattern the host already runs (ADR-M3: a projection is engine-fold + serialize; the projection tailer in `wiki-mcp`). The SQL read model serializes folded state into SQL; this serializes folded state into files — the same tailer seam, the same cursor discipline, the same eventual-consistency contract. It is a second consumer of the tail, not a second event loop. The engine's determinism guarantee is what makes it safe: equal state renders identical bytes, so an unchanged page touches no file and the git diff stays honest.

This is also the mechanism that gives the linked "ADR page type" feature its `docs/adr/*.md` snapshot, and it can just as well export the Architecture and Feature-Specs workspaces. The point: the wiki stays the write-side source of truth, and the repository gets a faithful, always-current rendered mirror for free.

## Components affected
- wiki-mcp — a new `MarkdownDiskProjection` registered on the existing projection tailer/cursor: on each advance it re-renders the changed pages, maps each to a path, and reconciles the on-disk tree (writes, moves, deletes).
- wiki-mcp config + wiki-server config — new `WIKI_MCP_MD_*` settings (and wiki-server passthrough flags): enabled (off by default), output root, workspace selector, layout, and archive policy.
- wiki engine (`wiki`) — expected to need NO change: it already exposes deterministic `renderPage`, the tree reads, and the subscribe/tailer primitive the SQL projection uses; the Markdown projection consumes that same surface.
- docs/ (the write target) — e.g. `docs/adr/`, `docs/architecture/`: directories the hosting process owns and the projection keeps in sync; tracked in or excluded from git per the repo's choice.
- README / CLAUDE.md — document the new config, the off-by-default posture, and the single-writer assumption.

## Design constraints
1. One tailer, two projections: subscribe to the same stream cursor the SQL read model uses (the ADR-M3 pattern); do not add a second polling loop or a separate event source.
2. Eventually-consistent read side: the projection must never block or slow the write path — it runs behind the commit, like every other read model (CQRS).
3. Determinism ⇒ no churn: write a file only when its rendered bytes actually change (content-hash compare). Equal state must touch no file, so `git status` stays quiet and a PR shows only real spec/decision changes.
4. Crash- and restart-safe, self-healing: on boot, reconcile the on-disk tree against the current stream head — render missing or changed pages and remove orphaned files. Deletes, archives, and reparents must be reflected, not just additions.
5. Atomic file writes: write to a temp file and rename into place, so a concurrent reader (or a watching dev server) never observes a half-written page.
6. Opt-in and scoped: off by default; enabled per configured workspace with an explicit output root; the projection only ever writes under that root. Single-writer — one hosting `wiki-mcp` owns the directory (documented, not enforced in v1).
7. Path mapping mirrors the tree: `<root>/<page-path>.md` derived deterministically from titles, disambiguated by id, with a per-folder index for navigation; stable across renames where the id anchors the path.

## Open questions
_None._

## Resolved questions
1. **Where does it live — `wiki-mcp` or `wiki-server`? wiki-server owns process wiring; wiki-mcp owns the read-model/projection logic.** — _`wiki-mcp`. It is a read-model/projection concern, and ADR-M5 already draws the line: `wiki-mcp` holds the logic, `wiki-server` only hosts it. `wiki-server` contributes config passthrough and nothing else._
2. **Push or pull? Subscribe to the stream and react to each commit, or poll the read model on an interval?** — _Push — tail the Durable Stream (the existing projection tailer) and re-render on each advance. "Automatic when the stream updates" is the whole point; polling would add latency and waste cycles re-rendering unchanged workspaces._
3. **Re-render the whole workspace on every commit, or only the pages that changed? The former is simplest; the latter is bounded work per commit.** — _Re-render only the pages whose version changed since the last projected cursor, but reconcile the full expected file set against the live tree each tick to catch deletes and moves. Bounded work in the common case, still correct on structural change._
4. **How are deletes, archives, and reparents reflected on disk? An append-only writer would leave stale files behind.** — _The projection is a reconciliation against current tree state, not append-only: compute the expected set of files from the live tree, write or update the changed ones, and delete any file with no corresponding live page. Archive policy (drop the file vs. move it to an `_archive/` mirror) is a config knob, default drop._
5. **How do we avoid git churn and partial reads when writing files?** — _Content-hash each rendered page and skip the write when it is unchanged; when a write is needed, write a temp file and atomically rename it into place. This is what constraints #3 and #5 require, and what keeps both the git diff and any file watcher honest._
6. **File layout / path strategy: mirror the page tree as nested folders, or one flat file per workspace?** — _Mirror the page tree — nested directories, one `.md` per page, plus an `index.md` per folder; paths derived deterministically from titles and disambiguated by id. A flat "one file per workspace" mode is a possible later option, but the tree mirror is the default and matches how the wiki is navigated._
7. **What is exported, and how do we stay safe with multiple writers?** — _An explicit allowlist of workspace ids (or namespaces) mapped to output roots; off by default. v1 assumes a single writer — the owning `wiki-mcp` process — and documents it, rather than trying to coordinate multiple processes writing one directory._
8. **Reuse the engine's `subscribe` primitive, or the `wiki-mcp` projection tailer?** — _The `wiki-mcp` projection tailer — the same component that drives the SQL read model — so cursor management, replay-on-boot, and backpressure are shared rather than reimplemented. The engine's `subscribe` (used by wiki-ui in the browser) is the lower-level primitive underneath; `wiki-mcp` already wraps it for projections._

## References
- enables — supplies the docs/adr snapshot for the ADR page type → [ADR page type — decisions as first-class wiki pages](feature-brief:mpzzfn7e-0006-i76ro4)

## Child pages
- [Implementation plan](implementation-plan:mpzzmwwy-003y-oex61a)
- [Testing plan](testing-plan:mpzzmwwy-0040-o5ee1x)
- [Spec](feature-spec:mpzzmwwy-0041-yfaz8w)

## Commits
- `e73d0835f56af4c3df3eb3c7f26f75a820776a81` feat(wiki,wiki-mcp): Markdown projection to disk — render-once, fanned out to many sinks
