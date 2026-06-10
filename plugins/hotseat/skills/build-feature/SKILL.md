---
name: build-feature
description: Drive a feature through the wiki's feature-brief FSM end-to-end — seed or select a brief, ground the plan in the real repo, write code, verify with real tests + code review, and flip FSM gates only from verified results. Stops at human sign-off gates. Branch/worktree-agnostic; safe to run in parallel worktrees.
when_to_use: Invoke explicitly (in a worktree on a feature branch) to build a feature tracked in the structured wiki's `feature` bundle.
argument-hint: <workspaceId> <feature-brief:id | "one-line intent">
arguments: [workspace, target]
disable-model-invocation: true
allowed-tools:
  - Workflow
  - ToolSearch
  - Read
  - Grep
  - Glob
  - Skill(code-review *)
  - Bash(npm run typecheck*)
  - Bash(npm run test*)
  - Bash(npm test*)
  - Bash(git status*)
  - Bash(git diff*)
  - Bash(git log*)
  - Bash(git rev-parse*)
  - Bash(git add*)
  - Bash(git commit*)
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

# Build a feature through the wiki

Drive one feature from intent to a human sign-off gate. The wiki's `feature` bundle is the source of truth for *what document edit comes next*; you supply the engineering and verification the wiki cannot — choosing what to build, grounding it in the real repo, writing code, and confirming it actually works before flipping any gate.

## Inputs
- **Workspace** = `$workspace` — the wiki workspace to operate in (all content tools require it). If empty or not an obvious id, call `listWorkspaces` and confirm the target with the user before proceeding.
- **Target** = `$target` — either an existing `feature-brief:<id>` to drive, or a one-line intent.
  - Starts with `feature-brief:` → drive that brief.
  - Otherwise → treat it as the feature intent and `createPage` a new `feature-brief` (title from the intent) **under the "Feature Specs" TOC** (Planning step 1) — never at the workspace root. That auto-materializes its pinned children: implementation-plan, implementation-checklist, testing-plan, feature-spec — never create the children by hand.
  - Empty → call `nextActions($workspace)` to list in-progress feature work and confirm which brief to drive (or ask for an intent).

## Standing rules (apply for the whole task)
- **The wiki decides the next document edit — you don't.** After every write, read the echoed `next`; call `nextActions($workspace, <briefId>)` for `do` / `blocked` / `humanGates` / `attention`. Drive `do` edges; for each `blocked` edge author exactly the content its `reason` names, then re-check. Never hardcode a command sequence — if a `reason` changes, follow the new one.
- **Stop at human gates.** `humanGates` (`submitForReview`, `ship`) and `attention` items are not yours to cross. Drive up to them, then stop and hand back with a summary. Never call `submitForReview` or `ship`.
- **Gates must reflect reality.** `markStepDone` only after the step's code landed; `markCasePassed` only when a test genuinely passed (see Implementation); `checkTask` only when the work is truly done. Default to *not* advancing when unsure.
- **Branch/worktree-agnostic.** Operate in the current worktree on its current branch. Never `checkout`, assume a base branch, or require `main`.
- **Do NOT** create workspaces, configure emitters, or stage/commit `docs/hotseat-wiki/**`. The Markdown mirror is emitted to the main checkout automatically and reconciled at merge time. You commit *code only*, on the current feature branch (stage specific code paths, never `git add -A`).
- **Workflow calls: load the schema first, pass real JSON.** Before the first `Workflow` call, load its schema with `ToolSearch("select:Workflow")` (fold it into the ToolSearch you make for the wiki tools) — without the schema in your prompt, object parameters are emitted as JSON-encoded strings and the script receives garbage. Pass `args` as a real JSON object, never a stringified one. Both templates fail fast with a named error if `args` doesn't arrive intact; on that error, re-run with the template body inlined via the `script` parameter and the values baked in. Don't poll a running workflow (no `Monitor`) — completion notifies you.

## Planning (draft → planning → building)
Ground the plan in the real repo first — the wiki's preconditions read only sibling pages, never the codebase, so an ungrounded plan invents plausible-but-wrong steps.

1. **New briefs live under the "Feature Specs" TOC.** When Target is an intent, first find the workspace's top-level `toc` page titled "Feature Specs" (`tree($workspace)`); if it doesn't exist, `createPage({ type: "toc", title: "Feature Specs" })` to make it. Then `createPage` the feature-brief with `parentId` set to that TOC's id. The TOC's contents are derived from its live children — no TOC edit is needed.
2. Capture/confirm the brief id and child page ids with `tree($workspace, <briefId>)`.
3. Run the **grounding** workflow (parallel repo reads):
   `Workflow({ scriptPath: "${CLAUDE_SKILL_DIR}/workflows/grounding.template.js", args: { repoRoot: "<this worktree path>", intent: "<intent or current brief summary>", areas: [<optional repo areas to focus>] } })`
   `args` must be a real JSON object (see the standing rule) — the template throws rather than running against placeholders if `intent` doesn't arrive. Adapt the script inline only if this feature needs a different fan-out. It returns a structured proposal (summary, components, constraints, plan steps, data-model snippets, test cases, open questions, conflicts) and does **not** touch the wiki.
4. Author the proposal with `mutatePageBatch` (atomic, ordered, ≤50 ops/page): `setSummary`/`addComponent`/`addConstraint` on the brief; `addStep`/`addDataModel` on the implementation-plan; `addCase` on the testing-plan. Anything that genuinely needs a human decision → `askQuestion` on the brief (`escalateQuestion` if it must block).
5. Follow `nextActions` to drive `beginPlanning`, then `beginImplementation` once its `blocked` reasons are satisfied (≥1 plan step, ≥1 data-model code block, ≥1 testing-plan case). Stop if `attention` surfaces an escalated question.

## Implementation (building → review)
Do the real work, verify it for real, then flip the gates the wiki trusts you to flip.

1. Read the grounded plan (`getPage` the implementation-plan).
2. Write the code for each step in this worktree.
3. Run the **verification** workflow:
   `Workflow({ scriptPath: "${CLAUDE_SKILL_DIR}/workflows/verification.template.js", args: { repoRoot: "<this worktree path>", steps: [<{stepId,text}>], cases: [<{caseId,text}>] } })`
   It runs `npm run typecheck` + `npm run test`, exercises each testing-plan case, and spot-checks each plan step as actually landed, all in parallel, returning real pass/fail (`args.cases` is required — same JSON-object rule as grounding). It does **not** touch the wiki.
4. Flip gates **from those results only**: `markStepDone` only for steps the verification reported `landed`; `markCasePassed`/`markCaseFailed` per the real case result; `checkTask` for completed manual tasks (gate-tasks are computed — leave them). Fix and re-verify failures rather than flipping them green.
5. Stage the code paths you changed, commit on the current branch, and `recordCommit({ sha, message })` with the real sha.
6. **Code review before sign-off:** run `/code-review high` (Skill tool) on the branch diff. Apply safe fixes (or `/code-review high --fix`). Turn any finding needing a human decision into an `askQuestion` on the brief, and any concrete remediation into an `addStep` on the plan, then re-verify. For a deeper pass, tell the user they can run `/code-review ultra` themselves — it is cloud, billed, user-triggered; never auto-launch it.
7. Drive up to `submitForReview`, then **stop**: report what was built, the verification results, the review outcome, and that it is ready for the user to review and `submitForReview`.

## Finishing
`submitForReview` and `ship` are human gates — never cross them. When you stop, summarize remaining work via `nextActions` and `attention` so the user knows exactly what's left.
