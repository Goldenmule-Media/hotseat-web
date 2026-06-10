# testing-plan

**Status:** current

## Kind
component

## Summary
The test cases and results for a feature: a list of cases, each carrying a pass/fail result state.

## Purpose
Records the verification surface and supplies the brief's `allCasesPassed` ship gate.

## Design notes
_No design notes._

## Components
_No components._

## Dependencies
_No dependencies._

## Code references
- constant `TestingPlan` in `wiki-models/src/feature/testing-plan.ts`

## Data model
`list` element `case` (prose `text`, FSM `planned --pass--> passed`, `planned --fail--> failed`, `failed --pass--> passed`). No `derived` / `computed`; cases render split by status (Planned / Passed / Failed).

## Usage
**Lifecycle:** `draft → ready` (`finalize: "markReady"`). One `cases` `list` section. Representative commands: `addCase`, `markCasePassed` / `markCaseFailed` (case element-FSM, no content op), and lifecycle `markReady`.

## Invariants & constraints
- `cases` is `mutableIn: ["draft"]` (the case SET freezes once ready), but `markCasePassed` / `markCaseFailed` are element-FSM transitions with no content op, so result-recording stays legal in `ready` and keeps the brief's `allCasesPassed` gate reachable.
- `sectionSet` closed; the single `cases` section is `required`; `markReady` has no preconditions (unlike the plan).
- Case statuses are read by the brief's `allCasesPassed` / `testPlanHasCase` gates, making the testing-plan a shared fact source.

## Synced commit
e357aa7
