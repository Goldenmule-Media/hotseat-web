/**
 * Plan-review workflow — TEMPLATE for the `plan-feature` skill.
 *
 * Run as-is via Workflow({ scriptPath, args }) for the common case; adapt the lenses inline
 * as needed. Reviews the ALREADY-AUTHORED plan (there is no code yet, so /code-review does
 * not apply) by fanning out read-only agents over the real repo, one per review lens, and
 * returns structured findings. It does NOT touch the wiki — the skill (main loop) applies
 * each finding via MCP (addStep / addCase / addConstraint / askQuestion / edit).
 *
 * args: {
 *   repoRoot?: string,                              // worktree root; default "."
 *   summary?: string,                               // the brief summary, for context
 *   steps: [{ stepId: string, text: string }],      // REQUIRED, non-empty — authored plan steps
 *   dataModels?: [{ language: string, source: string }], // authored data-model blocks
 *   cases?: [{ caseId: string, text: string }],     // authored testing-plan cases
 * }
 *
 * A caller without the Workflow schema in its prompt emits `args` as a JSON-encoded STRING —
 * coerced below. Missing/empty `steps` throws immediately: reviewing an empty plan would
 * return plausible-but-vacuous findings the skill then acts on, so fail fast instead.
 */
export const meta = {
  name: 'plan-feature-review',
  description: 'Review an authored feature plan against the real repo across lenses; return actionable findings',
  phases: [
    { title: 'Review', detail: 'one reviewer per lens checks the plan against real code' },
    { title: 'Synthesize', detail: 'consolidate + de-duplicate into one ordered finding list' },
  ],
}

let input = args
if (typeof input === 'string') {
  try { input = JSON.parse(input) } catch { input = null }
}
if (!input || !Array.isArray(input.steps) || input.steps.length === 0) {
  throw new Error(
    'plan-review.template.js requires args.steps (non-empty array of { stepId, text }) — ' +
    'pass args as a real JSON object, not a JSON-encoded string (got ' + typeof args + '). ' +
    'If args cannot reach the script intact, re-run with the template body inlined via the ' +
    '`script` parameter and the values baked in.',
  )
}
const repoRoot = input.repoRoot || '.'
const summary = typeof input.summary === 'string' ? input.summary : ''
const steps = input.steps
const dataModels = Array.isArray(input.dataModels) ? input.dataModels : []
const cases = Array.isArray(input.cases) ? input.cases : []

const LENSES = [
  {
    key: 'grounding',
    focus: 'Grounding / repo-faithfulness — do the steps and data-models match what the repo ACTUALLY contains, or do they invent plausible-but-wrong modules, APIs, or shapes? Read the real code to check.',
  },
  {
    key: 'completeness',
    focus: 'Completeness / gaps — what is MISSING: an unlisted step the change clearly needs, a data-model the steps reference but never define, behavior with no plan step.',
  },
  {
    key: 'feasibility',
    focus: 'Feasibility / sequencing — ordering hazards (a step depending on a later one), hidden dependencies, and conflicts/collisions with existing code that the plan ignores.',
  },
  {
    key: 'coverage',
    focus: 'Test coverage — do the testing-plan cases actually exercise the plan steps? Name steps with no covering case, and cases that test nothing the plan does.',
  },
]

const FINDING = {
  type: 'object',
  additionalProperties: false,
  properties: {
    issue: { type: 'string', description: 'the concrete problem, grounded in file:line where relevant' },
    suggestedAction: {
      type: 'string',
      enum: ['addStep', 'addCase', 'addConstraint', 'askQuestion', 'edit'],
      description: 'how the skill should apply this via the wiki',
    },
    detail: { type: 'string', description: 'the exact step/case/constraint text to author, or the question to ask' },
    severity: { type: 'string', enum: ['blocking', 'should-fix', 'nit'] },
  },
  required: ['issue', 'suggestedAction', 'detail', 'severity'],
}

const LENS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    lens: { type: 'string' },
    findings: { type: 'array', items: FINDING },
  },
  required: ['lens', 'findings'],
}

const SYNTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['build-ready', 'needs-changes', 'needs-human-decision'] },
    findings: { type: 'array', items: FINDING },
    notes: { type: 'string', description: 'one-paragraph overall read on the plan' },
  },
  required: ['verdict', 'findings'],
}

const planJson = JSON.stringify({ summary, steps, dataModels, cases }, null, 2)

phase('Review')
const reviews = await parallel(
  LENSES.map((lens) => () =>
    agent(
      `Review an authored feature plan against the REAL repository at ${repoRoot}.
Review lens — ${lens.focus}

The authored plan (JSON): ${planJson}

Read the actual code (Glob/Grep/Read) to check the plan against reality through THIS lens only. Report concrete findings; for each, suggest how to fix it (addStep / addCase / addConstraint with the exact text to author, askQuestion with the exact question for a human decision, or edit), and a severity. If the plan is sound under this lens, return an empty findings array — do not invent problems.`,
      { label: `review:${lens.key}`, phase: 'Review', agentType: 'Explore', schema: LENS_SCHEMA },
    ),
  ),
)

phase('Synthesize')
const synthesis = await agent(
  `Consolidate these per-lens plan reviews into ONE actionable, de-duplicated finding list.
The authored plan (JSON): ${planJson}
Per-lens reviews (JSON): ${JSON.stringify(reviews.filter(Boolean), null, 2)}

Merge duplicate findings, drop ones that contradict the real code, and order by severity (blocking first). Give an overall verdict: build-ready (no blocking/should-fix findings), needs-changes (the skill can apply addStep/addCase/etc. itself), or needs-human-decision (a finding requires askQuestion). Keep each finding's suggestedAction and the exact detail text to author.`,
  { label: 'synthesize', phase: 'Synthesize', schema: SYNTH_SCHEMA },
)

return { synthesis, reviews: reviews.filter(Boolean) }
