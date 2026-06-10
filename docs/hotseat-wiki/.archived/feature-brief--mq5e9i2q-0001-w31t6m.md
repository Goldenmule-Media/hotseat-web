# Feature: Runtime-configurable Markdown emitters (per-project disk mirrors)

**Status:** shipped

## Summary
The shipped "Markdown projection to disk" feature mirrors a workspace's deterministic Markdown to a single, statically-configured root (`--md` / `WIKI_MCP_MD_*`). That model breaks the moment one long-running server is shared by several projects: each project is a different repo checkout on disk and needs *its own* workspace mirrored into *its own* checkout's `docs/`. A single boot-time root cannot express that, and the server does not know each project's path at boot anyway.

This feature replaces the static boot config with a **runtime, event-sourced emitter registry** exposed over MCP. A project registers its own mirror by calling `configureEmitter({ emitterId, workspaceId, root, archive })`; the engine starts rendering that workspace's Markdown into that absolute root and keeps it live. Each emitter is one-workspace-to-one-root, keyed by a caller-supplied id.

The registry is itself event-sourced, on its **own durable stream** (`{baseUrl}/{namespace}/_emitter-config`) — separate from the workspace event streams, mirroring the engine's existing `_catalog` stream pattern but owned by `wiki-mcp`. The stream is replayed on boot to reconstruct the live emitter set, so configuration survives restarts. A lightweight tailer on that stream drives `addRenderSink` / `removeRenderSink` on the existing projection tailer at runtime: registering an emitter adds a `MarkdownDiskProjector` (back-filled from the workspace's stream head) and removing one drops the sink. The page rendering itself is unchanged — emitters are just additional render sinks on the one-render-per-commit fan-out the projection already does.

The old static `--md` flags and `WIKI_MCP_MD_*` env are removed entirely; the runtime registry is the only way to configure a mirror.

## Components affected
- wiki-mcp — `EmitterConfigStore`: a small store over its own `@durable-streams/client` for the `{namespace}/_emitter-config` stream (append + fold). Mirrors the engine's `_catalog` store pattern, but lives in wiki-mcp because the engine's `EventLog` is internal/unexported. Events: `EmitterConfigured {emitterId, workspaceId, root, archive}` and `EmitterRemoved {emitterId}`; fold is last-writer-wins per emitterId, yielding the live emitter set.
- wiki-mcp — `EmitterRegistry` tailer: subscribes live to the config stream; on each change it constructs/initialises a `MarkdownDiskProjector` and calls `projection.addRenderSink` (then reconciles it from the workspace stream head so the root back-fills immediately), or `projection.removeRenderSink` on removal. Replays the stream on boot to rebuild the set.
- wiki-mcp `ProjectionService` — add `removeRenderSink(sink)` (today only `addRenderSink` exists) and factor a single-sink reconcile out of `reconcileSinks`, so a freshly-added emitter can be brought to head on its own without a full boot reconcile.
- wiki-mcp MCP tools — new write tools `configureEmitter` / `listEmitters` / `removeEmitter` (the project-facing API), following the existing `WikiTool` descriptor + `archiveWorkspace` handler pattern; they append to the `_emitter-config` stream via `EmitterConfigStore`.
- wiki-mcp config — REMOVE the static Markdown surface entirely: delete `IMarkdownProjectionConfig` from `WikiMcpConfig`, `resolveMarkdown()`, the boot-time projector wiring in `createWikiMcp`, and every `--md*` flag / `WIKI_MCP_MD_*` env. `MarkdownDiskProjector` itself stays — it is now constructed per emitter at runtime, not from boot config.
- wiki-server — drop the `--md*` documentation and the now-dead markdown config surface; it forwards argv/env wholesale, so there is little code beyond removing the documented flags.
- CLAUDE.md / README — replace the "Markdown-disk mirror (off by default)" section with the runtime emitter API (configure / list / remove over MCP) and a note on the `_emitter-config` stream.

## Design constraints
1. One-to-one, caller-keyed: each emitter maps exactly one workspace to exactly one absolute on-disk root, addressed by a caller-supplied `emitterId`. A project wanting several mirrors registers several emitters.
2. Event-sourced on a SEPARATE stream: emitter config lives on its own durable `_emitter-config` stream per namespace — never mixed into the workspace event streams. Replayed on boot so the live emitter set is reconstructed; fold is last-writer-wins per emitterId.
3. Reuse the projection, do not duplicate it: emitters are `MarkdownDiskProjector`s registered as `RenderSink`s on the existing tailer. Same one-render-per-commit fan-out, same per-root manifest + reconcile machinery. No second render path and no second event loop for page rendering.
4. Runtime add/remove, no restart: configuring or removing an emitter takes effect immediately. A newly-added emitter back-fills its root from the workspace stream head; removal detaches the sink.
5. Remove leaves files on disk: `removeEmitter` stops updating and detaches the sink, but does not delete already-mirrored files — the repo checkout owns them from then on.
6. Local-only trust (v1): the server and all project checkouts are assumed to be on one machine. Roots are absolute paths supplied by the caller and written verbatim; no path sandboxing or allowlist in v1.
7. Clean removal of the old surface: the static `--md` / `WIKI_MCP_MD_*` configuration is deleted outright, not deprecated. The runtime registry is the sole configuration path.

## Open questions
_None._

## Resolved questions
1. **Should emitter config live on the wiki's event streams or its own?** — _Its own durable `_emitter-config` stream, per namespace, owned by `wiki-mcp`. It is operational/read-side config, not wiki domain data, so it stays out of the workspace event log. The engine's `_catalog` stream is the precedent for per-namespace metadata on a `_`-prefixed stream, but its `EventLog` is internal and unexported, so wiki-mcp opens its own `@durable-streams/client` to the same host._
2. **Static boot config, or a runtime API?** — _A runtime API over MCP. A shared server cannot know each project's checkout path at boot, and checkouts come and go; projects must self-register. The static `--md` / `WIKI_MCP_MD_*` surface is removed entirely._
3. **One workspace per emitter, or a set of workspaces?** — _One-to-one, with a caller-supplied `emitterId`. It is the simplest addressing and matches the use case (a repo mirrors its own workspace). Several mirrors = several emitters._
4. **How does an emitter take effect without a server restart?** — _A tailer on the config stream adds a `MarkdownDiskProjector` as a render sink on the live projection and reconciles it from the workspace stream head, so the root back-fills immediately; removal drops the sink. This requires a new `removeRenderSink` and a single-sink reconcile on `ProjectionService`._
5. **What happens to mirrored files when an emitter is removed?** — _They are left on disk. Removal only stops future updates and detaches the sink; the repo checkout keeps the already-rendered files._
6. **How are arbitrary on-disk roots kept safe?** — _Out of scope for v1 — assume local, single-machine, single-user operation. Roots are trusted absolute paths written verbatim. A path allowlist / sandbox can come later if the server is ever shared across trust boundaries._

## References
_None._

## Child pages
- [Implementation plan](implementation-plan:mq5e9i2q-0002-wxnsf7)
- [Testing plan](testing-plan:mq5e9i2q-0004-ea9cro)
- [Spec](feature-spec:mq5e9i2q-0005-2in5ln)

## Commits
- `382cee198caf08df6255af99bf76cb7509836c70` feat(wiki-mcp): runtime-configurable Markdown emitters (per-project disk mirrors)
