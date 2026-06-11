# Structure & invariants

**Status:** current

## Kind
subsystem

## Summary
The structural-command handlers (`createPage`, `reparent`, `reorder`, `setPageTitle`, `archivePage`, `link` / `unlink`, `moveItem`, `renameWorkspace`, `archiveWorkspace`) plus the workspace-graph integrity rules and intra-page section-tree mechanics. Each handler is a pure `(state, args, services, registry) → { events, result }`.

## Purpose
Enforces tree/graph integrity (acyclic page tree, parent/page exists, unique sibling title, link target exists, pinned-child protection) and cross-page atomicity (e.g. `moveItem` as one `removeElement` + `addElement` in a single commit) — the payoff of one stream = one aggregate.

## Design notes
Every structural handler is a pure function of shape (state, args, services, registry) that returns lightweight domain events plus an optional result; it performs no IO, reads no host clock or RNG, and obtains time and ids only through the injected services. That purity is load-bearing because the command bus re-runs the handler on every optimistic-concurrency rebase: when an append loses the version race, the bus folds the freshly committed tail into state and re-decides the command against that newer state before retrying. As a result, a handler's invariant checks (parent-exists, unique-sibling-title, cycle-free, pinned-protection) are evaluated against the true latest state at the moment of the winning append, never a stale snapshot, and two concurrent creates can never both mint the same serial or collide on a sibling title. The bus already confirms the workspace is active before dispatch; each handler additionally refuses to mutate a target page that is archived, while leaving reads of archived pages unaffected.

createPage produces a whole pinned subtree in a single atomic commit. After confirming the registry knows the requested type, that the parent (when given) exists and is not archived, and that the title is unique among its siblings, it walks the type's requiredChildren recursively: each required child emits its own PageCreated stamped pinned, parented to the page just created, and required children of required children are emitted too. Required children receive a friendly default title, the child type's declared label, falling back to a title-cased form of the type id, so the tree and rendered heading read as a human phrase rather than a raw slug. Because the entire cascade is one event array, the page and its mandatory scaffold either all land or none do; a page type can never exist in the workspace missing the children its contract requires.

createPage also mints serial numbers as part of the same decision. For every field a type declares with kind serial, the handler scans all pages of the same type in the workspace (archived ones included, so a number is never reused) and assigns one greater than the current maximum, starting at one. The minted values ride along inside the PageCreated payload, so numbering is decided purely from committed state and is re-derived on rebase, which is what keeps concurrent creates from issuing duplicate serials. The companion assignSerials handler is the backfill path for a type that gained a serial field after pages already existed: it assigns the still-unset pages, in creation order, the next available number as one setField per page in one commit. It is strictly additive and idempotent: a page whose serial is already set is never touched, and once every page is numbered it emits nothing, so re-running it is safe.

reparent guards two distinct invariants before moving a page. To keep the tree acyclic it walks the subtree rooted at the page being moved and rejects a new parent that is the page itself or any of its descendants. To keep a required subtree intact it refuses to move a pinned page out of its owner: a pinned child may be reordered, but never detached. When a target position is supplied the handler does not leave ordering to chance: it computes the resulting sibling sequence (clamping the index into range) and emits an explicit ChildrenReordered alongside PageReparented, so the reducer applies a fully determined order rather than guessing. The standalone reorder verb is purely a permutation check (the supplied id list must have the same membership as the current children, with no duplicates, extras, or omissions) and emits a single ChildrenReordered. Archiving is an orthogonal visibility flag that leaves a page's lifecycle status untouched; archivePage refuses to archive a pinned page on its own (archive its owner instead) and both archive and unarchive are idempotent no-ops when the page is already in the requested state.

moveItem is the verb that proves the payoff of one stream equalling one aggregate: it relocates a single list element between two different pages atomically. The handler locates the element by id in the source page's named section-and-field list (raising ItemNotFoundError if it is absent), deep-clones its fields, status, and metadata, then emits two section-operation events in one batch: a removeElement targeting the source page and an addElement carrying the cloned element to the destination page. Because both pages live in the same workspace stream, those two events commit as one array-message; there is no window in which the element is duplicated across both pages or lost from both. link and unlink are the graph-edge counterparts: each adds or removes a from-role-to edge after confirming both endpoints exist, expressing relationships that cross the tree without altering parentage.

Cross-page gates are expressed not inside the structural handlers but as pure preconditions on a page type's lifecycle commands, evaluated through the context's related reader. The related reader exposes self (the page being mutated), childrenOf(id), and page(id) returning another page's full folded state, all read-only, letting a transition's legality depend on sibling content while staying deterministic. A feature-brief uses this to gate beginImplementation on its implementation-plan child holding at least one step and at least one data-model code block and its testing-plan child holding at least one case; it gates ship on every implementation-plan step being done, every testing-plan case being passed, and the brief itself carrying zero open questions. Each precondition returns either true or an unmet reason string. Crucially these run inside the decide step on every attempt, so they re-check against fresh state on each optimistic-concurrency rebase: a gate that passed when a command was first issued is re-verified before the winning append, and the same pure checks power the read side, surfacing each blocked transition with its unmet reason so callers see exactly what content must be authored first.

Workspace-level verbs round out the handler set. renameWorkspace emits WorkspaceRenamed to change the workspace's display name (the id never changes, so references stay valid); the name must be non-empty after trimming, and renaming to the current name emits nothing — deliberate, because a rename is not free downstream: the Markdown-disk mirror derives its per-workspace directory from the name's slug, so isStructuralCommit classifies WorkspaceRenamed as path-moving and a rename triggers a whole-mirror rebuild that relocates every file and sweeps the old directory. archiveWorkspace / unarchiveWorkspace flip the workspace's status, with unarchive the one verb exempt from the command bus's archived-workspace guard (the way back); rename, like every other structural verb, is blocked while the workspace is archived. All three sync the namespace catalog (WorkspaceRenamed / WorkspaceArchived / WorkspaceUnarchived catalog events, best-effort) so the catalog-folded listWorkspaces agrees with the per-workspace stream, which remains the source of truth.

## Components
_No components._

## Dependencies
- **depends-on** → [Section-operation reducer & fold](architecture:mpzoiq0g-004l-dunnzt) — Its emitted events are applied by `applyWorkspace`.

## Code references
- constant `STRUCTURAL_HANDLERS` in `wiki/src/core/structure.ts`
- function `moveSectionByKey` in `wiki/src/core/section-structure.ts`
- function `validatePage` in `wiki/src/core/ingestion.ts`

## Data model
Reads/derives `IWorkspaceState.children` (the ordered page tree, keyed by `PageId | ROOT`), `links`, and `pages`; section-tree helpers maintain `ISection.parentId` / `order` under unique-sibling-key and acyclic invariants.

## Usage
The command bus dispatches `runStructural` through `STRUCTURAL_HANDLERS[name]`; the reducer's `applyWorkspace` and the `section-structure.ts` helpers apply the resulting events; handlers re-run on every OCC rebase, so invariants re-check against fresh state.

## Invariants & constraints
- `reparent` rejects making a page its own descendant (`CycleError`); unique sibling title among page children (`DuplicateTitleError`) and unique sibling key among sections (`DuplicateSectionKeyError`).
- Both link endpoints must exist (`LinkTargetNotFoundError`); a missing page/parent is `PageNotFoundError` / `ParentNotFoundError`.
- Pinned (required-child) pages can't be reparented out of their owner or archived alone (`InvariantViolationError`); `createPage` emits the page + its `requiredChildren` recursively as pinned in one atomic commit.

## Synced commit
e357aa7
