# toc

**Status:** current

## Kind
component

## Summary
A generated, curatable Table Of Contents of a page's own children — a derived child list plus stored grouping / placement curation. (This very "Architecture" index is a `toc`.)

## Purpose
Gives a never-drifting index over the live child set, letting an author add named buckets and per-child ordering without ever hand-duplicating the child list or touching the page tree.

## Design notes
_No design notes._

## Components
_No components._

## Dependencies
_No dependencies._

## Code references
- constant `Toc` in `wiki-models/src/toc/toc.ts`

## Data model
`list` elements `group` (prose `title` / `blurb`) and `entry` (scalar `child` / `group`). Declares `derived: { contents }` — a `DerivedList` that buckets `ctx.childrenOf(self)` by the stored groups + placement, with a trailing "Ungrouped" bucket. No `computed`, no element FSMs.

## Usage
**Lifecycle:** none — `initialStatus: "active"`, `statusTransitions: []` (always editable; removal is the structural `archivePage`). Sections: `overview` (prose), `groups` (ordered list), `placement` (ordered list). Representative commands: `addGroup` / `renameGroup` / `removeGroup`, `assignChild` / `unassignChild`, and `reorderGroups` / `reorderChildren`.

## Invariants & constraints
- The `contents` list is a pure DERIVED view of the current children; the page stores only curation (`groups` + `placement`), never the child list, so it can never drift.
- Placements reconcile against the LIVE child set at render: a placement whose child was reparented away or whose group was removed is silently ignored; a new child appears under "Ungrouped" until curated (first-placement-wins, deduped).
- Reordering the TOC never mutates the actual page tree; `removeGroup` also removes referencing placements; `sectionSet` closed, all sections `required`.

## Synced commit
e357aa7
