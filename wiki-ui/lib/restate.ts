"use client";

/**
 * Restatement-studio helpers (feature: spec-restatement studio). The pure pieces — the
 * `## `-heading draft splitter, the rendered-element splitter, the SSE frame decoder, and
 * the localStorage draft persistence — live here so they unit-test without a browser; the
 * fetch wrappers for the /api/restate routes (same-origin Next API, bearer-token attached,
 * 401 → notifyUnauthorized per app convention) sit alongside them.
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

// ── rendered-element splitting ──────────────────────────────────────────────────

export interface RenderedElement {
  /** The element's rendered heading text (e.g. "2. Title" / "Title (major)"); null when
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
 * or null when absent — used for the left column's Overview / Review summaries. Section
 * BODIES preserve authored H2s verbatim, so a duplicate heading can appear: `occurrence`
 * picks which match wins. The page renders overview → sections → review, so the real
 * Overview is the FIRST match and the real Review is the LAST.
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

// ── SSE frame decoding (the /api/restate/critique stream) ───────────────────────

export interface SseDecoder {
  /** Feed a chunk; returns the JSON payloads of every frame completed by it. */
  push(chunk: string): unknown[];
  /** Flush: parse a trailing frame the stream closed without terminating. */
  end(): unknown[];
}

/** Decode `data: <json>\n\n` SSE frames across arbitrary chunk boundaries. Non-`data`
 *  lines (comments, keepalives) and unparseable payloads are dropped. */
export function createSseDecoder(): SseDecoder {
  let buffer = "";
  const parseFrame = (frame: string): unknown => {
    const dataLines = frame.split("\n").filter((l) => l.startsWith("data:"));
    if (dataLines.length === 0) return undefined;
    const payload = dataLines.map((l) => l.slice(5).replace(/^ /, "")).join("\n");
    try {
      return JSON.parse(payload) as unknown;
    } catch {
      return undefined;
    }
  };
  const drain = (final: boolean): unknown[] => {
    const events: unknown[] = [];
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const ev = parseFrame(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
      if (ev !== undefined) events.push(ev);
    }
    if (final && buffer.trim() !== "") {
      const ev = parseFrame(buffer);
      buffer = "";
      if (ev !== undefined) events.push(ev);
    }
    return events;
  };
  return {
    push: (chunk) => {
      buffer += chunk.replace(/\r\n/g, "\n");
      return drain(false);
    },
    end: () => drain(true),
  };
}

export interface CritiqueVerdict {
  summary: string;
  gaps: string[];
  improvements: string[];
}

export type CritiqueEvent =
  | { type: "delta"; text: string }
  | { type: "verdict"; verdict: CritiqueVerdict; sessionId?: string }
  | { type: "error"; message: string };

function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : [];
}

/** Narrow one decoded SSE payload to a typed critique event; null for anything else. */
export function asCritiqueEvent(raw: unknown): CritiqueEvent | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.type === "delta" && typeof o.text === "string") return { type: "delta", text: o.text };
  if (o.type === "error" && typeof o.message === "string") return { type: "error", message: o.message };
  if (o.type === "verdict" && o.verdict !== null && typeof o.verdict === "object") {
    const v = o.verdict as Record<string, unknown>;
    if (typeof v.summary !== "string") return null;
    return {
      type: "verdict",
      verdict: { summary: v.summary, gaps: stringList(v.gaps), improvements: stringList(v.improvements) },
      ...(typeof o.sessionId === "string" ? { sessionId: o.sessionId } : {}),
    };
  }
  return null;
}

// ── draft persistence (localStorage, keyed by workspace + page) ─────────────────

/**
 * A critique session is only valid for the sources it was opened with (the server's
 * follow-up prompt asserts "source sections are unchanged"), so the session id always
 * travels with a key identifying those sources.
 */
export function sourceKeyOf(ids: readonly string[]): string {
  return [...ids].sort().join("\n");
}

/** The session id to `--resume` with, but ONLY when it was opened for exactly the current
 *  sources; any other selection starts a fresh session. */
export function resumableSession(
  session: { readonly id: string; readonly sourceKey: string } | undefined,
  currentKey: string,
): string | undefined {
  return session !== undefined && session.sourceKey === currentKey ? session.id : undefined;
}

export interface RestateDraft {
  readonly selectedIds: readonly string[];
  readonly draft: string;
  /** Present only as a PAIR with {@link RestateDraft.sourceKey}. */
  readonly sessionId?: string;
  /** The {@link sourceKeyOf} of the sections `sessionId` was opened with. */
  readonly sourceKey?: string;
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
    const selectedIds = stringList(p.selectedIds);
    const draft = typeof p.draft === "string" ? p.draft : "";
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : undefined;
    const sourceKey = typeof p.sourceKey === "string" ? p.sourceKey : undefined;
    // A session without its source key (or vice versa) cannot be validated against the
    // current selection — drop the pair rather than resume against unknown sources.
    const session = sessionId !== undefined && sourceKey !== undefined ? { sessionId, sourceKey } : null;
    if (selectedIds.length === 0 && draft === "" && session === null) return null;
    return { selectedIds, draft, ...(session ?? {}) };
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

/** Restored/held selection filtered against the CURRENT section list: an id survives only
 *  while it still exists AND is still ai-draft (verified/vanished sections drop out). */
export function pruneSelection(
  ids: readonly string[],
  elements: readonly { readonly id: string; readonly status?: string }[],
): string[] {
  const selectable = new Set(elements.filter((e) => e.status === "ai-draft").map((e) => e.id));
  return ids.filter((id) => selectable.has(id));
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

export type CritiqueResult = { ok: true; verdict: CritiqueVerdict; sessionId?: string } | { ok: false; message: string };

/**
 * POST /api/restate/critique and consume its SSE stream: `delta` frames reach `onDelta`
 * as they arrive; the terminal frame becomes the result. Never throws.
 */
export async function streamCritique(req: {
  sections: readonly DraftSection[];
  restatement: string;
  sessionId?: string;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}): Promise<CritiqueResult> {
  let res: Response;
  try {
    res = await fetch("/api/restate/critique", {
      method: "POST",
      headers: restateHeaders(true),
      body: JSON.stringify({
        sections: req.sections,
        restatement: req.restatement,
        ...(req.sessionId !== undefined ? { sessionId: req.sessionId } : {}),
      }),
      signal: req.signal,
    });
  } catch (e) {
    return { ok: false, message: req.signal?.aborted === true ? "critique cancelled" : errText(e) };
  }
  if (sawUnauthorized(res)) return { ok: false, message: "signed out (the critic route returned 401)" };
  if (!res.ok) return { ok: false, message: await errorFromBody(res, "critique") };
  if (res.body === null) return { ok: false, message: "critique stream had no body" };

  let verdict: CritiqueVerdict | null = null;
  let sessionId: string | undefined;
  let errorMessage: string | null = null;
  const handle = (raw: unknown): void => {
    const ev = asCritiqueEvent(raw);
    if (ev === null) return;
    if (ev.type === "delta") req.onDelta?.(ev.text);
    else if (ev.type === "verdict") {
      verdict = ev.verdict;
      sessionId = ev.sessionId;
    } else errorMessage = ev.message;
  };

  const reader = res.body.getReader();
  const text = new TextDecoder();
  const sse = createSseDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const raw of sse.push(text.decode(value, { stream: true }))) handle(raw);
    }
    for (const raw of sse.end()) handle(raw);
  } catch (e) {
    return { ok: false, message: req.signal?.aborted === true ? "critique cancelled" : errText(e) };
  }

  if (verdict !== null) {
    return { ok: true, verdict, ...(sessionId !== undefined ? { sessionId } : {}) };
  }
  return { ok: false, message: errorMessage ?? "critique stream ended without a verdict" };
}
