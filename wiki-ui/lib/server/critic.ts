/**
 * Server-only critic orchestration for the restatement studio: the prompts, the
 * critique/review runs (each with one --resume reinforcement retry when the reply's
 * trailing JSON is missing or invalid), and the SSE framing helper.
 */

import {
  runClaude,
  extractJson,
  validateCritiqueVerdict,
  validateReviewVerdict,
  type CritiqueVerdict,
  type ReviewVerdict,
  type RunClaudeResult,
} from "./claude-cli";

export interface SourceSection {
  title: string;
  markdown: string;
}

const CRITIQUE_JSON_SHAPE =
  '{"summary": "<one- or two-sentence overall judgement>", "gaps": ["<something missed, misunderstood, or distorted>", ...], "improvements": ["<a genuine improvement over the source>", ...]}';

const REVIEW_JSON_SHAPE =
  '{"summary": "<overall assessment, one or two sentences>", "notes": [{"title": "<short label>", "markdown": "<the finding, as markdown>", "severity": "minor" | "major" | "critical"}, ...]}';

export function critiqueFirstPrompt(sections: readonly SourceSection[], restatement: string): string {
  const source = sections.map((s) => `### ${s.title}\n\n${s.markdown.trim()}`).join("\n\n---\n\n");
  return [
    "You are the critic in a restatement studio. A spec document was drafted with AI help;",
    "a human has now restated part of it in their own words to prove they actually understand it.",
    "Your job is to judge that understanding — not the prose style.",
    "",
    "SOURCE SECTIONS (the original spec content being restated):",
    "",
    source,
    "",
    "THE HUMAN'S RESTATEMENT (they may restructure or merge sections):",
    "",
    restatement.trim(),
    "",
    "Critique the restatement against the source:",
    "- Decide whether it demonstrates real understanding, or is a reworded surface with the substance lost.",
    "- Identify concretely what was missed, misunderstood, or distorted: name the specific claim, constraint, or mechanism, and say what the source actually establishes. Quote short phrases from both texts where that sharpens a point.",
    "- Acknowledge genuine improvements on the source — tighter scope, better structure, corrected errors. Credit only real improvements; do not manufacture praise.",
    "- Be direct and specific. No flattery, no hedging.",
    "",
    "Reply in two parts, in this order:",
    "1. The critique itself, as readable markdown (it streams to the human as you write).",
    "2. At the very end, EXACTLY ONE JSON object on its own lines, no code fence, the only JSON object in the reply, matching:",
    CRITIQUE_JSON_SHAPE,
    "gaps = things the restatement missed, misunderstood, or distorted relative to the source sections; improvements = ways it genuinely improved on the source. Empty arrays are fine when nothing qualifies.",
  ].join("\n");
}

/** Round 2+ over --resume: the session already has the source, so only the new restatement is sent. */
export function critiqueFollowUpPrompt(restatement: string): string {
  return [
    "The human has revised their restatement. The source sections are unchanged from earlier in this session.",
    "Critique this new restatement fresh against that same source: what improved since your last critique, what still stands, and anything newly introduced that misses or distorts the source.",
    "Same reply format: readable markdown critique first, then at the very end EXACTLY ONE JSON object on its own lines, no code fence, matching:",
    CRITIQUE_JSON_SHAPE,
    "",
    "REVISED RESTATEMENT:",
    "",
    restatement.trim(),
  ].join("\n");
}

export function reviewPrompt(specMarkdown: string): string {
  return [
    "You are reviewing a complete specification document holistically.",
    "",
    "THE SPEC:",
    "",
    specMarkdown.trim(),
    "",
    "Assess the document as a whole, not section by section:",
    "- Coherence: do the sections tell one consistent story, with stable terminology throughout?",
    "- Contradictions: places where one section's claims conflict with another's.",
    "- Gaps between sections: hand-offs the document assumes but never specifies; questions a careful reader is left with.",
    "- Scope creep: content that drifts beyond the document's stated purpose.",
    "- Missing concerns: risks, constraints, or failure modes the spec never addresses.",
    "",
    "Be direct and specific; reference sections by their headings. No flattery.",
    "Reply in two parts, in this order:",
    "1. Your feedback as readable markdown.",
    "2. At the very end, EXACTLY ONE JSON object on its own lines, no code fence, the only JSON object in the reply, matching:",
    REVIEW_JSON_SHAPE,
    'severity: "critical" = the spec cannot be built correctly as written; "major" = significant risk of misbuilding; "minor" = worth fixing, not blocking.',
  ].join("\n");
}

function reinforcementPrompt(shape: string): string {
  return `Your previous reply did not end with a single valid JSON object of the required shape. Reply now with ONLY one JSON object matching ${shape} — no prose, no markdown, no code fences, nothing else.`;
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

export type CritiqueOutcome =
  | { ok: true; verdict: CritiqueVerdict; sessionId?: string }
  | { ok: false; message: string };

export async function runCritique(input: {
  sections: readonly SourceSection[];
  restatement: string;
  sessionId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}): Promise<CritiqueOutcome> {
  const prompt =
    input.sessionId !== undefined
      ? critiqueFollowUpPrompt(input.restatement)
      : critiqueFirstPrompt(input.sections, input.restatement);

  const first = await runClaude(prompt, {
    resumeSessionId: input.sessionId,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    onDelta: input.onDelta,
  });
  if (!first.success) return { ok: false, message: failureMessage("critique", first) };

  const verdict = tryVerdict(first.result, validateCritiqueVerdict);
  if (verdict !== null) return { ok: true, verdict, sessionId: first.sessionId };

  if (first.sessionId === undefined) {
    return { ok: false, message: "critique reply had no usable JSON verdict and no session to retry" };
  }
  // Retry is not streamed: it re-emits only the JSON, which the UI never renders.
  const retry = await runClaude(reinforcementPrompt(CRITIQUE_JSON_SHAPE), {
    resumeSessionId: first.sessionId,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
  if (!retry.success) return { ok: false, message: failureMessage("critique retry", retry) };
  const retried = tryVerdict(retry.result, validateCritiqueVerdict);
  if (retried !== null) return { ok: true, verdict: retried, sessionId: first.sessionId };
  return { ok: false, message: "critique reply had no usable JSON verdict after a retry" };
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

// ── route plumbing ──────────────────────────────────────────────────────────────

/** One SSE frame: a single `data:` line carrying the event as JSON (stringify keeps newlines escaped). */
export function sseData(event: object): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function timeoutMsFromEnv(env: Record<string, string | undefined>, fallbackMs: number): number {
  const raw = env.SPEC_RESTATE_TIMEOUT_MS;
  if (raw === undefined) return fallbackMs;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallbackMs;
}
