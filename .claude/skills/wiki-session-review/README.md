# `/wiki-session-review` — turn a session's wiki usage into model-optimization feedback

A Claude Code **project skill** that reads ONE past session's use of the structured wiki's MCP API, finds
where the agent took wrong turns or fought the model, and produces **verified, grounded recommendations
for optimizing the wiki model** — or concludes that no changes are warranted. It is read-only harness
tooling: it *recommends*, it never edits the model.

```
/wiki-session-review <sessionId> [project-substring]
/wiki-session-review                                  # lists recent wiki-using sessions to pick from
```

## Why it exists

The wiki is **LLM-first and self-directing**: it is supposed to tell an agent what to do next and reject
anything illegal with a legible reason. So when an agent stumbles — re-probes the type five times, hits a
rule only via an error, aborts a whole batch on one bad command, creates pages the model auto-materializes
— that stumble is *evidence the model could be clearer*. This skill closes the loop: real agent behavior →
concrete model improvements. It treats the transcript as a usability study of the wiki API.

The hard part is discipline: most friction in a transcript is **agent error**, not a model gap. The skill's
whole value is the filter — every candidate finding is adversarially checked for *model-fixability* (would
a change to the model actually have prevented it?) and *novelty* (does the fix already exist, or break a
deliberate design choice?) before it can become a recommendation.

## Shape: a spine + a deterministic extractor + a fan-out workflow

```
SKILL.md                            ← spine, runs in the main loop: extract → workflow → present
  ├─ scripts/extract-wiki-trace.mjs       deterministic JSONL → compact wiki trace (no agent tokens)
  └─ workflows/review.template.js         analyze (6 dimensions) → verify (adversarial) → recommend
```

### `scripts/extract-wiki-trace.mjs`
Dependency-free Node. Walks the session JSONL once and emits a compact JSON trace: summary `stats`, the
human `userPrompts` (slash-command chrome stripped), and a `timeline` of every `mcp__wiki__*` call in
order — each with the model's stated `intent`/`reasoning`, its (truncated) `input`, its `result`
(`isError` + truncated text), and the non-wiki tools used between calls. Long authored prose is clipped so
the *structure* of each call survives without the bulk. Resolves a session id across all
`~/.claude/projects/*` dirs; `--list` shows recent wiki-using sessions; `--project <substr>` disambiguates.

### `workflows/review.template.js`
- **Analyze** — six finders run in parallel, one per friction dimension (FSM gates · command args &
  content rules · self-direction · read/discovery churn · mutation ergonomics · lifecycle/admin). Each
  slices the trace with `jq` and reads the **actual model source** (`wiki-models/src/**`,
  `wiki-mcp/src/mcp/**`, the content-model) to ground its claims, and labels every finding
  model-fixable vs. agent-error.
- **Verify** — pipelined per dimension (a dimension's findings verify the moment it completes). Each
  finding gets an adversarial skeptic that must confirm, against the source, all four of: *isReal*,
  *isModelFixable*, *notAlreadySolved*, *fixSound*. Default is **drop**.
- **Recommend** — one synthesis pass dedups the survivors, prioritizes by impact, and writes a
  ready-to-show Markdown report grouped by target (wiki-models / wiki-mcp / tool-description /
  self-direction / content-model), explicitly noting the dimensions where the agent used the wiki well.

## Design rules (enforced by the skill + workflow)

- **Recommend, don't apply.** No edits to `wiki-models`/`wiki-mcp`/`wiki`. Implementing a recommendation is
  a separate explicit step.
- **Model-fixable only.** Friction that is irreducible agent error or specific to one user's task is
  reported as *not actionable*, never as a recommendation.
- **Respect the boundaries.** No recommendation may hardcode a page-type concept into the schema-agnostic
  engine/host, break determinism, or violate the LLM-first no-free-text rule. The verify stage refutes any
  that do.
- **"No changes warranted" is a valid result.**

## Grounding

Recommendations are grounded against the **source** in this repo (always present), not a live server:
page types in `wiki-models/src/{feature/*,architecture,adr,toc}.ts`, the MCP tool surface in
`wiki-mcp/src/mcp/{tools,server,resources}.ts` + `tokens.ts`, self-direction (`nextActions`/`next`) in
`wiki-mcp/src`, and the content-model rules in `docs/wiki/architecture/content-model.md`.

## Status

The extractor is exercised against a real 325-record session (resolves the id, emits a ~130 KB trace,
captures the error messages verbatim). The workflow template is syntax-validated. Tune the dimension and
verifier prompts after the first few live reviews — the friction taxonomy will sharpen with use.

> **Note:** adding this `.claude/skills/` directory mid-session may require restarting Claude Code before
> `/wiki-session-review` appears, and accepting the workspace-trust dialog (which activates the skill's
> `allowed-tools` pre-approvals).
