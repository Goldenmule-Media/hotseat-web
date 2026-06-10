# Testing plan

**Status:** ready

## Planned
_None._

## Passed
- A committed mutation causes the affected page's `.md` to update to exactly its `renderPage` output, within the eventual-consistency window.
- A commit that does not change a page's rendered bytes results in NO file write (hash compare; determinism ⇒ no churn).
- Archiving or deleting a page removes its file; reparenting moves it to the new path; neither leaves an orphan behind.
- Writes are atomic: a concurrent reader never observes a partially-written file (temp + rename).
- Disabled by default; when enabled, the projector writes only under the configured root and only for allowlisted workspaces.
- Restart after offline mutations: on boot the projector reconciles disk to the current stream head — missing files created, stale files removed.
- The SQL read model and the Markdown projection share one tailer/cursor — enabling the Markdown projection does not perturb SQL projection correctness or ordering.

## Failed
_None._

## References
_None._

## Child pages
_None._
