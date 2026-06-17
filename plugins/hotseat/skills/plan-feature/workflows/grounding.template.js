/**
 * Grounding workflow — TEMPLATE for the `plan-feature` skill.
 *
 * Run as-is via Workflow({ scriptPath, args }) for the common case; adapt the fan-out
 * shape inline when a feature needs a different scan. Reads the REAL repo in parallel and
 * returns a structured, repo-faithful plan proposal. It does NOT write to the wiki — the
 * skill (main loop) authors the proposal via MCP, driven by nextActions.
 *
 * args: {
 *   intent: string,       // REQUIRED — one-line feature intent, or the current brief summary
 *   repoRoot?: string,    // worktree root (agents also inherit the session cwd); default "."
 *   areas?: string[],     // optional repo areas/paths to focus the scan
 * }
 *
 * A caller without the Workflow schema in its prompt emits `args` as a JSON-encoded STRING —
 * coerced below. A missing/unreadable `intent` throws immediately: a placeholder grounding
 * run costs a full agent fan-out and comes back blocked, so fail fast instead.
 */
export const meta = {
  name: 'plan-feature-grounding',
  description: 'Parallel repo read to ground a feature plan (steps, data models, test cases, conflicts)',
  phases: [
    { title: 'Scan', detail: 'parallel readers ground the feature in real code' },
    { title: 'Synthesize', detail: 'consolidate into one repo-faithful plan proposal' },
  ],
}

let input = args
if (typeof input === 'string') {
  try { input = JSON.parse(input) } catch { input = null }
}
if (!input || typeof input.intent !== 'string' || input.intent.trim() === '') {
  throw new Error(
    'grounding.template.js requires args.intent — pass args as a real JSON object ' +
    '{ intent, repoRoot?, areas? }, not a JSON-encoded string (got ' + typeof args + '). ' +
    'If args cannot reach the script intact, re-run with the template body inlined via the ' +
    '`script` parameter and the values baked in.',
  )
}
const intent = input.intent
const repoRoot = input.repoRoot || '.'
// Default areas are scan LENSES applied to the real intent above — not feature placeholders.
const areas = (Array.isArray(input.areas) && input.areas.length)
  ? input.areas
  : [
      'affected modules / entry points',
      'existing similar features & the patterns they follow',
      'data shapes & types involved',
      'test conventions & harness',
    ]

const SCAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    area: { type: 'string' },
    findings: { type: 'array', items: { type: 'string' } },
    relevantFiles: { type: 'array', items: { type: 'string' }, description: 'file:line refs' },
    priorArtOrConflicts: { type: 'array', items: { type: 'string' }, description: 'does this already partly exist / what will it collide with' },
  },
  required: ['area', 'findings'],
}

const PROPOSAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string', description: 'one-paragraph feature summary grounded in the repo' },
    components: { type: 'array', items: { type: 'string' } },
    constraints: { type: 'array', items: { type: 'string' } },
    planSteps: { type: 'array', items: { type: 'string' }, description: 'ordered implementation steps referencing real modules' },
    dataModels: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { language: { type: 'string' }, source: { type: 'string' } },
        required: ['language', 'source'],
      },
      description: 'data-model code blocks (≥1 needed to unblock beginImplementation)',
    },
    testCases: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' }, description: 'things genuinely needing a human decision' },
    conflicts: { type: 'array', items: { type: 'string' }, description: 'prior art / collisions with existing code' },
  },
  required: ['summary', 'planSteps', 'dataModels', 'testCases'],
}

phase('Scan')
const scans = await parallel(
  areas.map((area, i) => () =>
    agent(
      `Ground a feature in the REAL repository at ${repoRoot}.
Feature intent: ${intent}
Focus area: ${area}

Read the actual code (Glob/Grep/Read). Report concrete findings, the relevant file:line refs, and any prior art or conflicts (does this already partly exist? what will it collide with?). Do NOT propose a plan yet — just ground this area in what the code actually is.`,
      { label: `scan:${i}`, phase: 'Scan', agentType: 'Explore', schema: SCAN_SCHEMA },
    ),
  ),
)

phase('Synthesize')
const proposal = await agent(
  `Consolidate these grounded findings into ONE concrete, repo-faithful feature plan.
Feature intent: ${intent}
Grounded findings (JSON): ${JSON.stringify(scans.filter(Boolean), null, 2)}

Produce: a grounded summary; components; constraints; an ORDERED list of implementation steps that reference real modules; at least one data-model code block (language + source) reflecting the actual data shapes; concrete testing-plan cases; open questions that genuinely need a human decision; and any conflicts with existing code. Ground every step in the findings above — do not invent.`,
  { label: 'synthesize', phase: 'Synthesize', schema: PROPOSAL_SCHEMA },
)

return { proposal, scans: scans.filter(Boolean) }
