# ADR-32: Markdown emission is a local stream-client, not a host responsibility

**Status:** accepted

## Metadata
- **Date:** 2026-06-11
- **Scope:** wiki-mirror / deploy
- **Deciders:** Benjamin Jordan

## Context
A deployed `wiki-server` cannot write Markdown into a developer's local git checkout: the emitter's roots are absolute filesystem paths meaningful only on the machine that owns the disk, and the `workspaceId → root` mapping is inherently per-machine state. While the server always ran on the same machine as the checkout this was invisible; making the server deployable to shared/cloud infrastructure surfaces it. The embedded Markdown emitter — a render-sink on wiki-mcp's projection tail, configured at runtime via a per-namespace `_emitter-config` durable stream and the `configureEmitter`/`listEmitters`/`removeEmitter` MCP tools — bound the host to a local filesystem and stored machine-specific absolute paths in shared server storage. `wiki-ui` already demonstrated the pattern that resolves this: a parallel consumer that embeds the engine, tails the server's stream, and re-projects on every commit.

## Decision
Treat Markdown emission as a stream **client**, not a host responsibility — the headless, disk-writing sibling of `wiki-ui`. A separate local process, `wiki-mirror`, tails a (possibly remote) workspace's Durable Stream, folds + renders each commit on `wiki`'s **public** surface (`foldWorkspace`/`renderSearchDocs`/`Registry`), and writes the deterministic Markdown to a local root. It imports `wiki` (+ `wiki-models`) only — never `wiki-mcp`/`wiki-server` — tails read-only, and authors nothing back. No engine change was required.

Retire the embedded emitter entirely so emission has **one home**: remove the render-sink wiring, the `_emitter-config` stream, and the configure/list/removeEmitter MCP tools from wiki-mcp/wiki-server. `MarkdownDiskProjector` moves to wiki-mirror unchanged (its on-disk behavior + manifest format are byte-for-byte identical, so an existing mirror self-heals and continues).

Emitter configuration is a **user-level local file** — `~/.wiki/wiki-mirror.config.json` by default, ONE per-machine file shared by every project's mirror rather than a copy per checkout (`--config` / `WIKI_MIRROR_CONFIG` point elsewhere; resolved `flags → env WIKI_MIRROR_* → file → defaults`) — mapping each `workspaceId → absolute root`: per-machine state that must never live in shared server storage or a checkout. One process tails N workspaces; single-writer-per-root is enforced; config is read once at startup (restart to reconfigure).

Generalize the principle: per-machine, **local-only concerns belong in a local stream-client**, keeping the engine + host filesystem-free and deployable. Markdown emission is the first such concern moved out; git operations on the mirror (stage/commit/push) are the natural next addition, and the mirror already owns the checkout path that seam needs.

## Consequences
The host (wiki-mcp/wiki-server) no longer touches a local filesystem and can be deployed to shared/cloud infrastructure. Each developer mirrors to their own checkout under their own control — a strictly better trust story than a shared server writing verbatim absolute roots.

Local development now runs two processes (server + mirror), orchestrated by a single `npm start` (via `concurrently`), so the DX stays one command. Markdown emission has a single code path instead of an embedded-vs-external fork.

Agents lose the ability to configure a mirror over MCP — correct, since an agent talking to a shared server should not write a path on someone's laptop. Reconfiguring the mirror is a local-file edit plus a restart (no live config reload in v1).

Determinism is the safety net: render is pure, so the mirror writes byte-identical Markdown to what the embedded emitter produced — only WHERE the rendering runs changed (host → local client).

Out of scope / follow-ups: durable stream storage for a cloud host, auth/TLS on the host endpoints, and cloud model-bundle availability are separate deploy-track decisions; multi-workspace-to-one-root and git operations on the mirror are deferred enhancements.

## Relations
_None._
