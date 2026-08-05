/**
 * Server-only critic for the Study studio: evaluates a learner's own-words DEFINITION of
 * a glossary term against the term's meaning and the notes it came from.
 *
 * Unlike the spec-restatement critic there is NO shared session: every evaluation is a
 * stateless one-shot (the term, the definition and the note context all travel in the
 * prompt), so any number of terms evaluate concurrently. The verdict reuses the critique
 * shape (grade / summary / gaps / improvements) and its validators wholesale.
 */

import { extractJson, runClaude, type CritiqueGrade, type RunClaudeResult } from "./claude-cli";

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

/** The verdict is a flashcard margin note: a few terse bullets plus one suggested
 *  definition — no summary sentence, no essay. */
export const STUDY_MAX_POINTS = 3;

export interface StudyVerdict {
  grade: CritiqueGrade;
  /** The verdict itself, as terse bullet fragments — most damaging first. */
  points: string[];
  /** The definition as it should have been written (shown blurred until clicked). */
  suggestion: string;
}

const EVAL_JSON_SHAPE =
  '{"grade": "understood"|"partial"|"surface", "points": ["<terse fragment, <=10 words>"], "suggestion": "<the definition as it should read, <=20 words>"}';

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
    `points: 1 to ${STUDY_MAX_POINTS} BULLETS and nothing else — no summary sentence. Each is a terse fragment`,
    "(<=10 words) naming one thing missed, inverted, or distorted, most damaging first. A factual error",
    'outranks an omission. When the grade is "understood", ONE bullet naming the load-bearing idea they got.',
    "suggestion: ALWAYS — the definition as the learner should have written it, <=20 words, plain and direct.",
    "",
    "BE TERSE. Fragments over sentences, every word earning its place. No flattery, no hedging, no",
    "restating the definition back. Judge only the text in front of you.",
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

function stringList(raw: unknown): string[] {
  if (typeof raw === "string") return raw.trim() === "" ? [] : [raw];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

function coerceGrade(raw: unknown): CritiqueGrade {
  if (typeof raw === "string") {
    const g = raw.trim().toLowerCase();
    if (g === "understood" || g === "surface") return g;
  }
  return "partial";
}

/** Lenient coercion + the caps; tolerates a legacy summary/gaps reply by folding it into
 *  points; null when there is nothing usable. */
export function validateStudyVerdict(raw: unknown): StudyVerdict | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  let points = stringList(obj.points);
  if (points.length === 0) {
    points = [...(typeof obj.summary === "string" && obj.summary.trim() !== "" ? [obj.summary] : []), ...stringList(obj.gaps)];
  }
  const suggestion = typeof obj.suggestion === "string" ? obj.suggestion.trim() : "";
  if (points.length === 0 && suggestion === "") return null;
  return { grade: coerceGrade(obj.grade), points: points.slice(0, STUDY_MAX_POINTS), suggestion };
}

function tryVerdict(text: string): StudyVerdict | null {
  try {
    return validateStudyVerdict(extractJson(text));
  } catch {
    return null;
  }
}

function failureMessage(res: RunClaudeResult): string {
  if (res.aborted) return "evaluation aborted";
  if (res.timedOut) return "evaluation timed out";
  return `evaluation failed: ${res.result.slice(0, 300)}`;
}

export type EvaluationOutcome = { ok: true; verdict: StudyVerdict } | { ok: false; message: string };

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
