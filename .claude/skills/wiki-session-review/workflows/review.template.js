export const meta = {
  name: 'wiki-session-review',
  description: "Analyze a session's wiki usage, adversarially verify each friction finding, and synthesize grounded recommendations for optimizing the wiki model",
  phases: [
    { title: 'Analyze', detail: 'fan out finders across friction dimensions over the trace + model source' },
    { title: 'Verify', detail: 'adversarially confirm each finding is real, model-fixable, and not already solved' },
    { title: 'Recommend', detail: 'synthesize confirmed findings into prioritized, grounded recommendations' },
  ],
}

// ---- args (passed by the SKILL spine) --------------------------------------------------------------
// args.tracePath  — absolute path to the wiki-trace JSON emitted by scripts/extract-wiki-trace.mjs
// args.repoRoot   — absolute path to the hotseat-web repo (where the wiki model lives, for grounding)
// args.sessionId  — the analyzed session id (for labels/report)
// Tolerate args arriving as a JSON string (a common Workflow-invocation footgun) as well as an object.
let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch { A = {} } }
A = A || {}
const tracePath = A.tracePath
const repoRoot = A.repoRoot
const sessionId = A.sessionId || 'unknown'
if (!tracePath || !repoRoot) throw new Error('review.template.js requires args.tracePath and args.repoRoot')

// Shared orientation handed to every agent: the trace shape, how to slice it, and the model's layout +
// the load-bearing invariants the recommendations must respect (schema-agnostic boundary, determinism).
const TRACE_GUIDE = `
The trace is JSON at: ${tracePath}
Shape: { meta, stats, userPrompts[], timeline[] }.
  stats: { wikiCalls, wikiWrites, wikiReads, errors, callsByTool, errorsByTool, retriesAfterError, maxReadStreak, ... }
  userPrompts[]: { seq, ts, text }            — the human's actual asks (slash-command chrome stripped)
  timeline[] (every mcp__wiki__ call, in order):
    { seq, recordIndex, ts, isSidechain, kind:'read'|'write', tool, intent, reasoning, input, result:{isError,length,text}, otherToolsSince[] }
    - intent/reasoning = the model's stated plan/thinking right before the call (truncated)
    - input            = the call args (long prose fields truncated to ~240 chars; structure preserved)
    - result.text      = the tool's reply, truncated (~700) — for writes this includes the engine's "next" echo; for errors, the error message
    - otherToolsSince  = non-wiki tools used since the previous wiki call (churn context)
Slice it with jq/node via Bash — do NOT dump the whole file. Useful starting points:
  jq '.stats' ${tracePath}
  jq -r '.userPrompts[] | "\\(.seq): \\(.text)"' ${tracePath}
  jq -c '.timeline[] | select(.result.isError) | {seq,tool,intent,err:.result.text}' ${tracePath}
  jq -c '.timeline[] | {seq,tool,kind,intent}' ${tracePath}                 # the full ordered sequence
  jq -c '.timeline[] | select(.kind=="write") | {seq,tool,n:(.input.commands?|length),err:.result.isError}' ${tracePath}
`.trim()

const MODEL_GUIDE = `
The wiki MODEL you are evaluating lives in this repo (root: ${repoRoot}):
  - PAGE TYPES (FSM, sections, field-kinds, commands + their Zod arg schemas, descriptions, the
    model-declared 'agency'/'awaitsHuman' classifiers): wiki-models/src/{feature/*,architecture,adr,toc}.ts
    Each calls definePageType(...). FSM transitions are t(from, event, to). Read these to judge what the
    agent was *allowed* to do and how legibly the model told it so.
  - MCP TOOL SURFACE + descriptions (what the agent literally reads): wiki-mcp/src/mcp/tools.ts,
    server.ts, resources.ts; token/output shaping: wiki-mcp/src/mcp/tokens.ts.
  - SELF-DIRECTION (the 'next' echo + nextActions/attention roll-up that is supposed to tell the agent
    what to do next): grep wiki-mcp/src for nextActions / "next" / attention.
  - CONTENT-MODEL RULES (e.g. the "blocks text run may not contain Markdown" rule, ref resolution,
    structural invariants like unique-sibling-title / acyclic): docs/wiki/architecture/content-model.md
    and the engine in wiki/src. The CLAUDE.md at the repo root is the boundary map.
LOAD-BEARING CONSTRAINTS any recommendation MUST respect (do not propose violating these):
  - The engine (wiki) and host (wiki-mcp) are SCHEMA-AGNOSTIC: concrete page types live ONLY in
    wiki-models. A fix that hardcodes a page-type concept into wiki/wiki-mcp is WRONG — push it into the
    model layer or into model-declared metadata the host reads generically.
  - DETERMINISM: no Date.now()/Math.random()/new Date() in apply/produces/render. Equal state must render
    byte-identical Markdown.
  - The model is intentionally LLM-first and self-directing. Free text is never authored — only typed,
    FSM-gated mutations.
A finding is only actionable if a change to the MODEL (a page type's FSM/commands/descriptions/sections),
the MCP TOOL SURFACE (descriptions, output shape, a new affordance), the SELF-DIRECTION text, or a
content-model rule would have prevented or eased the friction. Friction that is irreducible agent error,
or specific to this one user's task, is NOT actionable — say so.
`.trim()

// ---- the friction dimensions (multi-modal sweep) ---------------------------------------------------
const DIMENSIONS = [
  {
    key: 'fsm-gates',
    title: 'FSM gates & status affordances',
    focus: `Did mutations get rejected because the FSM didn't declare the transition, or because the page
was in the wrong status? Did the agent try to do something legal-seeming the FSM forbids, or fail to find
the edge it needed? Was the legal next edge legible (via the 'next' echo / describePageType FSM)? Look at
write errors, status-related intents, and any back-and-forth around beginPlanning/beginImplementation/
submit/ship-style gates. Ground every claim in the actual t(from,event,to) edges in the page-type source.`,
  },
  {
    key: 'command-args',
    title: 'Command args, content rules & validation',
    focus: `Arg-validation rejections and content-rule rejections (e.g. BATCH_COMMAND_FAILED, "blocks text
run may not contain Markdown", "ref target does not resolve", DUPLICATE_TITLE). For each: was the rule
discoverable BEFORE the agent hit it (describeMutations/describePageType/tool description), or only via the
error? Did a whole batch abort on one bad command (losing the rest)? Were forward refs within a batch
unsupported? Ground in the command Zod schemas and the content-model rules.`,
  },
  {
    key: 'self-direction',
    title: 'Self-direction adherence',
    focus: `The model is supposed to drive the agent via the 'next' echo and nextActions/attention. Did the
agent USE nextActions/attention, or freelance and stumble? Did it ask the user "what next" when the FSM
already encoded it? Did it create things the model auto-materializes (e.g. pinned child pages) and then
have to archive/rename them — a discoverability gap? When the agent took a wrong turn, was the correct path
actually surfaced in a prior 'next' echo it ignored (agent error) or was the guidance absent/misleading
(model-fixable)? Ground in the nextActions/next-echo implementation and the agency/awaitsHuman classifiers.`,
  },
  {
    key: 'read-discovery',
    title: 'Read & discovery churn',
    focus: `Reconstruction cost: repeated describePageType/describeMutations/tree/getPage/renderPage to
figure out state or the type's shape; long read streaks (stats.maxReadStreak); re-probing the same type
multiple times. Could a richer default tool output, a single combined discovery call, or clearer
descriptions have cut round-trips? Distinguish healthy orientation from avoidable thrash. Ground in the
read tools and their output shaping (tokens.ts).`,
  },
  {
    key: 'mutation-ergonomics',
    title: 'Mutation ergonomics & batching',
    focus: `Awkward multi-call sequences a better affordance would collapse: many mutatePage calls where a
batch fits (or vice versa), whole-batch-abort cost, link/unlink/setPageTitle/reparent/assignSerials/
renameSymbol friction, title/duplicate handling, retries after errors (stats.retriesAfterError). Did the
agent fight the tool surface to express a simple intent? Ground in the mutation tools and the structural
invariants they enforce.`,
  },
  {
    key: 'lifecycle-admin',
    title: 'Workspace/page lifecycle & admin',
    focus: `Workspace and page lifecycle (createWorkspace/archivePage/unarchivePage/archiveWorkspace),
emitter ops (configureEmitter/listEmitters/removeEmitter), and serials (assignSerials). Did the agent
fumble create/archive/rename ordering, mis-handle duplicates, or struggle with admin tool ergonomics?
Ground in the lifecycle/admin tools. Note: if the session never used these, say so and return no findings.`,
  },
]

// ---- structured-output schemas ---------------------------------------------------------------------
const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dimension', 'findings'],
  properties: {
    dimension: { type: 'string' },
    dimensionVerdict: {
      type: 'string',
      description: "Brief: did the agent use the wiki WELL in this dimension, or hit friction? If clean, say so.",
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'whatHappened', 'rootCause', 'modelFixable', 'proposedChange', 'severity', 'confidence', 'evidenceSeqs'],
        properties: {
          id: { type: 'string', description: 'short stable id, e.g. fsm-gates-1' },
          title: { type: 'string' },
          whatHappened: { type: 'string', description: 'the concrete wrong turn / friction, with trace evidence' },
          rootCause: { type: 'string', description: 'the model-side cause hypothesis' },
          modelFixable: { type: 'boolean', description: 'true iff a model/tool/description/FSM change would prevent it (not irreducible agent error)' },
          agentErrorRisk: { type: 'string', description: 'the strongest case that this is just agent error or user-specific, not a model gap' },
          proposedChange: {
            type: 'object',
            additionalProperties: false,
            required: ['target', 'location', 'change'],
            properties: {
              target: { type: 'string', enum: ['wiki-models', 'wiki-mcp', 'wiki', 'tool-description', 'content-model', 'self-direction', 'docs', 'cross-cutting'] },
              location: { type: 'string', description: 'file / page-type / tool / FSM-edge to change' },
              change: { type: 'string', description: 'the concrete proposed change' },
            },
          },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          confidence: { type: 'number', description: '0..1' },
          evidenceSeqs: { type: 'array', items: { type: 'number' }, description: 'timeline seq numbers backing this' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findingId', 'isReal', 'isModelFixable', 'notAlreadySolved', 'fixSound', 'verdict', 'rationale', 'confidence'],
  properties: {
    findingId: { type: 'string' },
    isReal: { type: 'boolean', description: 'the friction genuinely occurred (evidence checks out in the trace)' },
    isModelFixable: { type: 'boolean', description: 'a wiki-model/tool/description/FSM change would actually prevent it — not irreducible agent error' },
    notAlreadySolved: { type: 'boolean', description: 'the proposed affordance does NOT already exist (under another name) and does NOT contradict a deliberate design choice' },
    fixSound: { type: 'boolean', description: 'the proposed change is coherent and respects the schema-agnostic boundary + determinism + content-model rules' },
    verdict: { type: 'string', enum: ['keep', 'revise', 'drop'] },
    revisedProposal: { type: 'string', description: 'if verdict=revise, the corrected change (target/location/change)' },
    rationale: { type: 'string', description: 'why — cite the model source you checked' },
    confidence: { type: 'number' },
  },
}

const RECOMMENDATIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'sessionContext', 'recommendations', 'dimensionsClean', 'markdownReport'],
  properties: {
    verdict: { type: 'string', enum: ['changes-recommended', 'no-changes-warranted'] },
    summary: { type: 'string' },
    sessionContext: { type: 'string', description: 'one short paragraph: what the session was trying to do' },
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'priority', 'target', 'location', 'problem', 'change', 'rationale', 'evidenceSeqs', 'confidence'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          target: { type: 'string', enum: ['wiki-models', 'wiki-mcp', 'wiki', 'tool-description', 'content-model', 'self-direction', 'docs', 'cross-cutting'] },
          location: { type: 'string' },
          problem: { type: 'string' },
          change: { type: 'string' },
          rationale: { type: 'string' },
          evidenceSeqs: { type: 'array', items: { type: 'number' } },
          risks: { type: 'string', description: 'boundary/determinism considerations, or "none"' },
          confidence: { type: 'number' },
        },
      },
    },
    dimensionsClean: {
      type: 'array',
      description: 'dimensions where the agent used the wiki well — no change warranted',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['dimension', 'note'],
        properties: { dimension: { type: 'string' }, note: { type: 'string' } },
      },
    },
    openQuestions: { type: 'array', items: { type: 'string' } },
    markdownReport: { type: 'string', description: 'the full human-readable report, ready to present verbatim' },
  },
}

// ---- run -------------------------------------------------------------------------------------------
log(`Reviewing wiki usage for session ${sessionId} — ${DIMENSIONS.length} dimensions`)

// Analyze → Verify, pipelined per dimension (each dimension's findings verify the moment it completes).
const perDimension = await pipeline(
  DIMENSIONS,
  // Stage 1 — analyze one dimension over the trace + model source.
  (dim) => agent(
    `You are reviewing how a Claude agent used the structured wiki's MCP API in one past session, to find
where the WIKI MODEL could be optimized so future agents take fewer wrong turns.

DIMENSION: ${dim.title}
${dim.focus}

${TRACE_GUIDE}

${MODEL_GUIDE}

Method: (1) read stats + the relevant trace slices for this dimension; (2) for each candidate friction
point, read the actual model source to confirm the cause and design a concrete fix; (3) be honest about
whether it is model-fixable vs irreducible agent error (fill agentErrorRisk for every finding). Cite
timeline seq numbers as evidence. Read-only: do not modify any files. If the agent used the wiki well in
this dimension, return an empty findings array and say so in dimensionVerdict. Return ONLY findings whose
root cause plausibly lives in the model/tool surface.`,
    { label: `analyze:${dim.key}`, phase: 'Analyze', schema: FINDINGS_SCHEMA },
  ),
  // Stage 2 — adversarially verify each finding from this dimension (in parallel), grounded in the repo.
  (analysis, dim) => {
    const findings = (analysis && analysis.findings) || []
    if (findings.length === 0) return []
    return parallel(findings.map((f) => () =>
      agent(
        `Adversarially verify ONE proposed wiki-model finding. Your default is skepticism: a finding
survives only if it clears ALL of these, checked against the ACTUAL model source — otherwise drop it.

FINDING:
${JSON.stringify(f, null, 2)}

${TRACE_GUIDE}

${MODEL_GUIDE}

Check, citing the source files you read:
  1. isReal      — does the trace evidence (the cited seqs) actually show this friction? Re-read them.
  2. isModelFixable — would the proposed model/tool/description/FSM change really prevent it, or is it
                   irreducible agent error / specific to this user's task? Try hard to argue it's agent error.
  3. notAlreadySolved — does the proposed affordance ALREADY exist (maybe under another tool/name), or does
                   it contradict a deliberate design choice (schema-agnostic boundary, determinism,
                   LLM-first no-free-text, content-model rules)? Search the source to confirm.
  4. fixSound    — is the change coherent and does it respect the load-bearing constraints? A fix that
                   hardcodes a page-type concept into wiki/wiki-mcp fails this; push it to wiki-models or to
                   model-declared metadata read generically.
verdict: keep (all four hold) | revise (real+model-fixable but the proposed change is wrong → give
revisedProposal) | drop (fails isReal or isModelFixable, or is already solved). When uncertain, drop.
Read-only.`,
        { label: `verify:${f.id}`, phase: 'Verify', schema: VERDICT_SCHEMA },
      ).then((v) => (v ? { finding: f, dimension: dim.key, verdict: v } : null)),
    ))
  },
)

// Barrier reached (pipeline awaited all). Collect the survivors.
const verified = perDimension.flat().filter(Boolean)
const kept = verified.filter((v) => v.verdict && v.verdict.verdict !== 'drop')
log(`${verified.length} findings verified → ${kept.length} survived (kept/revised); synthesizing`)

// Recommend — one synthesis pass over the survivors + the clean-dimension notes.
const cleanDims = DIMENSIONS.map((d) => d.key) // synthesis agent will mark which had no surviving findings

const recommendations = await agent(
  `Synthesize the FINAL recommendations for optimizing the wiki model, from these verified findings about
one session's wiki usage. Each finding carries an adversarial verdict (keep/revise) — honor 'revise' by
using its revisedProposal. Deduplicate overlapping findings across dimensions, prioritize by impact
(how often / how badly it cost the agent), and ground each recommendation in a concrete location in the
model source.

SESSION: ${sessionId}
DIMENSIONS REVIEWED: ${cleanDims.join(', ')}
VERIFIED FINDINGS (survivors):
${JSON.stringify(kept.map((k) => ({ dimension: k.dimension, verdict: k.verdict.verdict, revised: k.verdict.revisedProposal, finding: k.finding })), null, 2)}

${TRACE_GUIDE}

${MODEL_GUIDE}

Produce:
  - verdict: 'changes-recommended' if there is at least one high-confidence, model-fixable improvement;
    otherwise 'no-changes-warranted' (it is a valid and good outcome to recommend NO changes).
  - sessionContext: read userPrompts to state, in one paragraph, what the session was trying to do.
  - recommendations: prioritized, each naming the exact file/page-type/tool/FSM-edge to change, the
    concrete change, the friction it removes (with evidence seqs), and any boundary/determinism risks.
  - dimensionsClean: for every dimension with no surviving finding, a one-line note that the agent used the
    wiki well there.
  - markdownReport: the full report as Markdown, ready to show the user verbatim — lead with the verdict
    and session context, then recommendations grouped by target (wiki-models / wiki-mcp / tool-description /
    self-direction / content-model), then the clean dimensions, then open questions. Reference evidence as
    "seq N". Be concrete and skimmable.
Read-only: recommend, do not apply.`,
  { label: 'synthesize', phase: 'Recommend', schema: RECOMMENDATIONS_SCHEMA },
)

return {
  sessionId,
  tracePath,
  counts: { verified: verified.length, kept: kept.length, dimensions: DIMENSIONS.length },
  recommendations,
}
