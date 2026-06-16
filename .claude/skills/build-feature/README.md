# `/build-feature` — agentic, FSM-gated feature builds

A Claude Code **project skill** that drives a feature from intent to a human sign-off gate using
the wiki's `feature` bundle as the source of truth for *what comes next*. It is harness tooling that
*orchestrates* the system — not part of the engine. Invoke it explicitly:

```
/build-feature "<one-line intent>"
/build-feature feature-brief:<id>            # drive an existing brief
/build-feature ws:<id> "<one-line intent>"   # explicit workspace override (prefix a ws: token)
```

**Workspace resolution.** A repo maps **1:1** to a wiki workspace, so you don't pass the id. The skill
resolves it once, in precedence order: (1) a leading `ws:` token in the argument overrides; (2) otherwise
the `workspaceId` in **`hotseat.config.json`** at the repo root; (3) otherwise it calls `listWorkspaces`,
confirms with you, and offers to write the config. `hotseat.config.json` is committed, so it travels with
every clone and parallel worktree:

```json
{ "workspaceId": "ws:mpzncs2z-0001-2wgv51" }
```

## Why it exists

The wiki is already **self-directing** for in-document work: the `feature-brief` FSM plus the
model-declared `agency`/`awaitsHuman` classifiers and the `nextActions`/`next`-echo roll-up walk an
agent edge-by-edge (draft → planning → building → review → shipped), with each `blocked` reason naming
exactly what to author next. Re-encoding that sequence in a script would duplicate the engine and drift
from it — so this skill **doesn't**. It adds value only in the gaps the wiki deliberately leaves open:

- **Choosing / seeding** what to build (the FSM only drives an existing brief).
- **Grounding** the plan in the real repo (the wiki's preconditions read only sibling pages, never code).
- **Real code + verification** (the wiki authors nothing and runs nothing — `recordCommit` takes a sha on
  faith and trusts whoever flips a case to `passed`).

## Shape: a spine + two fan-out workflows

```
SKILL.md                        ← the spine, runs in the main loop
  ├─ drives the FSM via nextActions; stops at submitForReview / ship / attention
  ├─ workflows/grounding.template.js      (planning)  → parallel repo read → plan proposal
  ├─ workflows/verification.template.js   (building)  → typecheck/test + per-case exercise → real pass/fail
  └─ /code-review high                    (building)  → reviews the branch diff before sign-off
```

The **skill** owns every wiki mutation and gate-flip, because that's where the stop-at-human-gate logic
lives. The **workflows** are parallel muscle only: they read/compute and return structured data, and
**never touch the wiki**. `/code-review` runs inline in the main loop (a workflow can't invoke it).

### The workflows

Both are parameterized by `args`, so the common case runs them as-is via `Workflow({ scriptPath, args })`
— no per-feature editing; adapt inline only when a feature needs a different fan-out. `args` must be a
real JSON object: a caller without the Workflow schema loaded emits it as a JSON-encoded string (the
skill body says to `ToolSearch("select:Workflow")` first), so both templates coerce a stringified `args`
and **fail fast** — naming the missing field — rather than degrade to a placeholder run.

- **`grounding.template.js`** — fans out read-only `Explore` agents over repo areas, then synthesizes one
  repo-faithful proposal: summary, components, constraints, ordered plan steps, ≥1 data-model code block,
  testing-plan cases, open questions, conflicts. The skill authors this via `mutatePageBatch`, driven by
  `nextActions`.
- **`verification.template.js`** — runs `npm run typecheck` + `npm run test`, exercises each
  testing-plan case, and spot-checks each plan step as actually landed (file:line evidence), all in
  parallel, returning real pass/fail. Agents default to `false` when they can't confirm. The skill flips
  `markCasePassed`/`markStepDone` **only** from these results.

## Design rules (enforced by the skill body)

- **The wiki decides the next document edit.** Drive `do` edges and satisfy `blocked` reasons verbatim
  from `nextActions`; never hardcode a command sequence.
- **Gates reflect reality.** `markStepDone`/`markCasePassed`/`checkTask` flip only from verified results;
  default to *not* advancing when unsure. Never cross `submitForReview` or `ship` — those are human gates.
- **Branch/worktree-agnostic.** Operate in the current worktree on its current branch; never `checkout`,
  assume a base branch, or require `main`.
- **Stays out of shared state.** Does **not** create workspaces, configure emitters, or stage/commit
  `docs/hotseat-wiki/**`. Commits *code only*, on the current feature branch.

## `/code-review`

The skill runs **`/code-review high`** on the branch diff before `submitForReview`; safe fixes can be
applied (`--fix`), findings that need a human call become an `askQuestion` on the brief, and concrete
remediations become an `addStep` on the plan. The cloud **`ultra`** variant is user-triggered and billed —
the skill *suggests* you run it but never launches it.

## Parallel worktrees

Designed to run as N independent Claude sessions, one per git worktree (e.g. under `.worktree/`), built in
parallel. Worktrees isolate the **code**; the **wiki is shared** (one `wiki-server`, one MCP endpoint), so:

- No per-feature workspace — concurrent commits ride the engine's OCC (`Stream-Seq` 409 → rebase-retry).
- A single Markdown emitter points at the **primary `main` checkout**, so `docs/hotseat-wiki/` is mirrored on
  `main` live regardless of which worktree drove the change (one writer, no race). Worktree branches carry
  code only.
- At merge time the feature branch merges its code into `main`; the markdown is already on `main` (emitted
  live) and is committed **separately**, or stashed and applied on top of the merge.

## Status

Exercised end-to-end on real features. The first live runs surfaced one wiring failure: with the
Workflow tool's schema not loaded in the session, the `args` object was emitted as a JSON-encoded
string, and the templates' placeholder defaults silently turned that into a useless "grounded on 'the
feature'" run. Fixed on both ends — the skill body loads the schema before the first call, and the
templates coerce stringified `args` and throw on missing required input instead of falling back.

> **Note:** creating this `.claude/skills/` directory mid-session requires restarting Claude Code before
> `/build-feature` appears, and accepting the workspace-trust dialog (which activates the skill's
> `allowed-tools` pre-approvals).
