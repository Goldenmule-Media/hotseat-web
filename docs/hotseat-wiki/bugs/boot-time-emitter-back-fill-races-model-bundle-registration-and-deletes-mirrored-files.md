# Bug: Boot-time emitter back-fill races model-bundle registration and deletes mirrored files

**Status:** open

## Report
- **Component:** wiki-mcp (MarkdownDiskProjector / projection boot reconcile)
- **Platform:** macOS / wiki-server local boot
- **Version:** 0.1.0 @ e15aa18

## Summary
On wiki-server boot, the markdown emitter's back-fill reconcile races model-bundle registration: reconciles run per registry generation while bundles are still loading, and an early reconcile with a partial registry treats pages of not-yet-registered types as gone and DELETES their mirrored files (boot log: 'markdown-disk reconciled … written 30, removed 95' right after 'render-sink reconcile skipped a workspace: History references unregistered page/event type(s): [toc]'). Later per-generation reconciles race each other healing the tree and do not converge; the manifest ends up claiming files that are missing on disk, after which re-registering the emitter does NOT self-heal (back-fill trusts the manifest and never stats the files).

## Repro steps
1. Run a wiki-server with a configured markdown emitter and a workspace whose pages span several model bundles (e.g. toc + architecture + feature).
2. Restart the server so boot-time emitter back-fill and --models-dir bundle registration run concurrently.
3. Watch /_server/logs: an early 'markdown-disk reconciled' entry reports a large `removed` count with a small `pages` count, preceded by 'render-sink reconcile skipped a workspace … unregistered page/event type(s)'.
4. Compare the manifest to disk: files listed in docs/.wiki-md-manifest.json are missing from the output tree (observed: 23 of 95). Re-running configureEmitter for the same root does not restore them; only deleting the manifest and re-registering the emitter forces a full back-fill.

## Expected result
Boot-time back-fill must not run until every configured model bundle is registered (or must skip-and-retry, never delete, when the registry is partial); reconciles must be serialized per emitter; and the back-fill should verify mirrored files actually exist on disk rather than trusting the manifest, so a wiped or partially-wiped output dir self-heals as documented.

## Observed result
An early reconcile with a partial registry deleted 95 mirrored files; racing per-generation reconciles rewrote most but left 23 files for live pages missing while the manifest still claimed all 95, and subsequent emitter re-registration was a no-op (back-fill trusted the stale manifest). Mirror integrity silently lost across two separate boots (CLAUDE.md links to architecture/wiki/* were stranded by the earlier occurrence).

## Resolution
_None._

## References
_None._

## Child pages
_None._
