# Feature: Stream-to-stream migration: copy a workspace between servers

**Status:** shipped

## Summary
An admin/system operation that copies a workspace's entire event stream from one Durable Streams server to another — e.g. local→remote or remote→local — producing a byte-identical workspace on the destination. The core is a schema-agnostic engine function, replicateWorkspace(), that reads the source workspace stream commit-by-commit (preserving the array-message commit boundaries and every envelope field verbatim) and re-appends each commit to the destination, so the destination folds to identical state. It copies the workspace's catalog entries too (so it lists on the destination) and is idempotent + resumable. The operator-facing surface is a safe-by-default CLI in wiki-mcp (dry-run unless --apply). It keeps the SAME workspace id (a faithful replica for migration between hosts); cloning to a new id on the same server is out of scope for v1.

## Components affected
- wiki engine: replicateWorkspace() — the schema-agnostic raw-commit copy core (reads source commits, re-appends to dest preserving version/seq, copies catalog, idempotent + resumable). Lives behind the engine seam in wiki/src/core/replicate.ts.
- wiki engine: IEventLog.readCommits() + EventLog.readCommits() — a commit-preserving read (the array-messages WITHOUT flattening), the one new persistence-seam primitive replication needs.
- wiki public surface: export replicateWorkspace + its option/report types from wiki/src/index.ts.
- wiki-mcp: migrate-workspace CLI (tsx src/migrate-workspace.ts) — source/dest url+namespace+token flags, safe-by-default dry-run, --apply to write; backfill-serials style. Plus the npm script.

## Design constraints
1. Import boundary (load-bearing): only wiki/src/stores/event-log.ts may import @durable-streams/client. The copy core therefore lives inside the engine and constructs EventLog instances — NOT a new DS-client module in wiki-mcp.
2. Faithfulness: preserve array-message commit boundaries and every envelope field (eventId, streamId, version, schemaVersion, payload, meta) VERBATIM, so foldWorkspace(dest) deep-equals the source and toMarkdown is byte-identical.
3. Schema-agnostic: replication copies opaque envelopes and never folds/renders, so it loads NO page types. The CLI needs no wiki-models.
4. Same workspace id at the destination (faithful replica for local↔remote migration). Cloning to a NEW id on the same server (rewriting streamId in every envelope) is a deferred follow-up, not v1.
5. Idempotent + resumable + non-destructive: re-running copies only commits past the destination head; a destination whose existing prefix diverges from the source is REFUSED (never clobbered). OCC seq = pad(expectedVersion) reproduces the source's exact sequence.
6. Skip the sibling snapshot stream — snapshots are caches, invalidated on a schema-fingerprint mismatch; the destination re-folds from zero. Copy the namespace _catalog entries for this workspace (best-effort) so it lists on the destination.
7. Cross-workspace admin/system affordance (ADR-30), not a routine content tool. The operator CLI is safe-by-default (dry-run unless --apply) and authenticates to both ends via the engine IStreamConfig.headers bearer seam.
8. Operational/admin engine ops are exposed behind a dedicated `wiki/admin` subpath barrel (src/admin.ts), fenced off from the everyday authoring/read API on the main `wiki` barrel. replicateWorkspace lives there; future ops (clone-to-new-id, export/import, re-projection) land there too. (Engine admin actions that are already IWorkspaceHandle methods — assignSerials, archive/unarchive, rename — stay as methods.)

## Open questions
_None._

## Resolved questions
1. **Operator surface: ship the CLI now and defer an MCP `migrateWorkspace` admin tool + a /_server control endpoint?** — _CLI-first. The intent is operator migration between local and remote, which an ops CLI serves best, and it avoids threading a foreign destination-server bearer token through the MCP/auth surface. The engine core (replicateWorkspace) is the reusable piece both surfaces would share, so a later MCP admin tool or /_server endpoint is thin wiring over the same function — deferred, not blocked._
2. **Clone-to-new-id (copy within one server under a fresh workspace id, rewriting streamId in every envelope) — defer to a follow-up?** — _Defer. v1 keeps the same workspace id (a faithful replica for host-to-host migration). Cloning to a new id requires rewriting streamId in every envelope and minting a fresh id + catalog entry — a distinct, larger feature. Same-id replication already covers the stated use case (local↔remote copy)._

## References
_None._

## Child pages
- [Implementation plan — Stream-to-stream migration: copy a workspace between servers](implementation-plan:mqb9074t-001f-yd818n)
- [Testing plan — Stream-to-stream migration: copy a workspace between servers](testing-plan:mqb9074t-001g-h9zcu7)
- [Spec — Stream-to-stream migration: copy a workspace between servers](feature-spec:mqb9074t-001h-9hawnj)

## Commits
- `8ee77ae` feat(wiki): stream-to-stream workspace replication — copy a workspace between servers
- `867b06d` refactor(wiki): expose operational ops behind a `wiki/admin` subpath barrel
- `7e096b8` fix(wiki): harden replicateWorkspace catalog path + tidy from code review
