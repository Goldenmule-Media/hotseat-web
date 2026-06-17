# `/plan-feature` — grounded, reviewed feature plans (no code)

A Claude Code **project skill** that drives a feature from intent to a **build-ready, reviewed
plan** using the wiki's `feature` bundle as the source of truth for *what comes next* — and then
**stops**. It is the **front half** of [`/build-feature`](../build-feature/README.md): same
workspace resolution, same grounding, same FSM-driven authoring, but it writes **no code**, runs
**no tests**, and crosses **no FSM gate past `beginPlanning`**. Invoke it explicitly:

```
/plan-feature "<one-line intent>"
/plan-feature feature-brief:<id>            # plan an existing brief
/plan-feature ws:<id> "<one-line intent>"   # explicit workspace override (prefix a ws: token)
```

When it finishes, the brief sits in the `planning` state with `beginImplementation`'s blockers
satisfied (≥1 plan step, ≥1 data-model block, ≥1 testing-plan case) — hand it to
`/build-feature feature-brief:<id>` to implement.

**Workspace resolution.** Identical to `/build-feature`: a leading `ws:` token overrides; else the
`workspaceId` in **`hotseat.config.json`** at the repo root; else `listWorkspaces` + a prompt (and
an offer to write the config). `hotseat.config.json` is committed, so it travels with every clone
and parallel worktree.

## Why it exists

Sometimes you want the plan reviewed and approved *before* any code is written — a planning pass
you can read, correct, and sign off on, separately from the build. `/build-feature` does planning
and building in one run; `/plan-feature` splits the planning off so it can stand alone. The two
compose: plan now, build later (or never, if the review says the idea needs rework).

It adds value in the same gaps the wiki leaves open — **choosing/seeding** what to plan,
**grounding** the plan in the real repo (the wiki's preconditions read only sibling pages, never
code), and now **reviewing** that plan for soundness before handoff.

## Shape: a spine + two fan-out workflows

```
SKILL.md                          ← the spine, runs in the main loop
  ├─ drives the FSM via nextActions to beginPlanning; never crosses beginImplementation
  ├─ workflows/grounding.template.js     (planning) → parallel repo read → plan proposal
  └─ workflows/plan-review.template.js   (review)   → parallel lens review → actionable findings
```

The **skill** owns every wiki mutation, because that's where the stop-before-build logic lives.
The **workflows** are parallel muscle only: they read/compute and return structured data, and
**never touch the wiki**.

### The workflows

Both are parameterized by `args`, run as-is via `Workflow({ scriptPath, args })`, and coerce a
stringified `args` then **fail fast** (naming the missing field) — the skill body loads the
Workflow schema with `ToolSearch("select:Workflow")` first so `args` arrives as a real object.

- **`grounding.template.js`** — copied verbatim from `/build-feature`. Fans out read-only `Explore`
  agents over repo areas, then synthesizes one repo-faithful proposal: summary, components,
  constraints, ordered plan steps, ≥1 data-model code block, testing-plan cases, open questions,
  conflicts. The skill authors this via `mutatePageBatch`, driven by `nextActions`.
- **`plan-review.template.js`** — reviews the **already-authored plan** (there is no code yet, so
  `/code-review` does not apply). Fans out one read-only reviewer per lens — grounding/repo-
  faithfulness, completeness/gaps, feasibility/sequencing, test coverage — and synthesizes one
  de-duplicated, severity-ordered finding list, each tagged `addStep` / `addCase` / `addConstraint`
  / `askQuestion` / `edit`. The skill applies them mechanically.

## Design rules (enforced by the skill body)

- **The wiki decides the next document edit.** Drive `do` edges and satisfy `blocked` reasons
  verbatim from `nextActions`; never hardcode a command sequence.
- **Plan, don't build.** Drive up to `beginPlanning` and satisfy `beginImplementation`'s blockers,
  but **never cross** `beginImplementation` (or `submitForReview` / `ship`); stop at any `attention`
  item. Crossing into `building` is `/build-feature`'s job.
- **Read-only on code and shared state.** Writes only to the wiki — no source files, no commits, no
  workspace creation, no `docs/hotseat-wiki/**`.
- **Branch/worktree-agnostic.** Operate in the current worktree on its current branch; never
  `checkout`, assume a base branch, or require `main`.

## Source of truth

The canonical copy of this skill lives in the `hotseat` plugin
(`plugins/hotseat/skills/plan-feature/`). `hotseat-web`'s own `.claude/skills/plan-feature/` is the
same skill loaded as a project skill for work inside this repo — keep the two in sync when editing.

> **Note:** creating this `.claude/skills/` directory mid-session requires restarting Claude Code
> before `/plan-feature` appears, and accepting the workspace-trust dialog (which activates the
> skill's `allowed-tools` pre-approvals).
