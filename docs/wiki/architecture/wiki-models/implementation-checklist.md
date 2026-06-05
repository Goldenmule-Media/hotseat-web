# implementation-checklist

**Status:** current

## Kind
component

## Summary
A tracked-work checklist for the building phase: a DERIVED view of the plan's steps plus a list of locally-tracked tasks (manual or computed gate-tasks).

## Purpose
Surfaces build progress without storing duplicate step state, and lets gate-tasks expose structural facts (e.g. all test cases passed) as un-toggleable computed checkboxes.

## Components
_No components._

## Dependencies
- **depends-on** → [implementation-plan](architecture:mpzoj3ml-0059-wso9al) — Its "Plan steps" list is a DERIVED view of this plan's step statuses (stores no step state).
- **depends-on** → [testing-plan](architecture:mpzoj5y7-005d-t14bjq) — Reads the testing-plan via the `all-cases-passed` computed gate-task flag.

## Code references
- constant `ImplementationChecklist` in `wiki-models/src/feature/implementation-checklist.ts`

## Data model
`list` element `task` (prose `text`, FSM `todo --check--> done`, `done --uncheck--> todo`). Declares `computed: { "all-cases-passed": allTestingPlanCasesPassed }` (reads the sibling testing-plan) and `derived: { "plan-steps": planSteps }` (projects the plan's steps); gate-task checkboxes render from the computed flag.

## Usage
**Lifecycle:** `building → complete` (`finalize: "markComplete"`). One `tasks` `list` section. Representative commands: `addTask`, `addGateTask` (binds `meta.computed` to a named flag), `checkTask` / `uncheckTask` (task element-FSM), and lifecycle `markComplete`.

## Invariants & constraints
- The "Plan steps" view stores ZERO step state — it is a pure projection of `implementation-plan` step statuses, so it cannot drift and `markComplete` cannot freeze progress.
- A gate-task (element `meta.computed` set) has a COMPUTED checkbox the engine refuses to hand-toggle (so it cannot lie); the real gate stays on the brief, and `checklistComplete` counts only MANUAL tasks.
- `addGateTask`'s `computed` arg is a closed enum (`"all-cases-passed"`); `sectionSet` closed; the single `tasks` section is `required`.

## Synced commit
e357aa7
