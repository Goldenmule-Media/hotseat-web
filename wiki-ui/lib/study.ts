"use client";

/**
 * Study-studio helpers (feature: study-notes studio). The pure pieces — glossary-term
 * occurrence matching, `**bold**` term-candidate extraction, note-context assembly for
 * the evaluator, and localStorage draft persistence — live here so they unit-test
 * without a browser; the fetch wrappers for the /api/study routes (same-origin Next API,
 * bearer-token attached, 401 → notifyUnauthorized per app convention) sit alongside.
 */
import { type CritiqueGrade, type KeyValueStore, type RestateHealth } from "./restate";
import { getToken, notifyUnauthorized } from "./auth";

/** The page type the studio serves (the only place the tag is spelled outside models). */
export const STUDY_PAGE_TYPE = "study-notes";

// ── glossary-term occurrence matching ───────────────────────────────────────────

export interface TermMatch {
  /** Match bounds in the searched text. */
  readonly start: number;
  readonly end: number;
  readonly termId: string;
}

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[\p{L}\p{N}]/u.test(c);
}

/**
 * Every non-overlapping occurrence of the glossary `terms` in `text`, case-insensitive,
 * whole-word (a match may not sit inside a longer word), tolerating a trailing plural
 * `s`/`es` in the text. A longer term outranks a shorter one starting at the same place
 * ("logit vector" wins over "logit"), and earlier matches win overlaps.
 */
export function findTermMatches(
  text: string,
  terms: readonly { readonly id: string; readonly term: string }[],
): TermMatch[] {
  const haystack = text.toLowerCase();
  // Longest first, so at any position the most specific term claims the span.
  const sorted = terms
    .map((t) => ({ id: t.id, needle: t.term.trim().toLowerCase() }))
    .filter((t) => t.needle.length > 0)
    .sort((a, b) => b.needle.length - a.needle.length);
  const matches: TermMatch[] = [];
  const claimed: boolean[] = new Array(text.length).fill(false);
  for (const { id, needle } of sorted) {
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      let end = at + needle.length;
      // Tolerate the text's plural of a singular term.
      if (haystack.startsWith("es", end) && !isWordChar(haystack[end + 2])) end += 2;
      else if (haystack.startsWith("s", end) && !isWordChar(haystack[end + 1])) end += 1;
      const wholeWord = !isWordChar(text[at - 1]) && !isWordChar(text[end]);
      const free = wholeWord && !claimed.slice(at, end).some(Boolean);
      if (free) {
        matches.push({ start: at, end, termId: id });
        for (let i = at; i < end; i++) claimed[i] = true;
      }
      from = at + 1;
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

// ── `**bold**` term candidates ──────────────────────────────────────────────────

const FENCE_RE = /^(```|~~~)/;
const BOLD_RE = /\*\*([^*\n]+?)\*\*/g;

/**
 * The distinct `**bold**` runs of a note body, in order of first appearance — the
 * learner's existing habit of bolding terms makes these one-click glossary candidates.
 * Fence-aware; runs already in the glossary (case-insensitive) are dropped, as is
 * anything too long to be a term.
 */
export function boldCandidates(markdown: string, existingTerms: readonly string[]): string[] {
  const existing = new Set(existingTerms.map((t) => t.trim().toLowerCase()));
  const seen = new Set<string>();
  const out: string[] = [];
  let inFence = false;
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (FENCE_RE.test(line)) inFence = !inFence;
    if (inFence) continue;
    for (const m of line.matchAll(BOLD_RE)) {
      const term = m[1]!.trim().replace(/[.,:;]+$/, "");
      const key = term.toLowerCase();
      if (term.length === 0 || term.length > 60) continue;
      if (existing.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push(term);
    }
  }
  return out;
}

// ── rendered-term parsing / verdict recording ───────────────────────────────────

/** The rendered feedback part's label line, as the glossary render config emits it. */
const CRITIQUE_LABEL = "**Critique:**";

/**
 * A term's DEFINITION markdown from its rendered element body: everything before the
 * `**Critique:** …` part the render appends for an evaluated term.
 */
export function definitionFromBody(body: string): string {
  const at = body.indexOf(CRITIQUE_LABEL);
  return (at === -1 ? body : body.slice(0, at)).trim();
}

/** The stored critique markdown of a rendered term body, or null when never evaluated. */
export function feedbackFromBody(body: string): string | null {
  const at = body.indexOf(CRITIQUE_LABEL);
  if (at === -1) return null;
  const text = body.slice(at + CRITIQUE_LABEL.length).trim();
  return text === "" ? null : text;
}

// ── the evaluation verdict (bullets + a suggested definition) ───────────────────

export interface StudyVerdict {
  readonly grade: CritiqueGrade;
  /** The verdict itself: terse bullet fragments, most damaging first. */
  readonly points: string[];
  /** The definition as it should have been written; shown blurred until clicked. */
  readonly suggestion: string | null;
}

function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string" && s.trim() !== "") : [];
}

/** Narrow a route payload to a verdict; tolerates the legacy summary/gaps shape. */
export function asStudyVerdict(raw: unknown): StudyVerdict | null {
  if (raw === null || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const grade = v.grade === "understood" || v.grade === "surface" ? v.grade : "partial";
  let points = stringList(v.points);
  if (points.length === 0) {
    points = [...(typeof v.summary === "string" && v.summary.trim() !== "" ? [v.summary] : []), ...stringList(v.gaps)];
  }
  const suggestion = typeof v.suggestion === "string" && v.suggestion.trim() !== "" ? v.suggestion.trim() : null;
  if (points.length === 0 && suggestion === null) return null;
  return { grade, points, suggestion };
}

/** The suggestion's label line, as {@link evaluationFeedbackMarkdown} stores it. */
const SUGGESTION_LABEL = "**Suggestion:**";

/** The verdict as the Markdown `recordEvaluation` stores — bullets, then the suggestion. */
export function evaluationFeedbackMarkdown(verdict: StudyVerdict): string {
  const parts: string[] = [];
  if (verdict.points.length > 0) parts.push(verdict.points.map((p) => `- ${p.trim()}`).join("\n"));
  if (verdict.suggestion !== null) parts.push(`${SUGGESTION_LABEL} ${verdict.suggestion}`);
  return parts.join("\n\n");
}

/** Split stored feedback back apart: the verdict body, and the suggestion (blurred in the
 *  UI). Feedback stored before suggestions existed parses as body-only. */
export function parseEvaluationFeedback(md: string): { body: string; suggestion: string | null } {
  const at = md.indexOf(SUGGESTION_LABEL);
  if (at === -1) return { body: md.trim(), suggestion: null };
  const suggestion = md.slice(at + SUGGESTION_LABEL.length).trim();
  return { body: md.slice(0, at).trim(), suggestion: suggestion === "" ? null : suggestion };
}

// ── glossary parsing + filtering (the rail's filter box) ────────────────────────

export interface GlossaryEntry {
  readonly term: string;
  readonly definition: string;
}

/** Exactly an H3 (`### `, not `####`), capturing the heading text. */
const H3_RE = /^###(?!#)\s+(.*?)\s*$/;

/**
 * Parse the rendered `## Glossary` slice into `[{term, definition}]` — one entry per
 * `### Term` chunk, the definition stripped of the appended critique and of the empty
 * placeholder. Fence-aware. Lets the filter search definitions without a fetch per term.
 */
export function glossaryEntries(glossaryMd: string): GlossaryEntry[] {
  const out: GlossaryEntry[] = [];
  let term: string | null = null;
  let buf: string[] = [];
  let inFence = false;
  const flush = (): void => {
    if (term !== null) {
      const body = definitionFromBody(buf.join("\n").trim());
      out.push({ term, definition: body === "_None._" ? "" : body });
    }
    buf = [];
  };
  for (const line of glossaryMd.replace(/\r\n/g, "\n").split("\n")) {
    if (FENCE_RE.test(line)) inFence = !inFence;
    const m = inFence ? null : H3_RE.exec(line);
    if (m !== null) {
      flush();
      term = m[1]!.trim();
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

/**
 * A term's relevance to a filter query: 0 = name starts with it, 1 = name contains it,
 * 2 = only the definition contains it, null = no match. Case-insensitive. Sorting by
 * this rank (then name) puts name matches first, as a filter should.
 */
export function termFilterRank(query: string, name: string, definition: string): number | null {
  const q = query.trim().toLowerCase();
  if (q === "") return 1;
  const n = name.toLowerCase();
  if (n.startsWith(q)) return 0;
  if (n.includes(q)) return 1;
  return definition.toLowerCase().includes(q) ? 2 : null;
}

// ── note context for the evaluator ──────────────────────────────────────────────

/**
 * The lines of the notes where `term` appears, grouped under their note titles — what
 * grounds the critic in what the source actually taught. Fence lines are kept (a term
 * may appear in code). Capped so a hot term cannot blow up the prompt.
 */
export function termContext(
  notes: readonly { readonly title: string; readonly markdown: string }[],
  term: string,
  maxChars = 2000,
): string {
  const probe = [{ id: "x", term }];
  const parts: string[] = [];
  for (const note of notes) {
    const lines = note.markdown
      .replace(/\r\n/g, "\n")
      .split("\n")
      .filter((line) => findTermMatches(line, probe).length > 0);
    if (lines.length > 0) parts.push(`## ${note.title}\n${lines.join("\n")}`);
  }
  const joined = parts.join("\n\n");
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}\n…` : joined;
}

// ── draft persistence (localStorage, keyed by workspace + page) ─────────────────

export type StudySelection =
  | { readonly kind: "note"; readonly id: string }
  | { readonly kind: "term"; readonly id: string }
  | { readonly kind: "new-note"; readonly afterId: string | null };

export interface StudyDraft {
  readonly selected?: StudySelection;
  /** Editor text per NOTE id (plus the "" key for a new-note draft). */
  readonly noteDrafts: Readonly<Record<string, string>>;
  /** Definition text per TERM id. */
  readonly termDrafts: Readonly<Record<string, string>>;
}

function stringRecord(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
  return out;
}

export function studyStorageKey(workspaceId: string, pageId: string): string {
  return `wiki.study.${workspaceId}.${pageId}`;
}

export function saveStudyDraft(store: KeyValueStore, workspaceId: string, pageId: string, state: StudyDraft): void {
  try {
    store.setItem(studyStorageKey(workspaceId, pageId), JSON.stringify(state));
  } catch {
    // storage blocked — the draft simply won't survive a reload
  }
}

function asSelection(raw: unknown): StudySelection | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const s = raw as Record<string, unknown>;
  if (s.kind === "note" && typeof s.id === "string") return { kind: "note", id: s.id };
  if (s.kind === "term" && typeof s.id === "string") return { kind: "term", id: s.id };
  if (s.kind === "new-note") return { kind: "new-note", afterId: typeof s.afterId === "string" ? s.afterId : null };
  return undefined;
}

export function loadStudyDraft(store: KeyValueStore, workspaceId: string, pageId: string): StudyDraft | null {
  try {
    const raw = store.getItem(studyStorageKey(workspaceId, pageId));
    if (raw === null) return null;
    const p = JSON.parse(raw) as Record<string, unknown> | null;
    if (p === null || typeof p !== "object") return null;
    const selected = asSelection(p.selected);
    const noteDrafts = stringRecord(p.noteDrafts);
    const termDrafts = stringRecord(p.termDrafts);
    if (selected === undefined && Object.keys(noteDrafts).length === 0 && Object.keys(termDrafts).length === 0) return null;
    return { ...(selected !== undefined ? { selected } : {}), noteDrafts, termDrafts };
  } catch {
    return null;
  }
}

export function clearStudyDraft(store: KeyValueStore, workspaceId: string, pageId: string): void {
  try {
    store.removeItem(studyStorageKey(workspaceId, pageId));
  } catch {
    // nothing to clear if storage is blocked
  }
}

// ── /api/study fetch wrappers (same-origin; bearer attached; 401 → sign-out) ────

function studyHeaders(json: boolean): Headers {
  const headers = new Headers();
  const token = getToken();
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  if (json) headers.set("content-type", "application/json");
  return headers;
}

function sawUnauthorized(res: Response): boolean {
  if (res.status !== 401) return false;
  notifyUnauthorized();
  return true;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function errorFromBody(res: Response, what: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // non-JSON error body — fall through to the status message
  }
  return `${what} failed (HTTP ${res.status})`;
}

export async function fetchStudyHealth(): Promise<RestateHealth> {
  try {
    const res = await fetch("/api/study/health", { headers: studyHeaders(false) });
    if (sawUnauthorized(res)) return { available: false, reason: "signed out (the evaluator route returned 401)" };
    if (!res.ok) return { available: false, reason: `health probe failed (HTTP ${res.status})` };
    const body = (await res.json()) as { available?: unknown; reason?: unknown };
    return {
      available: body.available === true,
      ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
    };
  } catch (e) {
    return { available: false, reason: errText(e) };
  }
}

export type EvaluationResult = { ok: true; verdict: StudyVerdict } | { ok: false; message: string };

/** POST /api/study/evaluate. One JSON verdict, nothing streamed. Never throws. */
export async function requestEvaluation(req: {
  term: string;
  definition: string;
  context?: string;
  subject?: string;
  signal?: AbortSignal;
}): Promise<EvaluationResult> {
  let res: Response;
  try {
    res = await fetch("/api/study/evaluate", {
      method: "POST",
      headers: studyHeaders(true),
      body: JSON.stringify({
        term: req.term,
        definition: req.definition,
        ...(req.context !== undefined && req.context !== "" ? { context: req.context } : {}),
        ...(req.subject !== undefined && req.subject !== "" ? { subject: req.subject } : {}),
      }),
      signal: req.signal,
    });
  } catch (e) {
    return { ok: false, message: req.signal?.aborted === true ? "evaluation cancelled" : errText(e) };
  }
  if (sawUnauthorized(res)) return { ok: false, message: "signed out (the evaluator route returned 401)" };
  if (!res.ok) return { ok: false, message: await errorFromBody(res, "evaluation") };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, message: "evaluation returned a non-JSON body" };
  }
  const obj = body === null || typeof body !== "object" ? {} : (body as Record<string, unknown>);
  const verdict = asStudyVerdict(obj.verdict);
  if (verdict === null) return { ok: false, message: "evaluation returned an unusable verdict" };
  return { ok: true, verdict };
}
