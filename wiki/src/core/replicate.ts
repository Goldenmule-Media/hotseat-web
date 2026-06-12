/**
 * Stream-to-stream workspace replication — the schema-agnostic core of "copy a
 * workspace between Durable Streams servers" (e.g. local↔remote migration).
 *
 * It reads the SOURCE workspace stream commit-by-commit (each stored array-message
 * is one command's atomic commit), and re-appends each commit VERBATIM to the
 * DESTINATION stream, reproducing the source's exact OCC sequence
 * (`seq = pad(expectedVersion)`). Because every envelope — `version`, `schemaVersion`,
 * `streamId`, `eventId`, `meta`, `payload` — is carried unchanged and the commit
 * boundaries are preserved, the destination folds byte-identically to the source.
 *
 * It copies opaque envelopes only: it never folds, renders, or loads a page type, so
 * it works across servers, namespaces, and schema sets. It is:
 *  - **idempotent + resumable** — re-running copies only the commits past the
 *    destination head; a second run against an up-to-date destination copies nothing;
 *  - **non-destructive** — if the destination already holds a DIVERGENT history under
 *    the same id (its prefix doesn't match the source, or it has more events), it
 *    throws {@link ReplicationConflictError} and writes nothing further.
 *
 * The sibling snapshot stream is intentionally NOT copied (snapshots are caches,
 * invalidated on a schema-fingerprint mismatch — the destination re-folds from zero).
 * The namespace `_catalog` entries for the workspace ARE copied (best-effort) so it
 * lists on the destination.
 *
 * This module lives inside the engine because the persistence seam — the only code
 * permitted to talk to `@durable-streams/client` — is the engine's `EventLog`. It
 * constructs two `EventLog`s (source + dest) from plain {@link IStreamConfig}s.
 */
import type { IStreamConfig, WorkspaceId } from "../api";
import { EventLog } from "../stores/event-log";

export interface ReplicateWorkspaceOptions {
  /** Where to read the workspace stream from. */
  readonly source: IStreamConfig;
  /** Where to copy it to (may be a different server, namespace, and auth tier). */
  readonly dest: IStreamConfig;
  /** The workspace to copy. Its id is preserved on the destination. */
  readonly workspaceId: WorkspaceId;
  /** Copy the source's `_catalog` entries for this workspace to the dest. @default true */
  readonly includeCatalog?: boolean;
  /** Compute the plan and write NOTHING — for a safe preview. @default false */
  readonly dryRun?: boolean;
}

/** What a replication run did (or, for a dry-run, would do). */
export interface ReplicationReport {
  readonly workspaceId: WorkspaceId;
  /** Commits (array-messages) on the source. */
  readonly sourceCommits: number;
  /** Events on the source (flattened). */
  readonly sourceEvents: number;
  /** Events already present on the destination before this run. */
  readonly destHeadBefore: number;
  /** Commits copied this run (0 for an up-to-date destination). */
  readonly copiedCommits: number;
  /** Events copied this run. */
  readonly copiedEvents: number;
  /** Events on the destination after this run (== `destHeadBefore` for a dry-run). */
  readonly destHeadAfter: number;
  /** `_catalog` entries copied (or, dry-run, that would be copied). */
  readonly catalogEventsCopied: number;
  readonly dryRun: boolean;
}

/**
 * Raised when the destination is NOT a clean prefix of the source — its existing
 * events diverge from the source's, or it holds more events than the source — so a
 * copy would clobber or corrupt it. Replication refuses rather than overwrite.
 */
export class ReplicationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplicationConflictError";
  }
}

/**
 * Copy a workspace's event stream from `source` to `dest`. Returns a
 * {@link ReplicationReport}; throws {@link ReplicationConflictError} if the
 * destination diverges from the source.
 */
export async function replicateWorkspace(
  opts: ReplicateWorkspaceOptions,
): Promise<ReplicationReport> {
  const includeCatalog = opts.includeCatalog ?? true;
  const dryRun = opts.dryRun ?? false;
  const ws = opts.workspaceId;

  // `IStreamConfig` is structurally an `EventLogConfig`, so the configs pass straight
  // through — and a future divergence fails to compile here rather than silently drop a field.
  const source = new EventLog(opts.source);
  const dest = new EventLog(opts.dest);
  try {
    // Independent cross-server reads: overlap the full source read with the dest probe
    // (a local↔remote migration makes each a network round-trip).
    const [sourceCommits, destExists] = await Promise.all([source.readCommits(ws), dest.exists(ws)]);
    const sourceEvents = sourceCommits.flat();

    // Defensive: the source stream must be gap-free 0..N-1 in version order, or its
    // OCC sequence can't be reproduced faithfully.
    for (let i = 0; i < sourceEvents.length; i++) {
      if (sourceEvents[i].version !== i) {
        throw new ReplicationConflictError(
          `source workspace ${ws} has a version gap at index ${i} (event.version=${sourceEvents[i].version})`,
        );
      }
    }

    // Find the resume point from the destination's existing commits. The exists() probe
    // above means a dry-run (and an apply with nothing to copy) never CREATES an empty
    // destination stream as a side effect — readCommits would otherwise ensure it.
    const destEventsBefore = destExists ? (await dest.readCommits(ws)).flat() : [];
    const destHead = destEventsBefore.length;

    if (destHead > sourceEvents.length) {
      throw new ReplicationConflictError(
        `destination workspace ${ws} has ${destHead} events but the source has only ${sourceEvents.length} — refusing to clobber a divergent destination`,
      );
    }
    for (let i = 0; i < destHead; i++) {
      if (destEventsBefore[i].eventId !== sourceEvents[i].eventId) {
        throw new ReplicationConflictError(
          `destination workspace ${ws} diverges from the source at version ${i} — refusing to clobber`,
        );
      }
    }

    // Re-append each source commit that isn't already on the destination, verbatim and
    // in order, so `seq = pad(expectedVersion)` matches the source's sequence exactly.
    let cursor = 0; // event index at the start of the current commit
    let copiedCommits = 0;
    let copiedEvents = 0;
    for (const commit of sourceCommits) {
      const end = cursor + commit.length;
      if (commit.length === 0) {
        continue; // an empty append is a no-op on both sides
      }
      if (end <= destHead) {
        cursor = end; // this whole commit is already present
        continue;
      }
      if (cursor < destHead) {
        // The destination head fell mid-commit — only possible if it was written by a
        // different commit grouping, i.e. a divergent destination.
        throw new ReplicationConflictError(
          `a source commit straddles the destination head (${destHead}) — cannot resume a divergent destination`,
        );
      }
      if (!dryRun) {
        await dest.append(ws, commit, { expectedVersion: cursor });
      }
      copiedCommits++;
      copiedEvents += commit.length;
      cursor = end;
    }

    // Catalog: a best-effort SECONDARY index (not a consistency boundary) so the
    // workspace LISTS on the destination. Copy the source's entries for this workspace
    // only when the destination has NONE — presence-based, so a re-run is a no-op and a
    // divergent destination catalog is never mis-ordered. catalogExists() is a
    // non-creating probe, so even a dry-run touches neither catalog stream; appends are
    // gated by `!dryRun`. A catalog failure must NOT fail an otherwise-complete copy.
    let catalogEventsCopied = 0;
    if (includeCatalog) {
      const destHasWs =
        (await dest.catalogExists()) && (await dest.readCatalog()).some((e) => e.id === ws);
      if (!destHasWs) {
        const sourceForWs = (await source.catalogExists())
          ? (await source.readCatalog()).filter((e) => e.id === ws)
          : [];
        try {
          for (const event of sourceForWs) {
            if (!dryRun) await dest.appendCatalog(event);
            catalogEventsCopied++;
          }
        } catch {
          // The workspace stream is fully copied; a catalog hiccup only delays the
          // workspace appearing in destination listings (a later run reconciles it).
        }
      }
    }

    return {
      workspaceId: ws,
      sourceCommits: sourceCommits.length,
      sourceEvents: sourceEvents.length,
      destHeadBefore: destHead,
      copiedCommits,
      copiedEvents,
      destHeadAfter: dryRun ? destHead : cursor,
      catalogEventsCopied,
      dryRun,
    };
  } finally {
    await source.close();
    await dest.close();
  }
}
