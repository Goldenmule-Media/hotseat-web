# Spec

**Status:** sealed

## Overview
Markdown disk mirrors are configured at runtime, per project, over MCP, replacing the static boot-time md flags. A project registers an emitter (configureEmitter with emitterId, workspaceId, root, optional archive) that mirrors one workspace's deterministic Markdown into one absolute on-disk root; listEmitters and removeEmitter manage the set. The emitter set is event-sourced on its own per-namespace emitter-config durable stream (replayed and folded on boot, last-writer-wins per emitterId, tailed live), so mirrors survive restarts and configure or remove take effect with no restart. Each emitter is a MarkdownDiskProjector render sink on the existing one-render-per-commit projection fan-out; a freshly-registered emitter back-fills its root from the workspace stream head, and removal leaves already-mirrored files on disk. Local-only trust in v1: roots are written verbatim, single-writer per root.

## Design
_No design yet._

## Decisions
Emitter config lives on its own durable emitter-config stream per namespace, owned by wiki-mcp, never mixed into workspace event streams. It is operational read-side config, not wiki domain data; wiki-mcp opens its own durable-streams client because the engine's EventLog is internal. Should emitter config live on the wiki's event streams or its own?

Configuration is a runtime MCP API, not static boot config: a shared server cannot know each project's checkout path at boot and checkouts come and go, so projects self-register. The old static md flags and env surface are removed outright. Static boot config, or a runtime API?

One emitter maps exactly one workspace to one absolute root, keyed by a caller-supplied emitterId. Simplest addressing; several mirrors means several emitters. Re-using an id reconfigures that emitter. One workspace per emitter, or a set of workspaces?

An emitter takes effect with no restart: a tailer on the config stream adds a MarkdownDiskProjector render sink and reconciles it from the workspace stream head for an immediate back-fill; removal drops the sink. This needed a new ProjectionService removeRenderSink plus a single-sink reconcileSink. How does an emitter take effect without a server restart?

removeEmitter leaves already-mirrored files on disk; it only stops future updates and detaches the sink, and the repo checkout owns the rendered files from then on. What happens to mirrored files when an emitter is removed?

On-disk root safety is out of scope for v1: assume local, single-machine, single-user operation. Roots are trusted absolute paths written verbatim and the tool rejects relative paths; a path allowlist or sandbox can come later if the server is shared across trust boundaries. How are arbitrary on-disk roots kept safe?

## References
_None._

## Child pages
_None._
