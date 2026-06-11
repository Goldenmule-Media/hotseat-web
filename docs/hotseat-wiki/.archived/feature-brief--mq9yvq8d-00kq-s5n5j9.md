# Feature: Local markdown mirror (wiki-mirror)

**Status:** shipped

## Summary
A deployed wiki-server cannot write Markdown into a developer's local git checkout: the emitter's roots are absolute filesystem paths meaningful only on the machine that owns the disk. This feature extracts Markdown emission out of the wiki-mcp host into a new locally-run process, `wiki-mirror`, that tails a (possibly remote) server's durable stream, folds + renders each commit with the engine, and writes deterministic Markdown to a local root — the headless, disk-writing sibling of wiki-ui. The embedded emitter is retired (emission lives only in the mirror) and emitter config moves from the server-side `_emitter-config` stream to a local config file the mirror owns. This unblocks deploying wiki-server to shared infrastructure while each developer keeps their own checkout mirrored locally. Out of scope: cloud stream storage, endpoint auth/TLS, and cloud model availability — none of which markdown emission depends on.

## Components affected
- wiki-mirror — new local stream-client package
- wiki-mcp — remove emitter (projector, registry, config store, MCP tools)
- wiki-server — stop wiring the embedded emitter and its config
- wiki — verify public fold/render surface (no change expected)
- Root scripts + local-dev orchestration (npm start runs server + mirror)
- CLAUDE.md + docs/hotseat-wiki mirror

## Design constraints
1. Engine and host stay schema-agnostic; the mirror `import()`s wiki-models at runtime exactly as the server does.
2. The mirror is a parallel engine consumer like wiki-ui — it imports `wiki` + `wiki-models` only, never wiki-mcp/wiki-server; it tails read-only and writes no workspace events.
3. The mirror reaches the engine only through `wiki`'s public surface — no wiki-mcp internals.
4. Determinism across processes: the same folded state renders byte-identical Markdown whether the server or the mirror produces it.
5. Single emission path: after this feature there is exactly one place Markdown is written (the mirror); no embedded fallback.
6. Emitter config (workspaceId → absolute root) is local-machine state in a local file; the server never stores or sees a filesystem root.
7. MarkdownDiskProjector's behaviors are preserved verbatim — atomic temp+rename writes, content-hashing, boot self-heal back-fill, archive-moves-never-deletes, single-writer-per-root.
8. Local-dev DX stays a single command (server + mirror orchestrated together).
9. Out of scope (separate tracks): durable stream storage for a cloud host, auth/TLS on the MCP + stream endpoints, and model-bundle availability in the cloud.

## Open questions
_None._

## Resolved questions
1. **Where should the emitter configuration (workspace → on-disk root) live once wiki-server can be deployed remotely?** — _In a local config file owned by the mirror. The server-side `_emitter-config` durable stream and the configureEmitter/listEmitters/removeEmitter MCP tools are retired — a workspace→absolute-root mapping is per-machine state and must not live in shared server storage._
2. **Should the embedded markdown emitter be kept for the all-local dev case, or retired so emission has a single home?** — _Retired. Markdown emission lives only in wiki-mirror — one emission path, even for local development, with no embedded fallback in wiki-mcp/wiki-server._
3. **Is the scope a focused markdown mirror, or a general host for local-only concerns?** — _Focused on markdown mirroring for now. Git operations (stage/commit/push the mirror) are a deferred future addition; the design keeps the checkout-ownership seam open but ships none._
4. **What are the new package's name, shape, and dependency boundary?** — _wiki-mirror — a workspace-member Node package (tsdown build, tsx start, `.js` relative imports) like wiki-mcp. It depends on wiki + wiki-models + @durable-streams/client and never imports wiki-mcp/wiki-server: a parallel engine consumer, the headless disk-writing sibling of wiki-ui._
5. **Does tailing a remote stream and rendering to disk require any new public API on the wiki engine?** — _No. `foldWorkspace`, `renderSearchDocs`, `renderAffectedDocs`, `isStructuralCommit`, `SearchDoc` and `IWorkspaceState` are already exported from `wiki`, and `Registry` from `wiki/registry`. The mirror runs its own slim single-sink tail loop on these and reuses MarkdownDiskProjector unchanged; it does not import wiki-mcp's ProjectionService (accepted small duplication — the projector's on-disk manifest already provides per-workspace version tracking and self-heal)._
6. **How does the mirror pick up configuration changes — live reload, file-watch, or restart?** — _Config is read at startup; reconfiguring requires a restart. Workspace tailing is live, but config reload is deferred. The old emitter's hot-reconfig existed only because its config lived on a shared durable stream; a local file does not need it for v1, and the mirror is a freely-restartable dev sidecar._
7. **Does one mirror process handle many workspaces, or is it one process per workspace?** — _One process tails all configured workspaces in a namespace (N tail loops), matching the old registry's "all" | allowlist behavior._
8. **What is the local config file's format and resolution order?** — _A `wiki-mirror.config.json` mapping workspaceId → absolute root (plus stream baseUrl, namespace, models), resolved flags → env (WIKI_MIRROR_*) → file → defaults, consistent with wiki-server's config cascade._
9. **Where do mirror failures and operability surface, now that emission is out of the server's logs/health?** — _The mirror owns its own logger to stdout; per-workspace render/write failures are best-effort and logged (mirroring MarkdownDiskProjector.fail), while a fatal boot error (bad config, unreachable stream) exits nonzero. A dedicated health/control endpoint is deferred._

## References
_None._

## Child pages
- [Implementation plan — Local markdown mirror (wiki-mirror)](implementation-plan:mq9yvq8d-00kr-qdpkzg)
- [Testing plan — Local markdown mirror (wiki-mirror)](testing-plan:mq9yvq8d-00ks-7dkr41)
- [Spec — Local markdown mirror (wiki-mirror)](feature-spec:mq9yvq8d-00kt-chirbk)

## Commits
- `24a6768` feat(wiki-mirror): extract markdown emission into a local stream-client
- `18d0cbc` fix(wiki-mirror): boot resilience, clean shutdown, single-writer-per-root (review)
