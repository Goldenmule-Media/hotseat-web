/**
 * Server-only critic for the Study studio: evaluates a learner's own-words DEFINITION of
 * a glossary term against the term's meaning and the notes it came from.
 *
 * Unlike the spec-restatement critic there is NO shared session: every evaluation is a
 * stateless one-shot (the term, the definition and the note context all travel in the
 * prompt), so any number of terms evaluate concurrently. The verdict reuses the critique
 * shape (grade / summary / gaps / improvements) and its validators wholesale.
 */

import {
  extractJson,
  runClaude,
  validateCritiqueVerdict,
  MAX_GAPS,
  MAX_IMPROVEMENTS,
  type CritiqueVerdict,
  type RunClaudeResult,
} from "./claude-cli";

export interface TermEvaluationInput {
  /** The glossary term being defined. */
  term: string;
  /** The learner's definition, in their own words. */
  definition: string;
  /** Note excerpts where the term appears — grounds the critic in what the source taught. */
  context?: string;
  /** What is being studied (the page title, e.g. "Book - AI Engineering"). */
  subject?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const EVAL_JSON_SHAPE =
  '{"grade": "understood"|"partial"|"surface", "summary": "<one sentence, <=25 words>", "gaps": ["<one specific miss, <=20 words>"], "improvements": ["<one genuine strength worth keeping, <=15 words>"]}';

const JSON_ONLY = "Reply with EXACTLY one JSON object and nothing else: no prose, no preamble, no code fence.";

export function evaluationPrompt(input: TermEvaluationInput): string {
  const lines = [
    "You are the evaluator in a study-notes glossary. A learner reads a source, marks terms worth knowing,",
    "and defines each in their OWN words to prove understanding. You judge whether the definition shows the",
    "concept is theirs — correct, complete where it matters, and not a hollow reword. Judge understanding,",
    "not prose style; a compressed definition that keeps the mechanism beats a fluent one that loses it.",
    "",
    `You are a function, not a chat partner. ${JSON_ONLY} Shape:`,
    EVAL_JSON_SHAPE,
    "",
    'grade: "understood" = correct and the load-bearing idea is present; "partial" = right shape, something',
    'real missing or fuzzy; "surface" = wrong, circular, or reworded without the substance.',
    `gaps: at most ${MAX_GAPS}, most damaging first. Each names ONE thing the definition misses, inverts or`,
    "distorts, and what is actually true. A factual error outranks an omission. Empty when understood.",
    `improvements: at most ${MAX_IMPROVEMENTS}, only where the definition genuinely beats a textbook one`,
    "(a sharper example, a truer emphasis). Usually [].",
    "",
    "Every entry is one specific thing, stated once. No flattery, no hedging, no restating the definition",
    "back, no praise for effort. Judge only the text in front of you.",
    "",
  ];
  if (input.subject !== undefined && input.subject.trim() !== "") {
    lines.push(`SUBJECT: ${input.subject.trim()}`);
  }
  lines.push(`TERM: ${input.term.trim()}`);
  if (input.context !== undefined && input.context.trim() !== "") {
    lines.push("", "--- NOTES WHERE THE TERM APPEARS (the learner's source context) ---", input.context.trim());
  }
  lines.push("", "--- THE LEARNER'S DEFINITION ---", input.definition.trim());
  return lines.join("\n");
}

function reinforcementPrompt(): string {
  return `That was not a single valid JSON object. Reply now with ONLY one JSON object matching ${EVAL_JSON_SHAPE} — nothing else.`;
}

function tryVerdict(text: string): CritiqueVerdict | null {
  try {
    return validateCritiqueVerdict(extractJson(text));
  } catch {
    return null;
  }
}

function failureMessage(res: RunClaudeResult): string {
  if (res.aborted) return "evaluation aborted";
  if (res.timedOut) return "evaluation timed out";
  return `evaluation failed: ${res.result.slice(0, 300)}`;
}

export type EvaluationOutcome = { ok: true; verdict: CritiqueVerdict } | { ok: false; message: string };

export async function runTermEvaluation(input: TermEvaluationInput): Promise<EvaluationOutcome> {
  const first = await runClaude(evaluationPrompt(input), {
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
  if (!first.success) return { ok: false, message: failureMessage(first) };

  const verdict = tryVerdict(first.result);
  if (verdict !== null) return { ok: true, verdict };

  if (first.sessionId === undefined) {
    return { ok: false, message: "evaluation reply had no usable JSON verdict and no session to retry" };
  }
  const retry = await runClaude(reinforcementPrompt(), {
    resumeSessionId: first.sessionId,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
  if (!retry.success) return { ok: false, message: failureMessage(retry) };
  const retried = tryVerdict(retry.result);
  if (retried !== null) return { ok: true, verdict: retried };
  return { ok: false, message: "evaluation reply had no usable JSON verdict after a retry" };
}

export function evalTimeoutMsFromEnv(env: Record<string, string | undefined>, fallbackMs: number): number {
  const raw = env.STUDY_EVAL_TIMEOUT_MS ?? env.SPEC_RESTATE_TIMEOUT_MS;
  if (raw === undefined) return fallbackMs;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallbackMs;
}
