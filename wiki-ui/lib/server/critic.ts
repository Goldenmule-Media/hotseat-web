/**
 * Server-only critic orchestration for the restatement studio: the prompts and the
 * critique/review runs.
 *
 * The critic is an LLM-as-function: every reply is one JSON object and nothing else — no
 * prose to stream, no essay to skim. Length caps live in the prompt AND in
 * {@link validateCritiqueVerdict}, so a chatty reply still lands short.
 *
 * ONE claude session serves a whole page: the first critique opens it, every later
 * critique — other sections, later rounds — resumes it, so the critic accumulates the
 * spec as it goes. That session is a mutable on-disk resource, hence {@link onSession}
 * serializes runs against it; a resume that fails is retried once from a fresh session.
 */

import {
  runClaude,
  extractJson,
  validateCritiqueVerdict,
  validateReviewVerdict,
  MAX_GAPS,
  MAX_IMPROVEMENTS,
  type CritiqueVerdict,
  type ReviewVerdict,
  type RunClaudeResult,
} from "./claude-cli";

export interface SourceSection {
  title: string;
  markdown: string;
}

const CRITIQUE_JSON_SHAPE =
  '{"grade": "understood"|"partial"|"surface", "summary": "<one sentence, <=25 words>", "gaps": ["<one specific miss, <=20 words>"], "improvements": ["<one real gain over the source, <=20 words>"]}';

const REVIEW_JSON_SHAPE =
  '{"summary": "<one or two sentences>", "notes": [{"title": "<short label>", "markdown": "<the finding, <=3 sentences>", "severity": "minor"|"major"|"critical"}]}';

const JSON_ONLY = "Reply with EXACTLY one JSON object and nothing else: no prose, no preamble, no code fence.";

const CRITIQUE_PREAMBLE = [
  "You are the critic in a spec-restatement studio. A human rewrites AI-drafted spec sections in their own",
  "words to prove they understand them. You judge understanding, not prose style.",
  "",
  `You are a function, not a chat partner. ${JSON_ONLY} Shape:`,
  CRITIQUE_JSON_SHAPE,
  "",
  'grade: "understood" = the mechanism is theirs; "partial" = right shape, something real missed;',
  '"surface" = reworded, substance lost.',
  `gaps: at most ${MAX_GAPS}, most damaging first. Each names ONE claim, constraint or mechanism they missed,`,
  "inverted or distorted, and what the source actually says. An inversion outranks an omission.",
  `improvements: at most ${MAX_IMPROVEMENTS}, only where they genuinely beat the source. Usually [].`,
  "",
  "Every entry is one specific thing, stated once. No flattery, no hedging, no summarising the source back,",
  "no restating the same miss twice, no praise for effort.",
  "This session will bring you further sections of the same spec, and revised drafts of ones you have already",
  "seen. Use them as context only: never narrate what changed since your last critique, and never grade a",
  "draft on its history. Judge only the text in front of you.",
].join("\n");

function critiqueTask(section: SourceSection, restatement: string): string {
  return [
    `SECTION: ${section.title}`,
    "",
    "--- SOURCE ---",
    section.markdown.trim(),
    "",
    "--- RESTATEMENT ---",
    restatement.trim(),
  ].join("\n");
}

export function critiqueFirstPrompt(section: SourceSection, restatement: string): string {
  return `${CRITIQUE_PREAMBLE}\n\n${critiqueTask(section, restatement)}`;
}

/** Over `--resume`: the contract is in the session, so only the task and a one-line reminder go. */
export function critiqueFollowUpPrompt(section: SourceSection, restatement: string): string {
  return `${critiqueTask(section, restatement)}\n\n${JSON_ONLY} Shape:\n${CRITIQUE_JSON_SHAPE}`;
}

export function reviewPrompt(specMarkdown: string): string {
  return [
    "You are reviewing a complete specification document holistically.",
    "",
    "--- THE SPEC ---",
    specMarkdown.trim(),
    "",
    "Assess the document as a whole, not section by section: coherence and stable terminology across sections;",
    "contradictions between them; hand-offs the document assumes but never specifies; scope creep past its stated",
    "purpose; risks, constraints or failure modes it never addresses.",
    "",
    "The engine has already checked what a machine can: every required section is present and non-empty, the",
    "data-model section carries a fenced code block, the invariants section is a list, and every `(see X)` names",
    "a real section. Do not report those. Judge what only a reader can, and weight these hardest — they are the",
    "failures that a real spec of this shape only discovered late, at great cost:",
    "  1. A rule stated TWICE, in two places, in two subtly different ways. Quote both and say which is meant.",
    "  2. An input the algorithm reads whose ARRIVAL is never specified — how it reaches the component that",
    "     reads it, and the behaviour in the window before it does.",
    "  3. An identifier named in prose (a type, function, table, error, flag) that appears nowhere in any code",
    "     block, or under two different names in two places.",
    "  4. A field whose domain is given without its reserved or sentinel values, or a limit with no stated bound.",
    "  5. A staged plan whose stages do not say what they explicitly do NOT do yet, or that never says how the",
    "     system behaves against data authored for a stage that has not shipped.",
    "  6. An invariant the rest of the document relies on but the invariants section never states.",
    "",
    "One note per finding, most severe first. Reference sections by heading. No flattery, no summary of the spec.",
    'severity: "critical" = the spec cannot be built correctly as written; "major" = significant risk of',
    'misbuilding; "minor" = worth fixing, not blocking.',
    "",
    `${JSON_ONLY} Shape:`,
    REVIEW_JSON_SHAPE,
  ].join("\n");
}

function reinforcementPrompt(shape: string): string {
  return `That was not a single valid JSON object. Reply now with ONLY one JSON object matching ${shape} — nothing else.`;
}

function tryVerdict<T>(text: string, validate: (raw: unknown) => T | null): T | null {
  try {
    return validate(extractJson(text));
  } catch {
    return null;
  }
}

function failureMessage(what: string, res: RunClaudeResult): string {
  if (res.aborted) return `${what} aborted`;
  if (res.timedOut) return `${what} timed out`;
  return `${what} failed: ${res.result.slice(0, 300)}`;
}

// ── session serialization ───────────────────────────────────────────────────────

const sessionQueues = new Map<string, Promise<void>>();

/** `claude --resume <id>` mutates one on-disk session; concurrent runs would interleave it. */
function onSession<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const run = (sessionQueues.get(sessionId) ?? Promise.resolve()).then(task, task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  sessionQueues.set(sessionId, tail);
  void tail.then(() => {
    if (sessionQueues.get(sessionId) === tail) sessionQueues.delete(sessionId);
  });
  return run;
}

// ── runs ────────────────────────────────────────────────────────────────────────

export type CritiqueOutcome =
  | { ok: true; verdict: CritiqueVerdict; sessionId?: string }
  | { ok: false; message: string };

interface CritiqueInput {
  section: SourceSection;
  restatement: string;
  /** The PAGE's session — every section and every round resumes the same one. */
  sessionId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** `retryFresh`: the run died in a way a dead session id would explain (not a cancel/timeout). */
type Attempt = { outcome: CritiqueOutcome; retryFresh: boolean };

async function critiqueAttempt(input: CritiqueInput): Promise<Attempt> {
  const done = (outcome: CritiqueOutcome, retryFresh = false): Attempt => ({ outcome, retryFresh });
  const prompt =
    input.sessionId !== undefined
      ? critiqueFollowUpPrompt(input.section, input.restatement)
      : critiqueFirstPrompt(input.section, input.restatement);

  const first = await runClaude(prompt, {
    resumeSessionId: input.sessionId,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
  if (!first.success) {
    return done({ ok: false, message: failureMessage("critique", first) }, !first.aborted && !first.timedOut);
  }

  const verdict = tryVerdict(first.result, validateCritiqueVerdict);
  if (verdict !== null) return done({ ok: true, verdict, sessionId: first.sessionId });

  if (first.sessionId === undefined) {
    return done({ ok: false, message: "critique reply had no usable JSON verdict and no session to retry" });
  }
  const retry = await runClaude(reinforcementPrompt(CRITIQUE_JSON_SHAPE), {
    resumeSessionId: first.sessionId,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
  if (!retry.success) return done({ ok: false, message: failureMessage("critique retry", retry) });
  const retried = tryVerdict(retry.result, validateCritiqueVerdict);
  if (retried !== null) return done({ ok: true, verdict: retried, sessionId: first.sessionId });
  return done({ ok: false, message: "critique reply had no usable JSON verdict after a retry" });
}

export async function runCritique(input: CritiqueInput): Promise<CritiqueOutcome> {
  const resume = input.sessionId;
  if (resume === undefined) return (await critiqueAttempt(input)).outcome;

  const attempt = await onSession(resume, () => critiqueAttempt(input));
  if (!attempt.retryFresh) return attempt.outcome;
  // A dead session id (pruned, or opened under an older prompt contract) fails the whole
  // run — the source travels in every request, so a fresh session just re-opens the critic.
  return (await critiqueAttempt({ ...input, sessionId: undefined })).outcome;
}

export type ReviewOutcome = { ok: true; verdict: ReviewVerdict } | { ok: false; message: string };

export async function runReview(input: {
  specMarkdown: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ReviewOutcome> {
  const first = await runClaude(reviewPrompt(input.specMarkdown), {
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
  if (!first.success) return { ok: false, message: failureMessage("review", first) };

  const verdict = tryVerdict(first.result, validateReviewVerdict);
  if (verdict !== null) return { ok: true, verdict };

  if (first.sessionId === undefined) {
    return { ok: false, message: "review reply had no usable JSON verdict and no session to retry" };
  }
  const retry = await runClaude(reinforcementPrompt(REVIEW_JSON_SHAPE), {
    resumeSessionId: first.sessionId,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
  if (!retry.success) return { ok: false, message: failureMessage("review retry", retry) };
  const retried = tryVerdict(retry.result, validateReviewVerdict);
  if (retried !== null) return { ok: true, verdict: retried };
  return { ok: false, message: "review reply had no usable JSON verdict after a retry" };
}

export function timeoutMsFromEnv(env: Record<string, string | undefined>, fallbackMs: number): number {
  const raw = env.SPEC_RESTATE_TIMEOUT_MS;
  if (raw === undefined) return fallbackMs;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallbackMs;
}
