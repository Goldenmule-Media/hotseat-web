/**
 * Server-only critic for the Study studio: evaluates a learner's own-words DEFINITION of
 * a glossary term against the term's meaning and the notes it came from.
 *
 * STATELESS BY CONSTRUCTION, and it always was. The term, the definition and the note
 * context all travel in the prompt, so any number of terms evaluate concurrently and
 * nothing here needs a session, a lock, or a resume id — which is why this module moved to
 * the Messages API without acquiring conversation machinery.
 *
 * The reply is a constrained decode rather than a request for good behaviour: the verdict
 * shape is an `output_config` json_schema, so the "reply with EXACTLY one JSON object"
 * begging, the brace-scanning extractor, and the reinforcement retry that followed a
 * malformed reply are all gone. {@link validateStudyVerdict} stays: the schema is a
 * parsing convenience, the validator is the contract.
 *
 * ONE model call, with NO `tools`, so the evaluator has no filesystem, no MCP, and no
 * subprocess to reach for. The `claude` CLI's skip-permissions flag, empty --mcp-config,
 * scratch cwd and stripped child env existed because a spawned CLI could otherwise
 * discover a project .mcp.json and pick up authenticated wiki write tools. That threat is
 * absent here rather than mitigated, so the apparatus disappears with it.
 */
import type Anthropic from "@anthropic-ai/sdk";

import { anthropicClient, CHAT_MODEL, describeAnthropicError } from "./anthropic";

/** The single source of the grade vocabulary: the type, the schema enum and the coercion
 *  all read this, so they cannot drift apart. */
export const GRADES = ["understood", "partial", "surface"] as const;

export type CritiqueGrade = (typeof GRADES)[number];

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
  /** Test seam. The route never sets this. */
  create?: CreateMessage;
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

/** The bullet cap is the prompt's and the validator's job, not the schema's: a count
 *  keyword the API rejects would only show up in production. */
export const VERDICT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    grade: { enum: [...GRADES] },
    points: { type: "array", items: { type: "string" } },
    suggestion: { type: "string" },
  },
  required: ["grade", "points", "suggestion"],
  additionalProperties: false,
} as const;

/** What counts as understanding. Constant across every evaluation, so it lives in the
 *  system prompt and the term travels alone in the user turn. */
export function evaluationSystemPrompt(): string {
  return [
    "You are the evaluator in a study-notes glossary. A learner reads a source, marks terms worth knowing,",
    "and defines each in their OWN words to prove understanding. You judge whether the definition shows the",
    "concept is theirs — correct, complete where it matters, and not a hollow reword. Judge understanding,",
    "not prose style; a compressed definition that keeps the mechanism beats a fluent one that loses it.",
    "",
    "You are a function, not a chat partner. You return one object with three fields, `grade`, `points`",
    "and `suggestion`.",
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
  ].join("\n");
}

/** The one thing being judged: the term, what the notes said about it, and what the
 *  learner wrote. */
export function evaluationUserTurn(input: TermEvaluationInput): string {
  const lines: string[] = [];
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

export type EvaluationOutcome = { ok: true; verdict: StudyVerdict } | { ok: false; message: string };

export type CreateMessage = (
  params: Anthropic.MessageCreateParamsNonStreaming,
  options?: Anthropic.RequestOptions,
) => Promise<Anthropic.Message>;

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function clientCreate(): CreateMessage | null {
  const client = anthropicClient();
  if (client === null) return null;
  return (params, options) => client.messages.create(params, options);
}

export async function runTermEvaluation(input: TermEvaluationInput): Promise<EvaluationOutcome> {
  const create = input.create ?? clientCreate();
  if (create === null) {
    return { ok: false, message: "the evaluator is not configured (ANTHROPIC_API_KEY is not set)" };
  }

  let response: Anthropic.Message;
  try {
    response = await create(
      {
        model: CHAT_MODEL,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system: evaluationSystemPrompt(),
        messages: [{ role: "user", content: evaluationUserTurn(input) }],
        output_config: { format: { type: "json_schema", schema: VERDICT_OUTPUT_SCHEMA } },
      },
      { signal: input.signal, timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    );
  } catch (err) {
    return { ok: false, message: `the evaluation ${describeAnthropicError(err)}` };
  }

  if (response.stop_reason === "refusal") return { ok: false, message: "the evaluator declined to judge this term" };
  if (response.stop_reason === "max_tokens") {
    return { ok: false, message: "the evaluation ran past its length limit" };
  }

  const noVerdict = { ok: false as const, message: "the evaluation reply had no usable verdict" };
  // Adaptive thinking usually puts a thinking block first, so find the text block, never index it.
  const text = response.content.find((block) => block.type === "text");
  if (text === undefined) return noVerdict;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.text);
  } catch {
    return noVerdict;
  }
  const verdict = validateStudyVerdict(parsed);
  return verdict === null ? noVerdict : { ok: true, verdict };
}

/** Becomes the SDK's per-request `timeout`, in milliseconds, which is the unit the
 *  TypeScript SDK already takes. */
export function evalTimeoutMsFromEnv(env: Record<string, string | undefined>, fallbackMs: number): number {
  const raw = env.STUDY_EVAL_TIMEOUT_MS ?? env.SPEC_RESTATE_TIMEOUT_MS;
  if (raw === undefined) return fallbackMs;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallbackMs;
}
