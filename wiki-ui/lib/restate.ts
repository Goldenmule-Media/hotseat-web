"use client";

/**
 * Restatement-studio helpers (feature: spec-restatement studio). The pure pieces — the
 * `## `-heading draft splitter, the rendered-element splitter and the localStorage draft
 * persistence — live here so they unit-test without a browser; the fetch wrappers for the
 * /api/restate routes (same-origin Next API, bearer-token attached, 401 → notifyUnauthorized
 * per app convention) sit alongside them.
 */
import { getToken, notifyUnauthorized } from "./auth";

/** The page type the studio serves (the only place the tag is spelled outside models). */
export const RESTATE_PAGE_TYPE = "spec-restatement";

// ── draft splitting (`## ` top-level headings → sections) ───────────────────────

export interface DraftSection {
  title: string;
  markdown: string;
}

/** A line that opens/closes a fenced code block (H2 detection must skip fenced content). */
const FENCE_RE = /^(```|~~~)/;
/** Exactly an H2 (`## `, not `###`), capturing the heading text. */
const H2_RE = /^##(?!#)\s+(.*?)\s*$/;

/**
 * Split a restatement draft into `[{title, markdown}]` on top-level `## ` headings:
 * each heading starts a section (title = heading text, body = content under it). A draft
 * with NO `## ` headings — or content before the first one — becomes a section titled
 * `fallbackTitle` (by convention, the first selected source section's title). Headings
 * inside fenced code blocks do not split. An empty draft yields no sections.
 */
export function splitDraft(draft: string, fallbackTitle: string): DraftSection[] {
  const text = draft.replace(/\r\n/g, "\n").trim();
  if (text === "") return [];
  const sections: DraftSection[] = [];
  let title: string | null = null; // null = the run before the first heading
  let buf: string[] = [];
  let inFence = false;
  const flush = (): void => {
    const body = buf.join("\n").trim();
    buf = [];
    if (title === null) {
      if (body !== "") sections.push({ title: fallbackTitle, markdown: body });
    } else {
      sections.push({ title, markdown: body });
    }
  };
  for (const line of text.split("\n")) {
    if (FENCE_RE.test(line)) inFence = !inFence;
    const m = inFence ? null : H2_RE.exec(line);
    if (m !== null) {
      flush();
      title = m[1].replace(/\s+#+$/, "").trim(); // tolerate ATX closing hashes
      continue;
    }
    buf.push(line);
  }
  flush();
  return sections;
}

/**
 * Inverse of {@link splitDraft}, for populating the editor from selected sections: one
 * `## {title}` block per section (blank line before a non-empty body), blank-line
 * separated, in the given order. Contract: `splitDraft(assembleDraft(xs), any)` yields
 * the same title/markdown pairs (bodies trimmed).
 */
export function assembleDraft(sections: readonly { title: string; body: string }[]): string {
  return sections
    .map((s) => (s.body.trim() === "" ? `## ${s.title}` : `## ${s.title}\n\n${s.body.trim()}`))
    .join("\n\n");
}

// ── block-boundary splitting (the left panel's Split affordance) ────────────────

/**
 * A section body's top-level blocks — the blank-line-separated chunks the engine's
 * `parseBlocks` sees — so a section can only ever be cut at a real block boundary.
 * Fence-aware: blank lines inside a ``` block never split.
 */
export function splitTopLevelBlocks(md: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let inFence = false;
  const flush = (): void => {
    const chunk = buf.join("\n").trim();
    buf = [];
    if (chunk !== "") out.push(chunk);
  };
  for (const line of md.replace(/\r\n/g, "\n").split("\n")) {
    if (FENCE_RE.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === "") {
      flush();
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

export interface SectionSplit {
  readonly topMarkdown: string;
  readonly bottomMarkdown: string;
  readonly newTitle: string;
}

/**
 * `splitSection` args for cutting `chunks` before index `at`, or null when that is not a
 * real boundary. The new section takes its title from a heading opening the bottom half
 * (that line is consumed — it BECOMES the title), else `"{title} (cont.)"`.
 */
export function sectionSplitAt(chunks: readonly string[], at: number, title: string): SectionSplit | null {
  if (at < 1 || at >= chunks.length) return null;
  const bottom = chunks.slice(at);
  const head = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(bottom[0] ?? "");
  // Only consume the heading when something follows it — never leave an empty section.
  const consume = head !== null && bottom.length > 1;
  return {
    topMarkdown: chunks.slice(0, at).join("\n\n"),
    bottomMarkdown: (consume ? bottom.slice(1) : bottom).join("\n\n"),
    newTitle: head !== null ? head[1]!.trim() : `${title} (cont.)`,
  };
}

// ── rendered-element splitting ──────────────────────────────────────────────────

export interface RenderedElement {
  /** The element's rendered heading text (e.g. "Title" / "Title (major)"); null when
   *  the render did not start with a heading. */
  heading: string | null;
  /** The rendered body with the heading line removed. */
  body: string;
}

/** Split one `renderElement` result into its heading line and the body under it. */
export function splitRenderedElement(md: string): RenderedElement {
  const text = md.replace(/\r\n/g, "\n").trim();
  const nl = text.indexOf("\n");
  const first = nl === -1 ? text : text.slice(0, nl);
  const m = /^#{1,6}\s+(.*?)\s*$/.exec(first);
  if (m === null) return { heading: null, body: text };
  return { heading: m[1], body: (nl === -1 ? "" : text.slice(nl + 1)).trim() };
}

export type NoteSeverity = "minor" | "major" | "critical";

/** A review-note's severity off its rendered heading ("{title} ({severity})"). */
export function severityFromHeading(heading: string | null): NoteSeverity | null {
  if (heading === null) return null;
  const m = /\((minor|major|critical)\)\s*$/.exec(heading);
  return m === null ? null : (m[1] as NoteSeverity);
}

/**
 * The body of one top-level `## {heading}` section of a full page render (fence-aware),
 * or null when absent — used for the workbench's Review summary. Section BODIES preserve
 * authored H2s verbatim, so a duplicate heading can appear: `occurrence` picks which
 * match wins. The page renders sections → review, so the real Review is the LAST match.
 */
export function sliceH2Section(md: string, heading: string, occurrence: "first" | "last" = "first"): string | null {
  let inFence = false;
  const bodies: string[] = [];
  let buf: string[] | null = null;
  for (const line of md.replace(/\r\n/g, "\n").split("\n")) {
    if (FENCE_RE.test(line)) inFence = !inFence;
    const m = inFence ? null : H2_RE.exec(line);
    if (m !== null) {
      if (buf !== null) bodies.push(buf.join("\n").trim());
      buf = m[1].trim() === heading ? [] : null;
      continue;
    }
    if (buf !== null) buf.push(line);
  }
  if (buf !== null) bodies.push(buf.join("\n").trim());
  if (bodies.length === 0) return null;
  return occurrence === "last" ? bodies[bodies.length - 1] : bodies[0];
}

// ── the critique verdict (the critic's only output) ─────────────────────────────

/** "understood" = the mechanism is theirs; "partial" = right shape, something real
 *  missed; "surface" = reworded, substance lost. */
export type CritiqueGrade = "understood" | "partial" | "surface";

export interface CritiqueVerdict {
  grade: CritiqueGrade;
  summary: string;
  gaps: string[];
  improvements: string[];
}

function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : [];
}

function coerceGrade(raw: unknown): CritiqueGrade {
  return raw === "understood" || raw === "surface" ? raw : "partial";
}

/** Narrow a route payload to a verdict; null when there is no usable summary. */
export function asCritiqueVerdict(raw: unknown): CritiqueVerdict | null {
  if (raw === null || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.summary !== "string" || v.summary.trim() === "") return null;
  return {
    grade: coerceGrade(v.grade),
    summary: v.summary,
    gaps: stringList(v.gaps),
    improvements: stringList(v.improvements),
  };
}

// ── draft persistence (localStorage, keyed by workspace + page) ─────────────────

export interface RestateDraft {
  /** The section being restated, if any — the studio selects exactly one at a time. */
  readonly selectedId?: string;
  /** Editor text per SECTION id: each section keeps its own draft, so re-selecting one
   *  restores what was typed there. An empty string is a real entry (a deliberately
   *  cleared box) — not "unseeded". */
  readonly drafts: Readonly<Record<string, string>>;
}

function stringRecord(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
  return out;
}

/** The minimal Storage surface, injectable so the round-trip unit-tests in node. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function restateStorageKey(workspaceId: string, pageId: string): string {
  return `wiki.restate.${workspaceId}.${pageId}`;
}

export function saveRestateDraft(store: KeyValueStore, workspaceId: string, pageId: string, state: RestateDraft): void {
  try {
    store.setItem(restateStorageKey(workspaceId, pageId), JSON.stringify(state));
  } catch {
    // storage blocked — the draft simply won't survive a reload
  }
}

export function loadRestateDraft(store: KeyValueStore, workspaceId: string, pageId: string): RestateDraft | null {
  try {
    const raw = store.getItem(restateStorageKey(workspaceId, pageId));
    if (raw === null) return null;
    const p = JSON.parse(raw) as Record<string, unknown> | null;
    if (p === null || typeof p !== "object") return null;
    // Multi-select payloads selected several sections and keyed drafts by a newline-joined
    // id SET; only their single-section entries carry over.
    const legacy = stringList(p.selectedIds);
    const selectedId = typeof p.selectedId === "string" ? p.selectedId : legacy.length > 0 ? legacy[0] : undefined;
    const drafts: Record<string, string> = {};
    for (const [id, text] of Object.entries(stringRecord(p.drafts))) if (!id.includes("\n")) drafts[id] = text;
    if (typeof p.draft === "string" && p.draft !== "" && legacy.length === 1 && drafts[legacy[0]] === undefined) {
      drafts[legacy[0]] = p.draft; // older still: one flat draft for the stored selection
    }
    // `sessionId` / `sessions` / `sourceKey` are from the claude-CLI era, when a resumable
    // session carried the critic's context. The critic is stateless now and its history
    // lives with the verdicts, so a persisted session id is dead weight — dropped in silence.
    if (selectedId === undefined && Object.keys(drafts).length === 0) return null;
    return {
      ...(selectedId !== undefined ? { selectedId } : {}),
      drafts,
    };
  } catch {
    return null;
  }
}

export function clearRestateDraft(store: KeyValueStore, workspaceId: string, pageId: string): void {
  try {
    store.removeItem(restateStorageKey(workspaceId, pageId));
  } catch {
    // nothing to clear if storage is blocked
  }
}

/** Whether an id can still be opened in the editor: it exists. Status does not enter into
 *  it — an accepted section is edited through the same commit that restates a draft one, so
 *  only a section that was replaced or deleted drops a held or restored selection. */
export function isEditable(
  id: string | null,
  elements: readonly { readonly id: string }[],
): boolean {
  return id !== null && elements.some((e) => e.id === id);
}

/**
 * Per-section state (drafts, critique verdicts) filtered against the CURRENT section
 * list: an entry survives while its section still exists. Verified sections keep theirs
 * (unaccept puts the draft back within reach); only replaced/deleted sections drop one.
 */
export function pruneBySection<T>(
  bySection: Readonly<Record<string, T>>,
  elements: readonly { readonly id: string }[],
): Record<string, T> {
  const live = new Set(elements.map((e) => e.id));
  const out: Record<string, T> = {};
  for (const [id, value] of Object.entries(bySection)) if (live.has(id)) out[id] = value;
  return out;
}

// ── /api/restate fetch wrappers (same-origin; bearer attached; 401 → sign-out) ──

export interface RestateHealth {
  readonly available: boolean;
  readonly reason?: string;
}

function restateHeaders(json: boolean): Headers {
  const headers = new Headers();
  const token = getToken();
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  if (json) headers.set("content-type", "application/json");
  return headers;
}

/** A 401 from any /api/restate route follows the app's convention: broadcast it so the
 *  AuthProvider clears the dead token and falls back to the login page. */
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

export async function fetchRestateHealth(): Promise<RestateHealth> {
  try {
    const res = await fetch("/api/restate/health", { headers: restateHeaders(false) });
    if (sawUnauthorized(res)) return { available: false, reason: "signed out (the critic route returned 401)" };
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

export interface ReviewNoteDTO {
  title: string;
  markdown: string;
  severity: NoteSeverity;
}

export interface ReviewVerdictDTO {
  summary: string;
  notes: ReviewNoteDTO[];
}

export type ReviewResult = { ok: true; verdict: ReviewVerdictDTO } | { ok: false; message: string };

function coerceSeverity(raw: unknown): NoteSeverity {
  return raw === "major" || raw === "critical" ? raw : "minor";
}

/** POST /api/restate/review. Resolves a failure result — never throws — so the caller's
 *  ordering guarantee (no mutate unless the route succeeded) stays a one-liner. */
export async function requestReview(specMarkdown: string, signal?: AbortSignal): Promise<ReviewResult> {
  let res: Response;
  try {
    res = await fetch("/api/restate/review", {
      method: "POST",
      headers: restateHeaders(true),
      body: JSON.stringify({ specMarkdown }),
      signal,
    });
  } catch (e) {
    return { ok: false, message: signal?.aborted === true ? "review cancelled" : errText(e) };
  }
  if (sawUnauthorized(res)) return { ok: false, message: "signed out (the review route returned 401)" };
  if (!res.ok) return { ok: false, message: await errorFromBody(res, "review") };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, message: "review returned a non-JSON body" };
  }
  if (body === null || typeof body !== "object") return { ok: false, message: "review returned an unusable verdict" };
  const obj = body as Record<string, unknown>;
  if (typeof obj.summary !== "string") return { ok: false, message: "review verdict had no summary" };
  const notes: ReviewNoteDTO[] = [];
  if (Array.isArray(obj.notes)) {
    for (const entry of obj.notes) {
      if (entry === null || typeof entry !== "object") continue;
      const n = entry as Record<string, unknown>;
      if (typeof n.title !== "string" || typeof n.markdown !== "string") continue;
      notes.push({ title: n.title, markdown: n.markdown, severity: coerceSeverity(n.severity) });
    }
  }
  return { ok: true, verdict: { summary: obj.summary, notes } };
}

export type CritiqueResult = { ok: true; verdict: CritiqueVerdict } | { ok: false; message: string };

/** One completed critique, kept by the studio and sent back as context on the next one.
 *  The critic is stateless, so this history is the whole of what it remembers. */
export interface CritiqueTurn {
  readonly section: DraftSection;
  readonly restatement: string;
  readonly verdict: CritiqueVerdict;
}

/**
 * POST /api/restate/critique. The critic replies with one JSON verdict and nothing else,
 * so there is nothing to stream — this is a plain request. Never throws.
 */
export async function requestCritique(req: {
  section: DraftSection;
  restatement: string;
  /** Earlier critiques of this page, oldest first — the route assigns the roles. */
  history?: readonly CritiqueTurn[];
  signal?: AbortSignal;
}): Promise<CritiqueResult> {
  let res: Response;
  try {
    res = await fetch("/api/restate/critique", {
      method: "POST",
      headers: restateHeaders(true),
      body: JSON.stringify({
        section: req.section,
        restatement: req.restatement,
        history: req.history ?? [],
      }),
      signal: req.signal,
    });
  } catch (e) {
    return { ok: false, message: req.signal?.aborted === true ? "critique cancelled" : errText(e) };
  }
  if (sawUnauthorized(res)) return { ok: false, message: "signed out (the critic route returned 401)" };
  if (!res.ok) return { ok: false, message: await errorFromBody(res, "critique") };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, message: "critique returned a non-JSON body" };
  }
  const obj = body === null || typeof body !== "object" ? {} : (body as Record<string, unknown>);
  const verdict = asCritiqueVerdict(obj.verdict);
  if (verdict === null) return { ok: false, message: "critique returned an unusable verdict" };
  return { ok: true, verdict };
}
