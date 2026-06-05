# feature-brief

**Status:** current

## Kind
component

## Summary
The deliberation record and root-of-the-funnel for a feature: a typed brief holding the running summary, affected components, design constraints, open/resolved questions (the Q&A trail), and recorded commits.

## Purpose
The bundle's lifecycle driver and sign-off authority — the page an agent walks from idea to shipped, gating progress on the state of its pinned children (plan, checklist, testing-plan, spec).

## Components
_No components._

## Dependencies
- **owns** → [implementation-plan](architecture:mpzoj3ml-0059-wso9al) — Required, pinned child — reads its steps + data-models for the `beginImplementation` gate.
- **owns** → [implementation-checklist](architecture:mpzoj4pb-005b-ed8318) — Required, pinned child — its manual-task completion feeds the `checklistComplete` ship gate.
- **owns** → [testing-plan](architecture:mpzoj5y7-005d-t14bjq) — Required, pinned child — its case results feed the `allCasesPassed` ship gate.
- **owns** → [feature-spec](architecture:mpzoj2o9-0057-bj2han) — Required, pinned child — driven to `sealed` by the `ship` cascade-finalize.

## Code references
- constant `FeatureBrief` in `wiki-models/src/feature/feature-brief.ts`
- constant `featurePageTypes` in `wiki-models/src/feature/index.ts`

## Data model
One prose section plus four `list` sections over elements `component` (scalar `name`), `constraint` (prose `text`), `question` (prose `text` / `answer`, element-FSM `open --answer--> resolved`), and `commit` (scalar `sha` / `message` / `url`); the open/resolved split is render-time `groupBy: "status"`. No `derived` / `computed`.

## Usage
**Lifecycle:** `draft → planning → building → review → shipped` (with `building → planning` reopen, `review → building` request-changes, and `abandon` from any non-terminal state). Sections: `summary` (prose) + `components` / `constraints` / `questions` / `commits` (lists). Representative commands: `setSummary`, `addConstraint`, `askQuestion` / `answerQuestion`, `recordCommit`, and the lifecycle `beginImplementation` / `ship`.

## Invariants & constraints
- `beginImplementation` is gated by preconditions `planHasStep` (≥1 plan step), `planHasDataModel` (≥1 plan data-model code block), and `testPlanHasCase` (≥1 testing-plan case) — all reading siblings via `related`.
- `ship` is gated by `checklistComplete` (≥1 MANUAL task, all done — computed gate-tasks excluded), `allCasesPassed` (≥1 case, all passed), and `noOpenQuestions` (zero non-resolved questions).
- `ship` carries `cascadeFinalize: true`: one atomic commit drives every pinned child to its terminal status (plan→ready, checklist→complete, testing-plan→ready, spec→sealed); a child that can't finalize rejects the whole ship. All five sections `required`, `sectionSet` closed; `requiredChildren` pins the four child types.

## Synced commit
e357aa7
