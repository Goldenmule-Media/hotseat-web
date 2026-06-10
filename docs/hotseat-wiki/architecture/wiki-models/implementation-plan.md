# implementation-plan

**Status:** current

## Kind
component

## Summary
The ordered plan of attack for a feature — a reorderable list of steps (each with its own done-state), a "Data models & interfaces" document, and a questions list.

## Purpose
The canonical work breakdown for a feature; its steps are individually checked off as the work ships. Feeds the brief's `beginImplementation` precondition and its `ship` gate (all steps done).

## Design notes
_No design notes._

## Components
_No components._

## Dependencies
_No dependencies._

## Code references
- constant `ImplementationPlan` in `wiki-models/src/feature/implementation-plan.ts`

## Data model
`list` element `step` (prose `text`, FSM `todo --markDone--> done`, `done --reopen--> todo`) and the reused `question` element (`open --answer--> resolved`); a `blocks` field (`dataModels.models`) for data-model / interface code. No `derived` / `computed`; questions render split by status.

## Usage
**Lifecycle:** `draft → ready` (`finalize: "markReady"`). Sections: `steps` (ordered list), `dataModels` (blocks), `questions` (list). Representative commands: `addStep` / `removeStep` / `reorderSteps`, `markStepDone` / `markStepTodo` (per-step element-FSM, no content op), `addDataModel`, and lifecycle `markReady`.

## Invariants & constraints
- `markReady` is gated by `planHasDataModel` (≥1 `code` block in the `dataModels` section).
- `steps` is `mutableIn: ["draft"]` (the step SET freezes once ready), but `markStepDone` / `markStepTodo` are element-FSM transitions carrying no content op, so step progress stays legal in `ready` as work ships.
- `sectionSet` closed; all three sections `required`.

## Synced commit
e357aa7
