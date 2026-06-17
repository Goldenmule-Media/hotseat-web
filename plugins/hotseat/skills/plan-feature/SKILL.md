---
name: plan-feature
description: Plan a feature in the wiki's feature-brief FSM — seed or select a brief, ground the plan in the real repo, author it (steps, data-models, test cases), review the plan for grounding/gaps/feasibility, then STOP. Writes no code; crosses no gate past beginPlanning, leaving a build-ready brief. Branch/worktree-agnostic; safe to run in parallel worktrees.
when_to_use: Invoke explicitly to plan (not build) a feature tracked in the structured wiki's `feature` bundle — produce a grounded, reviewed, build-ready brief and stop. Hand the brief to `/build-feature` to implement it.
argument-hint: '[feature-brief:id | "one-line intent"]  (workspace auto-resolved from hotseat.config.json; prefix a ws: token to override)'
arguments: [target]
disable-model-invocation: true
allowed-tools:
  - Workflow
  - ToolSearch
  - Read
  - Grep
  - Glob
  - mcp__wiki__nextActions
  - mcp__wiki__attention
  - mcp__wiki__getPage
  - mcp__wiki__tree
  - mcp__wiki__renderPage
  - mcp__wiki__describeMutations
  - mcp__wiki__describePageType
  - mcp__wiki__createPage
  - mcp__wiki__mutatePage
  - mcp__wiki__mutatePageBatch
  - mcp__wiki__search
  - mcp__wiki__listWorkspaces
---

# Plan a feature through the wiki

Produce one grounded, reviewed, build-ready feature plan — then stop. The wiki's `feature`
bundle is the source of truth for *what document edit comes next*; you supply what it cannot —
choosing what to plan, grounding it in the real repo, authoring the plan, and reviewing it for
soundness before handing it off. This skill is the **front half** of `/build-feature`: it writes
**no code**, runs **no tests**, and crosses **no FSM gate past `beginPlanning`**. When the plan is
authored and reviewed it stops, leaving the brief build-ready for `/build-feature feature-brief:<id>`.

## Inputs
- **Workspace** — a repo maps **1:1** to a wiki workspace, so you do not pass the id; resolve it **once** at the start and call the result `$WS`. Resolution precedence:
  1. If `$target` begins with a `ws:` token → that token is `$WS` (an explicit override); the remainder is the real target.
  2. Else `Read` **`hotseat.config.json`** at the worktree root and use its `workspaceId` as `$WS`.
  3. Else (file missing or no `workspaceId`) → call `listWorkspaces`, confirm `$WS` with the user, then offer to write `hotseat.config.json` so future runs need no lookup.

  Use `$WS` wherever a workspace id is needed for the rest of the run. Never silently guess a workspace.
- **Target** = `$target` (with any leading `ws:` override token stripped per above) — either an existing `feature-brief:<id>` to plan, or a one-line intent.
  - Starts with `feature-brief:` → plan that brief.
  - Otherwise → treat it as the feature intent and `createPage` a new `feature-brief` (title from the intent) **under the "Feature Specs" TOC** (Planning step 1) — never at the workspace root. That auto-materializes its pinned children: implementation-plan, implementation-checklist, testing-plan, feature-spec — never create the children by hand.
  - Empty → call `nextActions($WS)` to list in-progress feature work and confirm which brief to plan (or ask for an intent).

## Standing rules (apply for the whole task)
- **The wiki decides the next document edit — you don't.** After every write, read the echoed `next`; call `nextActions($WS, <briefId>)` for `do` / `blocked` / `humanGates` / `attention`. Drive `do` edges; for each `blocked` edge author exactly the content its `reason` names, then re-check. Never hardcode a command sequence — if a `reason` changes, follow the new one.
- **You plan; you do not build.** Drive the FSM up to **`beginPlanning`** and satisfy `beginImplementation`'s blockers, but **never call `beginImplementation`** (or anything past it). Crossing into `building` is `/build-feature`'s job. Likewise never call `submitForReview` or `ship`, and stop at any `attention` item.
- **Gates must reflect reality.** Author only content you actually grounded; `askQuestion`/`escalateQuestion` anything that genuinely needs a human decision rather than inventing an answer. Default to *not* advancing when unsure.
- **Branch/worktree-agnostic.** Operate in the current worktree on its current branch. Never `checkout`, assume a base branch, or require `main`.
- **Read-only on code and shared state.** You write **only to the wiki**. Do **not** create workspaces, configure emitters, write any source file, or stage/commit anything. The Markdown mirror is emitted to the main checkout automatically.
- **Workflow calls: load the schema first, pass real JSON.** Before the first `Workflow` call, load its schema with `ToolSearch("select:Workflow")` (fold it into the ToolSearch you make for the wiki tools) — without the schema in your prompt, object parameters are emitted as JSON-encoded strings and the script receives garbage. Pass `args` as a real JSON object, never a stringified one. Both templates fail fast with a named error if `args` doesn't arrive intact; on that error, re-run with the template body inlined via the `script` parameter and the values baked in. Don't poll a running workflow (no `Monitor`) — completion notifies you.

## Planning (draft → planning)
Ground the plan in the real repo first — the wiki's preconditions read only sibling pages, never the codebase, so an ungrounded plan invents plausible-but-wrong steps.

1. **New briefs live under the "Feature Specs" TOC.** When Target is an intent, first find the workspace's top-level `toc` page titled "Feature Specs" (`tree($WS)`); if it doesn't exist, `createPage({ type: "toc", title: "Feature Specs" })` to make it. Then `createPage` the feature-brief with `parentId` set to that TOC's id. The TOC's contents are derived from its live children — no TOC edit is needed.
2. Capture/confirm the brief id and child page ids with `tree($WS, <briefId>)`.
3. Run the **grounding** workflow (parallel repo reads):
   `Workflow({ scriptPath: "${CLAUDE_SKILL_DIR}/workflows/grounding.template.js", args: { repoRoot: "<this worktree path>", intent: "<intent or current brief summary>", areas: [<optional repo areas to focus>] } })`
   `args` must be a real JSON object (see the standing rule) — the template throws rather than running against placeholders if `intent` doesn't arrive. Adapt the script inline only if this feature needs a different fan-out. It returns a structured proposal (summary, components, constraints, plan steps, data-model snippets, test cases, open questions, conflicts) and does **not** touch the wiki.
4. Author the proposal with `mutatePageBatch` (atomic, ordered, ≤50 ops/page): `setSummary`/`addComponent`/`addConstraint` on the brief; `addStep`/`addDataModel` on the implementation-plan; `addCase` on the testing-plan. Anything that genuinely needs a human decision → `askQuestion` on the brief (`escalateQuestion` if it must block).
5. Follow `nextActions` to drive `beginPlanning`. Then satisfy `beginImplementation`'s `blocked` reasons (≥1 plan step, ≥1 data-model code block, ≥1 testing-plan case) so the brief is build-ready — but **do not cross that edge**. Stop if `attention` surfaces an escalated question.

## Review the plan (then stop)
There is no code yet, so this reviews the **authored plan** for soundness — the analogue of `/build-feature`'s pre-sign-off code review.

1. Read the authored plan back (`getPage` the implementation-plan and testing-plan) so you review what actually landed.
2. Run the **plan-review** workflow:
   `Workflow({ scriptPath: "${CLAUDE_SKILL_DIR}/workflows/plan-review.template.js", args: { repoRoot: "<this worktree path>", summary: "<brief summary>", steps: [<{stepId,text}>], dataModels: [<{language,source}>], cases: [<{caseId,text}>] } })`
   It fans out read-only agents over the real repo across review lenses (grounding/repo-faithfulness, completeness/gaps, feasibility/sequencing, test coverage) and returns structured findings, each tagged with a suggested action. It does **not** touch the wiki.
3. Apply the findings via the wiki: concrete gaps → `addStep` / `addCase` / `addComponent` / `addConstraint`; a decision a human must make → `askQuestion` on the brief (`escalateQuestion` if it must block); a wording/scope fix → edit the relevant section. Re-check `nextActions` so `beginImplementation`'s blockers stay satisfied after edits.
4. **Stop.** Report the brief id, the authored plan summary, the review findings and what you changed in response, and that the brief is build-ready: hand it off with `/build-feature feature-brief:<id>`. Stop early if `attention` surfaces an escalation.

## Finishing
`plan-feature` never crosses `beginImplementation`, `submitForReview`, or `ship`. When you stop, summarize the plan and any remaining open questions via `nextActions` and `attention` so the user knows it is ready to build (or what a human must decide first).
