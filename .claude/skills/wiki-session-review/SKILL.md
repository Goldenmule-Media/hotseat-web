---
name: wiki-session-review
description: Analyze how a past Claude session used the wiki MCP API, find where it took wrong turns or fought the model, and produce verified, grounded recommendations for optimizing the wiki model (page types · FSM · command/content rules · tool surface · self-direction) — or conclude no changes are warranted. Read-only; recommends, never applies.
when_to_use: Invoke explicitly to turn one session's real wiki usage into model-optimization feedback — e.g. "review wiki usage in session <id>". Point it at a session that consumed the wiki and seemed to stumble.
argument-hint: <sessionId> [project-substring]
arguments: [session, project]
disable-model-invocation: true
allowed-tools:
  - Workflow
  - Read
  - Grep
  - Glob
  - Bash(node *)
  - Bash(jq *)
---

# Review a session's wiki usage → recommend model optimizations

Take ONE Claude session that consumed the structured wiki's MCP API, find where the agent took wrong
turns or fought the model, and produce **verified, grounded recommendations for optimizing the wiki
model** — the page types (FSM, sections, commands, content rules), the MCP tool surface and its
descriptions, and the self-direction (`next` / `nextActions`) guidance. A valid outcome is **"no changes
warranted."** This skill is read-only: it recommends, it never edits the model.

The premise: the wiki is **LLM-first and self-directing**. So when an agent stumbles using it, that is
usually a signal the *model* could be clearer — a missing affordance, a rule discoverable only via an
error, an FSM edge that wasn't legible, guidance the agent didn't see. This skill mines that signal.

## Inputs
- **Session** = `$session` — a session id (e.g. `77bc57b4-…`) or an absolute path to a transcript
  `.jsonl`. Sessions live under `~/.claude/projects/<munged-project>/<id>.jsonl` and may belong to **any**
  project — the model under review lives in *this* repo regardless.
- **Project** = `$project` (optional) — a substring to disambiguate which project dir the session is in.
- If `$session` is empty, run the extractor in `--list` mode and confirm the target with the user:
  `node ${CLAUDE_SKILL_DIR}/scripts/extract-wiki-trace.mjs --list`

## Step 1 — Extract a compact wiki trace (deterministic; cheap)
Do NOT read the raw transcript yourself (it is large and mostly noise). Run the extractor — it walks the
JSONL once and emits a compact JSON trace of every `mcp__wiki__*` call in order, each paired with the
model's stated intent, its (truncated) args, and its (truncated) result incl. the error flag, plus
summary stats:

```
node ${CLAUDE_SKILL_DIR}/scripts/extract-wiki-trace.mjs <$session> [--project <$project>]
```

It prints a summary and a line beginning `trace: <path>`. **Capture that path.** Read the summary aloud
to the user (wiki call count, error count, top tools, errors by tool) so they see the shape before the
deeper pass. If the extractor reports no/low wiki usage, say so and stop — there is nothing to review.

## Step 2 — Run the review workflow (analyze → verify → recommend)
Hand the trace path and this repo root to the workflow. It fans out finders across friction dimensions
(FSM gates · command args & content rules · self-direction · read/discovery churn · mutation ergonomics ·
lifecycle/admin), **adversarially verifies** each finding against the actual model source (is it real? is
it model-fixable vs. agent error? is it already solved? is the fix sound?), then synthesizes prioritized
recommendations:

```
Workflow({
  scriptPath: "${CLAUDE_SKILL_DIR}/workflows/review.template.js",
  args: { tracePath: "<the trace: path>", repoRoot: "<this repo root>", sessionId: "<$session>" }
})
```

Adapt the script inline only if a particular session needs a different fan-out. The workflow is read-only
and never touches the wiki or the model source — it reads and reasons.

## Step 3 — Present the recommendations
The workflow returns `{ recommendations: { verdict, summary, sessionContext, recommendations[],
dimensionsClean[], markdownReport, … } }`. **Present `markdownReport` to the user verbatim** (it is
written to be shown), then add a one-line steer of your own: which one or two recommendations you'd act on
first, and why.

## Standing rules
- **Recommend, don't apply.** This skill never edits `wiki-models` / `wiki-mcp` / `wiki`. If the user
  wants a change implemented, that is a separate, explicit follow-up (e.g. `/build-feature`).
- **Model-fixable only.** A recommendation must be something a change to the model, the tool surface, the
  tool descriptions, the self-direction text, or a content-model rule would actually prevent. Irreducible
  agent error and user-task-specific friction are reported as *not actionable*, not as recommendations.
- **Respect the boundaries.** Never recommend hardcoding a page-type concept into the schema-agnostic
  engine/host (`wiki`/`wiki-mcp`) — push it into `wiki-models` or into model-declared metadata the host
  reads generically. Never recommend anything that breaks determinism (no `Date.now()`/`Math.random()`/
  `new Date()` in `apply`/`produces`/`render`) or the LLM-first "no free text" rule. The workflow's verify
  stage enforces this, but hold the line when you present.
- **"No changes" is a real answer.** If the agent used the wiki well, say so plainly and stop.
