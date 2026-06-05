# Implementation checklist

**Status:** complete

## Plan steps
- [ ] Define the config: `IMarkdownProjectionConfig { enabled; root; workspaces; layout: "tree"; archive: "drop" | "mirror" }` in `wiki-mcp` config; add `WIKI_MCP_MD_*` env + `wiki-server` passthrough flags, defaulting to disabled.
- [ ] Implement `MarkdownDiskProjector` and register it on the existing projection tailer alongside the SQL read model (the SAME cursor). On cursor advance, obtain the set of changed page ids.
- [ ] Render + map: for each changed page call the engine's deterministic `renderPage`; compute its on-disk path from the live tree (a folder per ancestor, `<slug>.md` per page, id-disambiguated).
- [ ] Write path: keep a manifest (path → content-hash, page-id → path); on write, compare the new render's hash, skip if unchanged, else temp-write + atomic rename.
- [ ] Reconcile: from the live tree compute the expected path set; delete orphan files; on reparent/rename move (write new path + remove old); apply the archive policy (drop vs `_archive/`).
- [ ] Boot/replay: on startup, build the manifest from the current stream head and reconcile disk to it — self-heal after offline changes or a deleted output directory.
- [ ] Wire `wiki-server` config passthrough; log a one-line summary per flush (n written, n removed, n unchanged); document the config, off-by-default posture, and single-writer assumption in README/CLAUDE.
- [ ] Verify: enable for the ADRs/specs workspace; mutate via MCP and watch files update; a no-op commit writes nothing; archive + reparent are reflected; restart reconciles; the SQL projection is unaffected.

## Tasks
- [x] `npm run typecheck` is clean across `wiki-mcp` and `wiki-server`.
- [x] Enabled for the ADRs/specs workspace, an end-to-end live update is verified: mutate via MCP, and the file on disk matches `renderPage`.
- [x] A no-change commit produces zero writes; a restart self-heals the output directory (missing created, stale removed).
- [x] README/CLAUDE document the config, the off-by-default posture, and the single-writer assumption.
- [x] All testing-plan cases pass
