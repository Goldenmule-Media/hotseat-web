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
 *   cases?: [{ caseId: string, text: string }], // testing-plan cases to exercise
 *   steps?: [{ stepId: string, text: string }], // optional: plan steps to spot-check
 * }
 */
export const meta = {
  name: 'build-feature-verification',
  description: 'Run typecheck/test and exercise each testing-plan case in parallel; report real pass/fail',
  phases: [
    { title: 'Gate', detail: 'typecheck + test suite' },
    { title: 'Cases', detail: 'one verifier per testing-plan case' },
  ],
}

const repoRoot = (args && args.repoRoot) || '.'
const cases = (args && args.cases) || []

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

phase('Gate')
const gate = await agent(
  `In the repo at ${repoRoot}, run the project's gate and report REAL results:
- \`npm run typecheck\`
- \`npm run test\`
Report whether each passed and, if not, the relevant failing output. Do not claim success you did not observe.`,
  { label: 'gate', phase: 'Gate', schema: GATE_SCHEMA },
)

phase('Cases')
const caseResults = await parallel(
  cases.map((c, i) => () =>
    agent(
      `In the repo at ${repoRoot}, determine whether this testing-plan case actually holds for the CURRENT code:
Case ${c.caseId}: ${c.text}

Exercise it for real — run the specific test, write and run a quick check, or read and trace the code path. Report passed=true ONLY if you genuinely confirmed it. If you cannot confirm, report passed=false with evidence. Default to false when uncertain — these results flip FSM gates, which must reflect reality.`,
      { label: `case:${c.caseId || i}`, phase: 'Cases', schema: CASE_SCHEMA },
    ),
  ),
)

return { gate, caseResults: caseResults.filter(Boolean) }
