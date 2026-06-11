# Testing plan — Local markdown mirror (wiki-mirror)

**Status:** draft

## Planned
_None._

## Passed
- Determinism / no-regression: rendering a fixture workspace through wiki-mirror produces output byte-identical to what the retired embedded emitter wrote for the same events.
- Boot back-fill: pointing the mirror at a fresh empty root back-fills the entire workspace tree from head (folder + index.md per page-with-children).
- Self-heal: wiping or corrupting a mirrored file and restarting the mirror rebuilds it from the manifest + workspace head (manifest hash mismatch → rebuild).
- Live tail: a commit on the (remote) workspace stream produces the corresponding file change in the mirror with no restart.
- Structural commit → rebuild: reparenting/renaming a page (a path change) re-lays-out the tree via the rebuild path, leaving no stale file at the old path.
- Archive moves, not deletes: archiving a page moves its file to `<workspace>/.archived/<type>--<id>.md`; unarchiving moves it back to the tree; only a hard page delete removes a file.
- Honest diff: a commit whose rendered bytes are unchanged (content hash equal) writes nothing — no spurious git diff — and writes are atomic (temp + rename).
- Multi-workspace: one mirror process configured with two emitter entries mirrors both workspaces to their respective roots from a single process.
- Config resolution: `flags → env (WIKI_MIRROR_*) → file → defaults` precedence is honored; a non-absolute or missing `root`, namespace, or baseUrl fails fast at boot.
- Fatal vs best-effort errors: an unreachable stream / unknown model specifier / malformed config exits nonzero with a clear message; a per-workspace render or write error is logged via `fail` without killing the process or other workspaces' loops.
- Read-only: the mirror appends no events to any workspace stream (verify the stream head version is unchanged across a mirror session).
- wiki-mcp emitter removed: wiki-server/wiki-mcp boot cleanly with no `_emitter-config` stream and no configureEmitter/listEmitters/removeEmitter tools, while the SQL read model + search projection still update on commits.

## Failed
_None._

## References
_None._

## Child pages
_None._
