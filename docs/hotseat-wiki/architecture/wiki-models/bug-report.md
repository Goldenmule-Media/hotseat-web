# bug-report

**Status:** current

## Kind
component

## Summary
A defect as a first-class, FSM-governed page: the triage basics (component / platform / version), a summary, an ordered repro recipe, expected vs. observed prose, and a resolution list of fix commits. Ships as its own runtime-loadable `bug` bundle (`wiki-models/bug`).

## Purpose
Makes bug intake and closure guarded mutations rather than free text: a report cannot open until its basics are authored, and cannot close without naming the commit that fixed it — the fix history accumulates across reopen/re-close cycles.

## Design notes
_No design notes._

## Components
_No components._

## Dependencies
_No dependencies._

## Code references
- constant `BugReport` in `wiki-models/src/bug/bug-report.ts`

## Data model
Sections: `report` (required scalars `component` / `platform` / `version`), `summary` / `expected` / `observed` (required prose `body`), `repro` (ORDERED `list` of `step` — prose `text`), `resolution` (ORDERED `list` of `commit` — required scalars `sha` / `message`, optional `url`). Declares `derived: { "report-rows" }` (a pure formatter of the report basics). No element FSMs, no enums.

## Usage
**Lifecycle:** `draft --open--> open --close--> closed --reopen--> open`. `open` carries `agency: "agent"` (the forward completeness edge); `close` / `reopen` carry no agency — closing claims a real fix landed, never auto-driven. Commands: `setComponent` / `setPlatform` / `setVersion` / `setSummary` (the create-gate content), `addReproStep` / `removeReproStep`, `setExpected` / `setObserved`, then `open`, `close({ sha, message, url? })`, `reopen`.

## Invariants & constraints
- "Required on creation" is the draft→open gate: `createPage` takes no field args, so the `reportComplete` precondition gates the open edge on component, platform, version, and summary all being non-empty — the unmet reason names exactly the missing fields, driving the self-directing loop.
- `close` is ONE declarative command combining a content op and the page transition (`set` + `transition` in a single atomic op list): it appends a `commit` element to `resolution` AND fires `close`, so a commit-less close is unrepresentable — the args schema makes `sha` and `message` mandatory.
- Content sections are `mutableIn: ["draft", "open"]` (frozen once closed); `resolution` is `mutableIn: ["open"]` only. A reopen→re-close appends a SECOND fix commit — the resolution list keeps the full fix history, never overwriting.

## Synced commit
fbabb27
