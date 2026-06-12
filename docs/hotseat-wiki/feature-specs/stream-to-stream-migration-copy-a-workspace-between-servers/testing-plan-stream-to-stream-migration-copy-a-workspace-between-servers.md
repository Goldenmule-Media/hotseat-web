# Testing plan — Stream-to-stream migration: copy a workspace between servers

**Status:** ready

## Planned
_None._

## Passed
- Round-trip identity: build a non-trivial workspace on source server A (createPage a feature-brief + children, run several mutations), replicateWorkspace to a fresh dest server B, then open the workspace on B. foldWorkspace(B.history) deep-equals foldWorkspace(A.history) and B.toMarkdown(root) is byte-identical to A's.
- Commit-boundary preservation: a multi-event commit on the source (e.g. mutateMany / createPage that auto-materializes pinned children) is re-appended to the dest as ONE array-message, not flattened. Assert dest readCommits length == source readCommits length and each commit's length matches (the engine's internal seam, exercised via a thin test hook or by asserting dest head/version equality).
- Idempotent resume: run replicateWorkspace twice against the same dest — the second run reports copiedCommits == 0 and copiedEvents == 0 and does not throw. Then append more commits on the source and replicate again: only the new commits are copied (copiedCommits == number of new commits), and the dest folds identical to the source.
- Catalog listing: after replication, dest.listWorkspaces() includes the migrated workspace with the correct name and active status (the _catalog entries were copied). A destination engine loaded with the same page types re-folds the workspace from zero with no snapshot present.
- Dry-run: replicateWorkspace({ dryRun: true }) writes nothing (dest workspace stream stays empty / dest.listWorkspaces() unchanged) but the returned report's sourceCommits/sourceEvents/copiedCommits counts reflect what WOULD be copied.
- Divergence guard: a destination that already holds a DIFFERENT workspace history under the same id (a non-matching prefix, or more events than the source) causes replicateWorkspace to throw ReplicationConflictError and write nothing further — the existing dest stream is never clobbered.

## Failed
_None._

## References
_None._

## Child pages
_None._
