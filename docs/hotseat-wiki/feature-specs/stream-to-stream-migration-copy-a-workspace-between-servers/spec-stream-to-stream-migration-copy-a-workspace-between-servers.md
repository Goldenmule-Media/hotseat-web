# Spec — Stream-to-stream migration: copy a workspace between servers

**Status:** sealed

## Overview
Stream-to-stream workspace replication copies a workspace's entire event stream from one Durable Streams server to another (e.g. local-to-remote migration), producing a byte-identical workspace on the destination. The core is a schema-agnostic engine function, replicateWorkspace(), exposed on the wiki/admin subpath barrel; a safe-by-default wiki-mcp CLI (migrate-workspace) is the operator surface.

## Design
## Mechanism

A workspace is one append-only Durable Stream; each command's events are stored as one array-message (a commit), ordered by a 0-based per-workspace version that drives both the fold and optimistic concurrency. replicateWorkspace reads the source stream commit-by-commit, preserving those array-message boundaries, and re-appends each commit to the destination with expectedVersion set to the running head, so seq = pad(expectedVersion) reproduces the source's exact sequence. Every envelope field (eventId, streamId, version, schemaVersion, payload, meta) is carried unchanged, so the destination folds byte-identically and renders identical Markdown.

## Guarantees

Idempotent and resumable: a re-run copies only the commits past the destination head, comparing the existing prefix by eventId. Non-destructive: a destination whose prefix diverges from the source, or that holds more events than the source, is refused with ReplicationConflictError rather than clobbered. Schema-agnostic: replication copies opaque envelopes and never folds, renders, or loads a page type, so it works across servers, namespaces, and schema sets.

## Scope and side concerns

The same workspace id is kept on the destination (a faithful replica for host-to-host migration). The sibling snapshot stream is skipped because snapshots are caches, invalidated on a schema-fingerprint mismatch; the destination re-folds from zero. The namespace catalog entries for the workspace are copied best-effort and presence-based (only when the destination has none), via a non-creating catalogExists probe, so even a dry-run is side-effect-free and the workspace still lists on the destination.

## Surface and import boundary

The copy lives behind the engine seam: only wiki/src/stores/event-log.ts touches the Durable Streams client, via a new commit-preserving readCommits() and the non-creating catalogExists() probe. replicateWorkspace is exposed on the wiki/admin subpath barrel, which fences operational ops off from the everyday authoring/read API on the main wiki barrel. The operator CLI is safe-by-default (dry-run unless --apply) and authenticates to both ends through the engine's per-request IStreamConfig.headers bearer seam.

```typescript
// wiki/admin
export function replicateWorkspace(opts: {
  source: IStreamConfig;        // baseUrl + namespace (+ optional bearer headers)
  dest: IStreamConfig;
  workspaceId: WorkspaceId;     // preserved on the destination
  includeCatalog?: boolean;     // default true
  dryRun?: boolean;             // default false — write nothing, just report
}): Promise<ReplicationReport>;

export class ReplicationConflictError extends Error {}  // destination diverges
```

## Decisions
Ship a CLI-first operator surface and defer an MCP migrateWorkspace admin tool plus a /_server control endpoint. The engine's replicateWorkspace is the reusable core any surface shares, so a later one is thin wiring; the CLI also avoids threading a foreign destination bearer token through the MCP/auth surface. Operator surface: ship the CLI now and defer an MCP `migrateWorkspace` admin tool + a /_server control endpoint?

Keep the same workspace id on the destination (a faithful replica for local-to-remote migration). Cloning to a new id — rewriting streamId in every envelope and minting a fresh id and catalog entry — is deferred as a distinct, larger feature; same-id replication already covers the stated use case. Clone-to-new-id (copy within one server under a fresh workspace id, rewriting streamId in every envelope) — defer to a follow-up?

## References
_None._

## Child pages
_None._
