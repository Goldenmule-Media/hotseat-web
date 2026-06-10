# Implementation plan

**Status:** ready

## Steps
- [ ] Define the config: `IMarkdownProjectionConfig { enabled; root; workspaces; layout: "tree"; archive: "drop" | "mirror" }` in `wiki-mcp` config; add `WIKI_MCP_MD_*` env + `wiki-server` passthrough flags, defaulting to disabled.
- [ ] Implement `MarkdownDiskProjector` and register it on the existing projection tailer alongside the SQL read model (the SAME cursor). On cursor advance, obtain the set of changed page ids.
- [ ] Render + map: for each changed page call the engine's deterministic `renderPage`; compute its on-disk path from the live tree (a folder per ancestor, `<slug>.md` per page, id-disambiguated).
- [ ] Write path: keep a manifest (path → content-hash, page-id → path); on write, compare the new render's hash, skip if unchanged, else temp-write + atomic rename.
- [ ] Reconcile: from the live tree compute the expected path set; delete orphan files; on reparent/rename move (write new path + remove old); apply the archive policy (drop vs `_archive/`).
- [ ] Boot/replay: on startup, build the manifest from the current stream head and reconcile disk to it — self-heal after offline changes or a deleted output directory.
- [ ] Wire `wiki-server` config passthrough; log a one-line summary per flush (n written, n removed, n unchanged); document the config, off-by-default posture, and single-writer assumption in README/CLAUDE.
- [ ] Verify: enable for the ADRs/specs workspace; mutate via MCP and watch files update; a no-op commit writes nothing; archive + reparent are reflected; restart reconciles; the SQL projection is unaffected.

## Data models & interfaces
```typescript
// wiki-mcp/src/readmodel/markdown-projection.ts
export interface IMarkdownProjectionConfig {
  enabled: boolean;                       // default false
  root: string;                           // output dir; the projector writes ONLY under here
  workspaces: "all" | readonly string[];  // allowlist of workspace ids (or namespaces)
  layout: "tree";                         // mirror the page tree (default); "flat" reserved
  archive: "drop" | "mirror";             // archived page: remove its file, or move under _archive/
}

// Registered on the SAME projection tailer as the SQL read model — one cursor, two consumers
// (wiki-mcp ADR-M3). It never blocks the write path; it runs behind the commit (CQRS read side).
export interface IMarkdownProjector {
  // Called by the tailer after each committed batch advances the cursor.
  onAdvance(changed: ReadonlySet<PageId>, tree: WorkspaceTree): Promise<void>;
  // Called once at boot to reconcile disk against the current stream head (self-heal).
  reconcileFromHead(tree: WorkspaceTree): Promise<void>;
}
```

```typescript
// A page is written only when its rendered bytes change; writes are atomic (temp + rename).
async function flushPage(page: PageId, md: string, path: string, m: Manifest): Promise<"written" | "skipped"> {
  const hash = sha256(md);
  if (m.hashByPath.get(path) === hash) return "skipped";        // determinism => no churn
  const tmp = `${path}.tmp-${m.writerId}`;
  await fs.writeFile(tmp, md, "utf8");
  await fs.rename(tmp, path);                                   // atomic replace on POSIX
  m.hashByPath.set(path, hash);
  m.pathByPage.set(page, path);
  return "written";
}

// Reconcile: expected paths come from the LIVE tree; anything else on disk is an orphan
// (covers delete, archive, and the old path after a reparent/rename).
async function reconcile(tree: WorkspaceTree, m: Manifest, cfg: IMarkdownProjectionConfig): Promise<void> {
  const expected = new Set(tree.pages.map((p) => pathFor(p, tree)));
  for (const onDisk of [...m.hashByPath.keys()]) {
    if (!expected.has(onDisk)) await removeOrArchive(onDisk, cfg.archive);
  }
}
```

## Open questions
_None._

## Resolved questions
_None._

## References
_None._

## Child pages
_None._
