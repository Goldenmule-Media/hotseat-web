/**
 * Verification workflow — TEMPLATE for the `build-feature` skill.
 *
 * Run as-is via Workflow({ scriptPath, args }) for the common case; adapt inline as needed.
 * Independently verifies real engineering work in parallel: runs the repo's typecheck/test
 * gate and exercises each testing-plan case, returning REAL pass/fail. It does NOT touch the
 * wiki — the skill (main loop) flips FSM gates from these results, honoring "gates reflect
 * reality." Agents must report only what they actually observed.
 *
 * args: {
 *   repoRoot?: string,                          // worktree root; default "."
 *   cases: [{ caseId: string, text: string }],  // REQUIRED, non-empty — testing-plan cases to exercise
 *   steps?: [{ stepId: string, text: string }], // optional: plan steps to spot-check as landed
 * }
 *
 * A caller without the Workflow schema in its prompt emits `args` as a JSON-encoded STRING —
 * coerced below. Missing/empty `cases` throws immediately: silently running zero case
 * verifiers would return a plausible gate-only result that the skill then flips gates from.
 */
export const meta = {
  name: 'build-feature-verification',
  description: 'Run typecheck/test and exercise each testing-plan case in parallel; report real pass/fail',
  phases: [
    { title: 'Gate', detail: 'typecheck + test suite' },
    { title: 'Cases', detail: 'one verifier per testing-plan case' },
    { title: 'Steps', detail: 'spot-check each plan step actually landed' },
  ],
}

let input = args
if (typeof input === 'string') {
  try { input = JSON.parse(input) } catch { input = null }
}
if (!input || !Array.isArray(input.cases) || input.cases.length === 0) {
  throw new Error(
    'verification.template.js requires args.cases (non-empty array of { caseId, text }) — ' +
    'pass args as a real JSON object, not a JSON-encoded string (got ' + typeof args + '). ' +
    'If args cannot reach the script intact, re-run with the template body inlined via the ' +
    '`script` parameter and the values baked in.',
  )
}
const repoRoot = input.repoRoot || '.'
const cases = input.cases
const steps = Array.isArray(input.steps) ? input.steps : []

const GATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    typecheckPassed: { type: 'boolean' },
    testPassed: { type: 'boolean' },
    failingOutput: { type: 'string', description: 'relevant excerpt if anything failed' },
  },
  required: ['typecheckPassed', 'testPassed'],
}

const CASE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    caseId: { type: 'string' },
    passed: { type: 'boolean' },
    evidence: { type: 'string', description: 'what was actually run/checked to decide' },
  },
  required: ['caseId', 'passed', 'evidence'],
}

const STEP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    stepId: { type: 'string' },
    landed: { type: 'boolean' },
    evidence: { type: 'string', description: 'file:line refs / what was read to decide' },
  },
  required: ['stepId', 'landed', 'evidence'],
}

phase('Gate')
const gate = await agent(
  `In the repo at ${repoRoot}, run the project's gate and report REAL results:
- \`npm run typecheck\`
- \`npm run test\`
Report whether each passed and, if not, the relevant failing output. Do not claim success you did not observe.`,
  { label: 'gate', phase: 'Gate', schema: GATE_SCHEMA },
)

// Cases and step spot-checks are independent — run both groups concurrently, grouped in the
// progress display by each agent's explicit `phase` opt.
const [caseResults, stepResults] = await Promise.all([
  parallel(
    cases.map((c, i) => () =>
      agent(
        `In the repo at ${repoRoot}, determine whether this testing-plan case actually holds for the CURRENT code:
Case ${c.caseId}: ${c.text}

Exercise it for real — run the specific test, write and run a quick check, or read and trace the code path. Report passed=true ONLY if you genuinely confirmed it. If you cannot confirm, report passed=false with evidence. Default to false when uncertain — these results flip FSM gates, which must reflect reality.`,
        { label: `case:${c.caseId || i}`, phase: 'Cases', schema: CASE_SCHEMA },
      ),
    ),
  ),
  steps.length === 0
    ? Promise.resolve([])
    : parallel(
        steps.map((s, i) => () =>
          agent(
            `In the repo at ${repoRoot}, spot-check whether this implementation-plan step has ACTUALLY landed in the current code:
Step ${s.stepId}: ${s.text}

Read the code (Glob/Grep/Read) and trace what the step claims. Report landed=true ONLY if the change genuinely exists as described, with file:line evidence. Default to false when uncertain — these results flip FSM gates, which must reflect reality.`,
            { label: `step:${s.stepId || i}`, phase: 'Steps', schema: STEP_SCHEMA },
          ),
        ),
      ),
])

return { gate, caseResults: caseResults.filter(Boolean), stepResults: stepResults.filter(Boolean) }
