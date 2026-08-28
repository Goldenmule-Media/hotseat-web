/**
 * Server-only critic for the Restatement Studio: the prompts, the verdict validators, and
 * the two runs — a per-section critique and a holistic review of the whole spec.
 *
 * The critic is an LLM-as-function: every reply is one JSON object and nothing else — no
 * prose to stream, no essay to skim. A structured output (`output_config.format`) makes the
 * shape a decode constraint rather than a request, so the old ask-nicely-then-retry
 * apparatus is gone; the validators stay, because the caps and the coercions are the
 * contract and a schema only guarantees the frame.
 *
 * ONE Messages API call per run, and no session. The earlier design spawned the `claude`
 * CLI and kept ONE resumable session per page — the first critique opened it, every later
 * one resumed it — so the critic accumulated the spec as it went. That session was a single
 * mutable on-disk resource, which is why this module carried a per-session queue and a
 * retry-from-a-fresh-session path. `messages.create` is stateless, so the client sends the
 * prior exchanges back and {@link buildCritiqueMessages} assembles them into `messages[]`.
 * The client sends PAIRS; roles are assigned here, so nothing a client posts can arrive as
 * a system or assistant turn.
 *
 * The mitigation apparatus disappears because the threat does. The CLI's skip-permissions
 * flag, its disallowed-tools list, the always-on empty --mcp-config plus --strict-mcp-config,
 * the scratch cwd, and the stripped child env all existed because a spawned `claude` could
 * otherwise discover a project .mcp.json and acquire authenticated wiki write tools. A
 * messages.create call with NO `tools` parameter has no tool access at all: no filesystem,
 * no MCP, no subprocess. That is a reduction in attack surface, not a relocation of it.
 *
 * Billing moves from a Claude subscription to API credits FOR THE RESTATE CRITIC ONLY.
 */
import type Anthropic from "@anthropic-ai/sdk";

import { anthropicClient, CHAT_MODEL, describeAnthropicError } from "./anthropic";

export interface SourceSection {
  title: string;
  markdown: string;
}

// ── the verdicts (pure; unit-tested) ────────────────────────────────────────────

/** The enums the schema constrains the model to, and the types the studio reads, derived
 *  from one list each so the two cannot drift. */
export const GRADES = ["understood", "partial", "surface"] as const;
export type CritiqueGrade = (typeof GRADES)[number];

export const SEVERITIES = ["minor", "major", "critical"] as const;
export type ReviewSeverity = (typeof SEVERITIES)[number];

/** The prompt asks for these caps, the schema bounds the arrays, and the validator
 *  enforces them — so a chatty model can't make the panel long again. Entries are ordered
 *  most-damaging first. */
export const MAX_GAPS = 4;
export const MAX_IMPROVEMENTS = 2;

export interface CritiqueVerdict {
  grade: CritiqueGrade;
  summary: string;
  /** Things the restatement missed, misunderstood, or distorted relative to the source. */
  gaps: string[];
  /** Ways the restatement genuinely improved on the source. */
  improvements: string[];
}

export interface ReviewNote {
  title: string;
  markdown: string;
  severity: ReviewSeverity;
}

export interface ReviewVerdict {
  summary: string;
  notes: ReviewNote[];
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

/** Lenient coercion + the length caps; null when unusable (not an object, or no summary). */
export function validateCritiqueVerdict(raw: unknown): CritiqueVerdict | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.summary !== "string" || obj.summary.trim() === "") return null;
  return {
    grade: coerceGrade(obj.grade),
    summary: obj.summary,
    gaps: stringList(obj.gaps).slice(0, MAX_GAPS),
    improvements: stringList(obj.improvements).slice(0, MAX_IMPROVEMENTS),
  };
}

function coerceSeverity(raw: unknown): ReviewSeverity {
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    if (s === "major" || s === "critical") return s;
  }
  return "minor";
}

/** Lenient coercion; notes without usable title+markdown dropped; null when unusable. */
export function validateReviewVerdict(raw: unknown): ReviewVerdict | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.summary !== "string" || obj.summary.trim() === "") return null;
  const rawNotes = Array.isArray(obj.notes)
    ? obj.notes
    : obj.notes !== null && typeof obj.notes === "object"
      ? [obj.notes]
      : [];
  const notes: ReviewNote[] = [];
  for (const entry of rawNotes) {
    if (entry === null || typeof entry !== "object") continue;
    const note = entry as Record<string, unknown>;
    if (typeof note.title !== "string" || note.title.trim() === "") continue;
    if (typeof note.markdown !== "string" || note.markdown.trim() === "") continue;
    notes.push({ title: note.title, markdown: note.markdown, severity: coerceSeverity(note.severity) });
  }
  return { summary: obj.summary, notes };
}

// ── output schemas (a constrained decode, not a request for good behaviour) ──────

export const CRITIQUE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    grade: { enum: [...GRADES] },
    summary: { type: "string" },
    gaps: { type: "array", maxItems: MAX_GAPS, items: { type: "string" } },
    improvements: { type: "array", maxItems: MAX_IMPROVEMENTS, items: { type: "string" } },
  },
  required: ["grade", "summary", "gaps", "improvements"],
  additionalProperties: false,
} as const;

export const REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    notes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          markdown: { type: "string" },
          severity: { enum: [...SEVERITIES] },
        },
        required: ["title", "markdown", "severity"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "notes"],
  additionalProperties: false,
} as const;

// ── prompts ─────────────────────────────────────────────────────────────────────

/** Role, judging criteria and the word budgets the schema cannot express. Constant across
 *  every request, because with a messages array the contract no longer belongs to whichever
 *  critique happened to be first. */
export function critiqueSystemPrompt(): string {
  return [
    "You are the critic in a spec-restatement studio. A human rewrites AI-drafted spec sections in their own",
    "words to prove they understand them. You judge understanding, not prose style.",
    "",
    "You are a function, not a chat partner. You return one object with four fields: grade, summary, gaps",
    "and improvements.",
    "",
    'grade: "understood" = the mechanism is theirs; "partial" = right shape, something real missed;',
    '"surface" = reworded, substance lost.',
    "summary: one sentence, at most 25 words.",
    `gaps: at most ${MAX_GAPS}, most damaging first. Each names ONE claim, constraint or mechanism they missed,`,
    "inverted or distorted, and what the source actually says. An inversion outranks an omission. At most 20",
    "words each.",
    `improvements: at most ${MAX_IMPROVEMENTS}, only where they genuinely beat the source. Usually []. At most`,
    "20 words each.",
    "",
    "Every entry is one specific thing, stated once. No flattery, no hedging, no summarising the source back,",
    "no restating the same miss twice, no praise for effort.",
    "Earlier critiques of the same spec may arrive as prior turns — other sections, and earlier drafts of ones",
    "you have already seen. Use them as context only: never narrate what changed since your last critique, and",
    "never grade a draft on its history. Judge only the text in front of you.",
  ].join("\n");
}

/** One critique task: the section as written and the human's restatement of it. */
export function critiqueUserTurn(section: SourceSection, restatement: string): string {
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

export function reviewSystemPrompt(): string {
  return [
    "You are reviewing a complete specification document holistically.",
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
    "You are a function, not a chat partner. You return one object with two fields: summary (one or two",
    "sentences) and notes.",
    "One note per finding, most severe first. Each note is a short title, the finding in at most three sentences",
    "of markdown, and a severity. Reference sections by heading. No flattery, no summary of the spec.",
    'severity: "critical" = the spec cannot be built correctly as written; "major" = significant risk of',
    'misbuilding; "minor" = worth fixing, not blocking.',
  ].join("\n");
}

/** The spec travels here and nowhere else: exactly once per request, in the only message. */
export function reviewUserTurn(specMarkdown: string): string {
  return ["--- THE SPEC ---", specMarkdown.trim()].join("\n");
}

// ── history (the client's, replayed into messages[]) ────────────────────────────

/** One completed critique, as the client kept it. */
export interface CritiqueTurn {
  readonly section: SourceSection;
  readonly restatement: string;
  readonly verdict: CritiqueVerdict;
}

export const MAX_HISTORY_TURNS = 6;

/** Per replayed string, not per turn. A spec section and its restatement are pages rather
 *  than sentences, so this is far larger than a chat history's cap — but history is context,
 *  not the thing being judged, and an unbounded one would grow with the whole document. */
const MAX_HISTORY_CHARS = 6000;

function clip(text: string): string {
  return text.length > MAX_HISTORY_CHARS ? text.slice(0, MAX_HISTORY_CHARS) : text;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * The conversation as the model sees it: each past critique replays as its own task and
 * the verdict the model returned for it, then the current task last. Replaying the output
 * format keeps the model in distribution, and replaying the SOURCE is what carries the
 * "accumulates the spec" behaviour the resumed session used to provide.
 *
 * A malformed turn is skipped rather than half-sent — the client owns this history, and
 * half a turn would put a question in front of the model with no answer after it.
 */
export function buildCritiqueMessages(
  section: SourceSection,
  restatement: string,
  history: readonly CritiqueTurn[],
): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  for (const turn of history.slice(-MAX_HISTORY_TURNS)) {
    const title = asString(turn?.section?.title);
    const markdown = asString(turn?.section?.markdown);
    const restated = asString(turn?.restatement);
    const verdict = validateCritiqueVerdict(turn?.verdict);
    if (title === null || markdown === null || restated === null || verdict === null) continue;
    messages.push({
      role: "user",
      content: critiqueUserTurn({ title, markdown: clip(markdown) }, clip(restated)),
    });
    messages.push({ role: "assistant", content: JSON.stringify(verdict) });
  }
  // The current task goes unclipped: it is what is being judged, not context.
  messages.push({ role: "user", content: critiqueUserTurn(section, restatement) });
  return messages;
}

// ── runs ────────────────────────────────────────────────────────────────────────

export type CreateMessage = (
  params: Anthropic.MessageCreateParamsNonStreaming,
  options?: Anthropic.RequestOptions,
) => Promise<Anthropic.Message>;

function clientCreate(): CreateMessage | null {
  const client = anthropicClient();
  if (client === null) return null;
  return (params, options) => client.messages.create(params, options);
}

/** Enough room for adaptive thinking plus a verdict; both replies are short by contract. */
const MAX_TOKENS = 16000;

type Answer<T> = { ok: true; verdict: T } | { ok: false; message: string };

/**
 * One structured-output call, validated. `what` names the run in every failure sentence,
 * so the studio can show the reason without the route knowing which run failed.
 */
async function ask<T>(args: {
  what: string;
  create: CreateMessage | null;
  system: string;
  messages: Anthropic.MessageParam[];
  schema: Record<string, unknown>;
  validate: (raw: unknown) => T | null;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<Answer<T>> {
  const { what, create } = args;
  if (create === null) return { ok: false, message: `${what} is not configured (ANTHROPIC_API_KEY is not set)` };

  let response: Anthropic.Message;
  try {
    response = await create(
      {
        model: CHAT_MODEL,
        max_tokens: MAX_TOKENS,
        thinking: { type: "adaptive" },
        system: args.system,
        messages: args.messages,
        output_config: { format: { type: "json_schema", schema: args.schema } },
      },
      { signal: args.signal, timeout: args.timeoutMs },
    );
  } catch (err) {
    return { ok: false, message: `${what} ${describeAnthropicError(err)}` };
  }

  // Both of these can yield non-conforming output even under a schema, so they are guarded
  // before anything is parsed.
  if (response.stop_reason === "refusal") return { ok: false, message: `${what} declined to answer` };
  if (response.stop_reason === "max_tokens") return { ok: false, message: `${what} ran past its length limit` };

  const unusable = { ok: false as const, message: `${what} replied with no usable verdict` };
  // Adaptive thinking usually puts a thinking block first, so find the text block, never index it.
  const text = response.content.find((block) => block.type === "text");
  if (text === undefined) return unusable;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.text);
  } catch {
    return unusable;
  }
  const verdict = args.validate(parsed);
  return verdict === null ? unusable : { ok: true, verdict };
}

export type CritiqueOutcome = Answer<CritiqueVerdict>;
export type ReviewOutcome = Answer<ReviewVerdict>;

export interface CritiqueInput {
  section: SourceSection;
  restatement: string;
  /** Earlier critiques of this page, oldest first; the client owns and sends them. */
  history?: readonly CritiqueTurn[];
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Test seam. The route never sets this. */
  create?: CreateMessage;
}

const DEFAULT_CRITIQUE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_REVIEW_TIMEOUT_MS = 10 * 60 * 1000;

export async function runCritique(input: CritiqueInput): Promise<CritiqueOutcome> {
  return ask({
    what: "the critique",
    create: input.create ?? clientCreate(),
    system: critiqueSystemPrompt(),
    messages: buildCritiqueMessages(input.section, input.restatement, input.history ?? []),
    schema: CRITIQUE_OUTPUT_SCHEMA,
    validate: validateCritiqueVerdict,
    timeoutMs: input.timeoutMs ?? DEFAULT_CRITIQUE_TIMEOUT_MS,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
}

export interface ReviewInput {
  specMarkdown: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Test seam. The route never sets this. */
  create?: CreateMessage;
}

export async function runReview(input: ReviewInput): Promise<ReviewOutcome> {
  return ask({
    what: "the review",
    create: input.create ?? clientCreate(),
    system: reviewSystemPrompt(),
    messages: [{ role: "user", content: reviewUserTurn(input.specMarkdown) }],
    schema: REVIEW_OUTPUT_SCHEMA,
    validate: validateReviewVerdict,
    timeoutMs: input.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
}

/** Becomes the SDK's per-request `timeout`, in milliseconds, which is the unit the
 *  TypeScript SDK already takes. */
export function timeoutMsFromEnv(env: Record<string, string | undefined>, fallbackMs: number): number {
  const raw = env.SPEC_RESTATE_TIMEOUT_MS;
  if (raw === undefined) return fallbackMs;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallbackMs;
}
