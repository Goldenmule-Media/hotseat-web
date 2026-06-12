# Implementation plan — Stream-to-stream migration: copy a workspace between servers

**Status:** ready

## Steps
- [x] wiki engine seam: add a commit-preserving read. Declare readCommits(ws): Promise<Commit[]> on IEventLog (wiki/src/core/types.ts, next to read()) and implement it on EventLog (wiki/src/stores/event-log.ts) as the array-messages WITHOUT flattening — i.e. `await res.json()` returns IEventEnvelope[][] (each element is one commit). Reuse ensure() + headerOpts() + START_OFFSET exactly like read().
- [x] wiki engine: new module wiki/src/core/replicate.ts exporting replicateWorkspace(opts). Construct a source EventLog and a dest EventLog from the two IStreamConfigs (this keeps all @durable-streams access inside the engine). Read source commits via readCommits; assert gap-free version contiguity (defensive throw on a gap). Read dest commits to compute destHead (event count already present).
- [x] wiki engine: replication body. Verify the destination is a clean PREFIX of the source: every event already on dest (0..destHead) must have an eventId equal to the source's at that index; on any mismatch, or destHead > sourceEvents, throw ReplicationConflictError (never clobber). Then append each not-yet-copied SOURCE COMMIT verbatim via dest.append(ws, commit, {expectedVersion: runningHead}), advancing runningHead by commit.length — this reproduces seq = pad(expectedVersion) exactly. Skip whole commits whose events are all <= destHead (idempotent resume). When dryRun, count only and write nothing.
- [x] wiki engine: catalog copy. Read the source namespace _catalog, filter to this workspaceId, and append those CatalogEvents to the dest _catalog (best-effort; swallow failures) so the workspace lists on the destination with its name/archived status — only when not already present on dest and not dryRun. Skip the sibling snapshot stream entirely. Return a ReplicationReport (counts + dest head before/after).
- [x] wiki public surface: export replicateWorkspace and its types (ReplicateWorkspaceOptions, ReplicationReport, ReplicationConflictError) from wiki/src/index.ts. These are the only new public symbols; the EventLog/readCommits stay internal.
- [x] wiki-mcp operator CLI: wiki-mcp/src/migrate-workspace.ts (backfill-serials style). Flags: --workspace <id> (required), --source-url/--source-namespace/--source-token (default source = local server http://127.0.0.1:4437, namespace from WIKI_MCP_NAMESPACE/'default'), --dest-url/--dest-namespace/--dest-token (dest-url required), --apply (default dry-run). Build IStreamConfig.headers = { authorization: () => `Bearer ${token}` } when a token is given. Call replicateWorkspace({ source, dest, workspaceId, dryRun: !apply }) and print the report. Loads NO page types. Add the npm script "migrate-workspace": "tsx src/migrate-workspace.ts" to wiki-mcp/package.json.
- [x] Tests: wiki/test/replicate.test.ts using two in-process DurableStreamTestServers (wiki/testing startTestServer + wikiOn) and the real feature bundle from wiki-models/feature. Cover round-trip identity, commit-boundary preservation, idempotent resume, catalog listing, dry-run, and the divergence guard (see the testing-plan).
- [x] Expose operational ops behind a wiki/admin subpath barrel: add wiki/src/admin.ts re-exporting replicateWorkspace + types + ReplicationConflictError, add the "./admin" entry to wiki/package.json exports, remove the replication re-exports from the main wiki/src/index.ts barrel, and import the operation from "wiki/admin" in the migrate-workspace CLI (general types stay on "wiki").

## Data models & interfaces
```typescript
// wiki/src/core/replicate.ts — public engine surface (re-exported from wiki/src/index.ts).
// Source and dest are plain IStreamConfig (baseUrl + namespace + optional headers/ttl),
// so the function works across servers, namespaces, and auth tiers. Schema-agnostic:
// it copies opaque IEventEnvelope[] commits and never folds or renders.

import type { IStreamConfig, WorkspaceId } from "../api";

export interface ReplicateWorkspaceOptions {
  readonly source: IStreamConfig;
  readonly dest: IStreamConfig;
  readonly workspaceId: WorkspaceId;
  /** Copy the source's _catalog entries for this workspace to the dest (default true). */
  readonly includeCatalog?: boolean;
  /** Count only; write nothing (default false). */
  readonly dryRun?: boolean;
}

export interface ReplicationReport {
  readonly workspaceId: WorkspaceId;
  readonly sourceCommits: number;
  readonly sourceEvents: number;
  readonly destHeadBefore: number; // events already on dest
  readonly copiedCommits: number;
  readonly copiedEvents: number;
  readonly destHeadAfter: number;
  readonly catalogEventsCopied: number;
  readonly dryRun: boolean;
}

/** Thrown when the destination is not a clean prefix of the source (would clobber/diverge). */
export class ReplicationConflictError extends Error {}

export function replicateWorkspace(
  opts: ReplicateWorkspaceOptions,
): Promise<ReplicationReport>;

// New persistence-seam primitive (internal): commit-preserving read.
//   interface IEventLog { readCommits(ws: WorkspaceId): Promise<Commit[]>; /* = IEventEnvelope[][] */ }
```

## Open questions
_None._

## Resolved questions
_None._

## References
_None._

## Child pages
_None._
