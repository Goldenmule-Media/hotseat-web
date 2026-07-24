"use client";

/**
 * The Restatement Studio (feature: spec-restatement studio) — the browser UI for
 * `spec-restatement` pages. Two columns: the LEFT renders the spec per section
 * (renderElement → HTML) styled by provenance (ai-draft vs human-verified), where you
 * pick ONE AI-drafted section at a time; the RIGHT is the workbench driven by page
 * status — restate that section in your own markdown (Edit/Preview tabs over one draft,
 * the editor filling the viewport's leftover height), optionally stream an AI critique
 * (/api/restate/critique), Accept to atomically REPLACE it via `restateSections` (born
 * human-verified), then run the holistic review (/api/restate/review →
 * `recordHolisticReview`) and resolve notes. Page transitions (approve, reopen…) stay in
 * the existing Model view — the studio only points at them.
 *
 * Everything the workbench holds is keyed BY SECTION and outlives the selection: drafts
 * (seeded from the section's current markdown on first select, then persisted per
 * workspace+page in localStorage) and critiques — so a critique keeps streaming while you
 * move on to another section, its card badges "Critique ready" when it lands, and
 * selecting that section re-opens its panel. Per-section state is dropped when the
 * section stops being restatable underneath you (verified, replaced, deleted).
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PageId, WorkspaceId } from "wiki";
import { getHost } from "../lib/host-client";
import {
  useElementMarkdown,
  usePageMutator,
  useSectionElements,
  type SectionElementSummary,
} from "../lib/live";
import { renderMarkdown } from "../lib/markdown";
import {
  assembleDraft,
  clearRestateDraft,
  isRestatable,
  loadRestateDraft,
  fetchRestateHealth,
  pruneBySection,
  requestReview,
  saveRestateDraft,
  severityFromHeading,
  sliceH2Section,
  splitDraft,
  splitRenderedElement,
  streamCritique,
  type CritiqueVerdict,
  type KeyValueStore,
  type RestateHealth,
} from "../lib/restate";
import { clampSplit, DEFAULT_SPLIT, loadSplit, saveSplit } from "../lib/restate-split";
import { pageHref } from "../lib/routes";

const SECTIONS_KEY = "sections";
const REVIEW_KEY = "review";

function browserStore(): KeyValueStore | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null; // storage blocked — drafts just won't persist
  }
}

function titleOf(el: SectionElementSummary | undefined): string {
  return el?.title ?? el?.id ?? "Restated section";
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function omit<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

// ── per-section critique state ──────────────────────────────────────────────────

interface CritiqueState {
  readonly streaming: boolean;
  readonly text: string;
  readonly verdict: CritiqueVerdict | null;
  readonly error: string | null;
  /** Resume id for a follow-up round on this same section. */
  readonly sessionId?: string;
  /** Landed while you were elsewhere — the section's card says so until you open it. */
  readonly unread: boolean;
}

const CRITIQUE_IDLE: CritiqueState = { streaming: false, text: "", verdict: null, error: null, unread: false };

/** What a section's card shows about its critique; null = nothing worth saying. */
type CritiqueTag = "streaming" | "ready" | "seen" | "failed";

const CRITIQUE_TAG_LABEL: Record<CritiqueTag, string> = {
  streaming: "Critiquing…",
  ready: "Critique ready",
  seen: "Critiqued",
  failed: "Critique failed",
};

function critiqueTag(c: CritiqueState | undefined): CritiqueTag | null {
  if (c === undefined) return null;
  if (c.streaming) return "streaming";
  if (c.error !== null) return "failed";
  if (c.verdict === null) return null;
  return c.unread ? "ready" : "seen";
}

// ── left column: one spec section, rendered + selectable ────────────────────────

function SectionCard({
  workspaceId,
  pageId,
  el,
  selectable,
  selected,
  onToggle,
  critique,
  action,
}: {
  workspaceId: WorkspaceId;
  pageId: PageId;
  el: SectionElementSummary;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
  /** This section's critique state, badged so you needn't open it to know. */
  critique: CritiqueTag | null;
  /** Per-card quick action ("Accept as-is" / "Unaccept"); null hides it. */
  action: { label: string; busy: boolean; onRun: () => void } | null;
}): React.JSX.Element {
  const { markdown, loading, error } = useElementMarkdown(workspaceId, pageId, SECTIONS_KEY, el.id);
  const html = useMemo(() => (markdown === null ? "" : renderMarkdown(markdown, workspaceId)), [markdown, workspaceId]);
  const verified = el.status === "human-verified";
  const classes = [
    "restate-section",
    verified ? "restate-section-verified" : "restate-section-ai",
    selected ? "is-selected" : "",
    selectable ? "is-selectable" : "",
  ]
    .filter((c) => c !== "")
    .join(" ");
  return (
    <div
      className={classes}
      data-el-id={el.id}
      onClick={(e) => {
        if (!selectable) return;
        // Links/controls inside the rendered body keep their own behaviour.
        if ((e.target as HTMLElement).closest("a, button, input, label") !== null) return;
        onToggle();
      }}
    >
      <div className="restate-section-head">
        {selectable ? (
          <button
            type="button"
            className="restate-select"
            aria-pressed={selected}
            aria-label={`Restate "${titleOf(el)}"`}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            {selected ? "Restating" : "Restate"}
          </button>
        ) : (
          <span aria-hidden="true" />
        )}
        <span className="restate-card-side">
          {critique !== null && (
            <span className={`restate-badge restate-badge-${critique}`}>{CRITIQUE_TAG_LABEL[critique]}</span>
          )}
          {action !== null && (
            <button
              type="button"
              className="restate-card-btn"
              disabled={action.busy}
              onClick={(e) => {
                e.stopPropagation(); // quick action, never a selection toggle
                action.onRun();
              }}
            >
              {action.label}
            </button>
          )}
          <span className={`restate-badge ${verified ? "restate-badge-verified" : "restate-badge-ai"}`}>
            {verified ? "Human-verified" : "AI draft"}
          </span>
        </span>
      </div>
      {error !== null ? (
        <p className="error">{error}</p>
      ) : markdown === null && loading ? (
        <p className="muted">Loading section…</p>
      ) : (
        /* eslint-disable-next-line react/no-danger */
        <div className="markdown restate-section-body" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}

// ── right column: one review note ───────────────────────────────────────────────

function NoteCard({
  workspaceId,
  pageId,
  note,
  resolving,
  onResolve,
}: {
  workspaceId: WorkspaceId;
  pageId: PageId;
  note: SectionElementSummary;
  resolving: boolean;
  onResolve: (noteId: string, resolution: string) => void;
}): React.JSX.Element {
  const { markdown } = useElementMarkdown(workspaceId, pageId, REVIEW_KEY, note.id);
  const parsed = useMemo(() => (markdown === null ? null : splitRenderedElement(markdown)), [markdown]);
  const severity = severityFromHeading(parsed?.heading ?? null);
  const bodyHtml = useMemo(
    () => (parsed === null ? "" : renderMarkdown(parsed.body, workspaceId)),
    [parsed, workspaceId],
  );
  const [resolution, setResolution] = useState("");

  if (note.status !== "open") {
    return (
      <details className="restate-note restate-note-resolved">
        <summary>
          {titleOf(note)} <span className="restate-badge restate-badge-resolved">resolved</span>
        </summary>
        {/* eslint-disable-next-line react/no-danger */}
        <div className="markdown restate-note-body" dangerouslySetInnerHTML={{ __html: bodyHtml }} />
      </details>
    );
  }
  return (
    <div className={`restate-note restate-note-open restate-note-${severity ?? "minor"}`}>
      <div className="restate-note-head">
        <strong className="restate-note-title">{titleOf(note)}</strong>
        <span className={`restate-badge restate-badge-${severity ?? "minor"}`}>{severity ?? "minor"}</span>
      </div>
      {/* eslint-disable-next-line react/no-danger */}
      <div className="markdown restate-note-body" dangerouslySetInnerHTML={{ __html: bodyHtml }} />
      <div className="restate-note-resolve">
        <input
          type="text"
          placeholder="How was this addressed? (optional)"
          value={resolution}
          onChange={(e) => setResolution(e.target.value)}
        />
        <button
          type="button"
          className="tf-btn tf-btn-secondary"
          disabled={resolving}
          onClick={() => onResolve(note.id, resolution)}
        >
          Resolve
        </button>
      </div>
    </div>
  );
}

// ── the studio ──────────────────────────────────────────────────────────────────

export function RestateStudio({
  workspaceId,
  pageId,
  status,
  specMarkdown,
}: {
  workspaceId: WorkspaceId;
  pageId: PageId;
  status: string;
  /** The whole page's rendered markdown (usePage) — the holistic review's input. */
  specMarkdown: string | null;
}): React.JSX.Element {
  const { elements, loading: elementsLoading, error: elementsError } = useSectionElements(workspaceId, pageId, SECTIONS_KEY);
  const notes = useSectionElements(workspaceId, pageId, REVIEW_KEY);
  const { run: runMutation, pending: mutating, error: mutationError, reset: resetMutation } = usePageMutator(
    workspaceId,
    pageId,
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Editor text per section id; see the seeding effect below. */
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  /** Critique per section id — runs outlive the selection, so these are keyed, not one. */
  const [critiques, setCritiques] = useState<Readonly<Record<string, CritiqueState>>>({});
  const [restored, setRestored] = useState(false);
  const [health, setHealth] = useState<RestateHealth | null>(null);
  /** In-flight critique streams, and a per-section generation bumped whenever a run is
   *  superseded (new run, Accept, unmount) so a stale stream can't touch state after. */
  const critiqueRuns = useRef(new Map<string, AbortController>());
  const critiqueGen = useRef(new Map<string, number>());
  const [reviewRun, setReviewRun] = useState<{ running: boolean; startedAt: number | null; error: string | null }>({
    running: false,
    startedAt: null,
    error: null,
  });
  const [elapsed, setElapsed] = useState(0);
  const reviewAbort = useRef<AbortController | null>(null);
  const studioRef = useRef<HTMLDivElement | null>(null);
  const specColRef = useRef<HTMLElement | null>(null);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const [preview, setPreview] = useState(false);
  const [seedBusy, setSeedBusy] = useState(false);
  /** Two-step confirm: first click arms "Discard your edits?", second re-seeds. */
  const [resetArm, setResetArm] = useState(false);
  const [seedError, setSeedError] = useState<string | null>(null);
  /** The section currently being seeded — dedupes the effect across re-renders. */
  const seeding = useRef<string | null>(null);

  const draft = selectedId === null ? "" : (drafts[selectedId] ?? "");
  const setDraft = useCallback(
    (text: string) => {
      if (selectedId !== null) setDrafts((d) => ({ ...d, [selectedId]: text }));
    },
    [selectedId],
  );

  /** Patch one section's critique, but never resurrect an entry that was pruned. */
  const patchCritique = useCallback((id: string, patch: (prev: CritiqueState) => CritiqueState) => {
    setCritiques((c) => {
      const prev = c[id];
      return prev === undefined ? c : { ...c, [id]: patch(prev) };
    });
  }, []);

  /** Supersede any in-flight critique for a section (its late frames become no-ops). */
  const endCritique = useCallback((id: string) => {
    critiqueGen.current.set(id, (critiqueGen.current.get(id) ?? 0) + 1);
    critiqueRuns.current.get(id)?.abort();
    critiqueRuns.current.delete(id);
  }, []);

  // Restore the persisted draft once per mount (the parent keys this component by page).
  useEffect(() => {
    const store = browserStore();
    const saved = store !== null ? loadRestateDraft(store, workspaceId, pageId) : null;
    if (saved !== null) {
      if (saved.selectedId !== undefined) setSelectedId(saved.selectedId);
      setDrafts(saved.drafts);
      // Sessions restore as idle critiques: nothing to show, but a follow-up round resumes.
      const resumable: Record<string, CritiqueState> = {};
      for (const [id, sessionId] of Object.entries(saved.sessions)) resumable[id] = { ...CRITIQUE_IDLE, sessionId };
      setCritiques(resumable);
    }
    setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Probe the critic once per mount; buttons disable (with the reason) when unavailable.
  useEffect(() => {
    let cancelled = false;
    void fetchRestateHealth().then((h) => {
      if (!cancelled) setHealth(h);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Per-section state survives live re-renders only while the section is still restatable.
  // Skipped while the element read is errored — stale elements must not drop live work.
  useEffect(() => {
    if (!restored || elementsLoading || elementsError !== null) return;
    if (selectedId !== null && !isRestatable(selectedId, elements)) setSelectedId(null);
    const keptDrafts = pruneBySection(drafts, elements);
    if (Object.keys(keptDrafts).length !== Object.keys(drafts).length) setDrafts(keptDrafts);
    // A critique belongs to a restatement in progress: once the section is verified (or
    // gone) its panel is unreachable, so end the run and drop it.
    const keptCritiques = pruneBySection(
      critiques,
      elements.filter((e) => e.status === "ai-draft"),
    );
    if (Object.keys(keptCritiques).length !== Object.keys(critiques).length) {
      for (const id of Object.keys(critiques)) if (keptCritiques[id] === undefined) endCritique(id);
      setCritiques(keptCritiques);
    }
  }, [restored, elementsLoading, elementsError, elements, selectedId, drafts, critiques, endCritique]);

  // Looking at a critique marks it read (whether it landed before or during the visit).
  useEffect(() => {
    if (selectedId === null || critiques[selectedId]?.unread !== true) return;
    patchCritique(selectedId, (prev) => ({ ...prev, unread: false }));
  }, [selectedId, critiques, patchCritique]);

  const sessions = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [id, c] of Object.entries(critiques)) if (c.sessionId !== undefined) out[id] = c.sessionId;
    return out;
  }, [critiques]);

  // Persist {selectedId, drafts, sessions}; an all-empty state clears the key.
  useEffect(() => {
    if (!restored) return;
    const store = browserStore();
    if (store === null) return;
    if (selectedId === null && Object.keys(drafts).length === 0 && Object.keys(sessions).length === 0) {
      clearRestateDraft(store, workspaceId, pageId);
    } else {
      saveRestateDraft(store, workspaceId, pageId, {
        ...(selectedId !== null ? { selectedId } : {}),
        drafts,
        sessions,
      });
    }
  }, [restored, selectedId, drafts, sessions, workspaceId, pageId]);

  // Elapsed-seconds ticker for the long-running holistic review.
  useEffect(() => {
    if (!reviewRun.running || reviewRun.startedAt === null) return;
    const startedAt = reviewRun.startedAt;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [reviewRun.running, reviewRun.startedAt]);

  // Abandon in-flight critic/review calls when the studio unmounts.
  useEffect(() => {
    const runs = critiqueRuns.current;
    const gens = critiqueGen.current;
    const review = reviewAbort;
    return () => {
      for (const [id, ctrl] of runs) {
        gens.set(id, (gens.get(id) ?? 0) + 1);
        ctrl.abort();
      }
      runs.clear();
      review.current?.abort();
    };
  }, []);

  // Restore the persisted column split; drags write the CSS var directly (no re-render
  // per pointermove — the SidebarResizer pattern).
  useEffect(() => {
    const store = browserStore();
    const stored = store !== null ? loadSplit(store) : null;
    if (stored !== null) studioRef.current?.style.setProperty("--restate-split", String(stored));
  }, []);

  const onDividerPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const handle = e.currentTarget;
    const container = studioRef.current;
    if (container === null) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("is-dragging");
    const apply = (clientX: number): number => {
      const rect = container.getBoundingClientRect();
      const ratio = clampSplit((clientX - rect.left) / rect.width, rect.width);
      container.style.setProperty("--restate-split", String(ratio));
      return ratio;
    };
    const onMove = (ev: PointerEvent): void => void apply(ev.clientX);
    const onUp = (ev: PointerEvent): void => {
      handle.classList.remove("is-dragging");
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      const store = browserStore();
      if (store !== null) saveSplit(store, apply(ev.clientX));
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  }, []);

  const onDividerReset = useCallback(() => {
    studioRef.current?.style.setProperty("--restate-split", String(DEFAULT_SPLIT));
    const store = browserStore();
    if (store !== null) saveSplit(store, DEFAULT_SPLIT);
  }, []);

  /** Align a section card's top with the spec column's top (the column scrolls, never
   *  the window). No-op outside the two-scroll-container layout. */
  const scrollToSection = useCallback((id: string) => {
    const col = specColRef.current;
    if (col === null) return;
    const target = col.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(id)}"]`);
    if (target === null) return;
    const delta = target.getBoundingClientRect().top - col.getBoundingClientRect().top;
    col.scrollTo({ top: col.scrollTop + delta, behavior: "smooth" });
  }, []);

  // One section at a time: picking another parks this one's draft and critique (both are
  // keyed by section, and a running critique keeps running). Selecting scrolls the spec
  // column to the section; deselecting does not.
  const toggle = useCallback(
    (id: string) => {
      setSelectedId((prev) => (prev === id ? null : id));
      if (selectedId !== id) scrollToSection(id);
    },
    [selectedId, scrollToSection],
  );

  const selectedEl = useMemo(() => elements.find((e) => e.id === selectedId), [elements, selectedId]);
  const critique = selectedId === null ? undefined : critiques[selectedId];
  const fallbackTitle = titleOf(selectedEl);
  const verified = elements.filter((e) => e.status === "human-verified").length;
  const total = elements.length;
  const allVerified = total > 0 && verified === total;
  const workbenchActive = status === "restating" || status === "reviewing";
  const criticReady = health !== null && health.available;
  const openNotes = notes.elements.filter((n) => n.status === "open");
  const resolvedNotes = notes.elements.filter((n) => n.status !== "open");

  const reviewSummary = useMemo(() => {
    // "last": section BODIES render before the real "## Review" heading and keep authored
    // H2s verbatim, so a section containing a literal "## Review" would shadow first-match.
    const body = specMarkdown === null ? null : sliceH2Section(specMarkdown, "Review", "last");
    return body === null || body === "" || body === "_Not reviewed._" ? null : body;
  }, [specMarkdown]);

  // Rendered only while the preview tab is open — this runs on every keystroke otherwise.
  const draftHtml = useMemo(
    () => (preview && draft.trim() !== "" ? renderMarkdown(draft, workspaceId) : ""),
    [preview, draft, workspaceId],
  );

  const conflict = mutationError !== null && mutationError.includes("removeIds not found");

  const onAccept = useCallback(async () => {
    const id = selectedId;
    if (id === null) return;
    const sections = splitDraft(draft, fallbackTitle);
    if (sections.length === 0) return;
    const ok = await runMutation("restateSections", { removeIds: [id], sections });
    if (ok) {
      // Success clears this section's work — including any in-flight critique, whose late
      // deltas must not resurrect the panel. On ANY failure (incl. the OCC conflict) the
      // draft, selection and critique stay.
      endCritique(id);
      setSelectedId(null);
      setDrafts((d) => omit(d, id));
      setCritiques((c) => omit(c, id));
    }
  }, [selectedId, draft, fallbackTitle, runMutation, endCritique]);

  const onCritique = useCallback(async () => {
    const id = selectedId;
    const el = selectedEl;
    if (id === null || el === undefined) return;
    const restatement = drafts[id] ?? "";
    if (restatement.trim() === "") return;
    const gen = (critiqueGen.current.get(id) ?? 0) + 1;
    critiqueGen.current.set(id, gen);
    critiqueRuns.current.get(id)?.abort();
    const ctrl = new AbortController();
    critiqueRuns.current.set(id, ctrl);
    const live = (): boolean => critiqueGen.current.get(id) === gen;
    // Same section, so an existing session is always resumable — the server ignores the
    // freshly-sent source when resuming, and the source hasn't changed.
    const resume = critiques[id]?.sessionId;
    setCritiques((c) => ({
      ...c,
      [id]: { ...CRITIQUE_IDLE, streaming: true, ...(resume !== undefined ? { sessionId: resume } : {}) },
    }));
    let source: string;
    try {
      const h = await getHost();
      // The critic wants the source content; the rendered heading would duplicate the title.
      source = splitRenderedElement(await h.renderElement(workspaceId, pageId, SECTIONS_KEY, id)).body;
    } catch (e) {
      if (live()) patchCritique(id, (p) => ({ ...p, streaming: false, error: errText(e), unread: true }));
      return;
    }
    const out = await streamCritique({
      sections: [{ title: titleOf(el), markdown: source }],
      restatement,
      sessionId: resume,
      signal: ctrl.signal,
      onDelta: (t) => {
        if (live()) patchCritique(id, (p) => ({ ...p, text: p.text + t }));
      },
    });
    if (!live()) return; // superseded by Accept / a newer run / unmount
    if (out.ok) {
      patchCritique(id, (p) => ({
        ...p,
        streaming: false,
        verdict: out.verdict,
        error: null,
        unread: true, // cleared on sight; badges the card when you've moved on
        ...(out.sessionId !== undefined ? { sessionId: out.sessionId } : {}),
      }));
    } else if (ctrl.signal.aborted) {
      patchCritique(id, (p) => ({ ...p, streaming: false })); // user cancel — not a failure
    } else {
      patchCritique(id, (p) => ({
        ...p,
        streaming: false,
        error: out.message,
        unread: true,
        // A failed resume usually means the claude session is gone — drop it so the next
        // attempt starts fresh (the source travels in every request anyway).
        ...(resume !== undefined ? { sessionId: undefined } : {}),
      }));
    }
  }, [selectedId, selectedEl, drafts, critiques, workspaceId, pageId, patchCritique]);

  const onRunReview = useCallback(async () => {
    if (specMarkdown === null) return;
    reviewAbort.current?.abort();
    const ctrl = new AbortController();
    reviewAbort.current = ctrl;
    setElapsed(0);
    setReviewRun({ running: true, startedAt: Date.now(), error: null });
    // The route runs FIRST; only its success mutates the page, so a failed/cancelled
    // review leaves the wiki untouched.
    const out = await requestReview(specMarkdown, ctrl.signal);
    if (!out.ok) {
      setReviewRun({ running: false, startedAt: null, error: out.message });
      return;
    }
    const command = status === "reviewing" ? "rerunHolisticReview" : "recordHolisticReview";
    await runMutation(command, { summary: out.verdict.summary, notes: out.verdict.notes });
    setReviewRun({ running: false, startedAt: null, error: null });
  }, [specMarkdown, status, runMutation]);

  const onResolve = useCallback(
    (noteId: string, resolution: string) => {
      void runMutation("resolveNote", {
        noteId,
        ...(resolution.trim() !== "" ? { resolution: resolution.trim() } : {}),
      });
    },
    [runMutation],
  );

  // Human sign-off without restatement: reading the draft and judging it correct IS the
  // verification. The live tail flips the card; the prune effect then drops its state.
  const onAcceptAsIs = useCallback(
    (id: string) => {
      void runMutation("acceptSections", { sectionIds: [id] });
    },
    [runMutation],
  );

  const onUnaccept = useCallback(
    (id: string) => {
      void runMutation("unacceptSections", { sectionIds: [id] });
    },
    [runMutation],
  );

  // A changed selection invalidates an armed "Discard your edits?" confirmation.
  useEffect(() => {
    setResetArm(false);
  }, [selectedId]);

  /**
   * Selecting a section fills the editor with its current markdown — but only the FIRST
   * time: each section keeps its own entry in `drafts`, so moving to another section and
   * coming back restores what you had typed (an emptied box included — `""` is an entry,
   * absence is not).
   */
  useEffect(() => {
    if (!restored || !workbenchActive || selectedId === null || selectedEl === undefined) return;
    const id = selectedId;
    const el = selectedEl;
    if (drafts[id] !== undefined || seeding.current === id) return;
    seeding.current = id;
    setSeedBusy(true);
    setSeedError(null);
    void (async () => {
      let seed = "";
      try {
        const h = await getHost();
        const body = splitRenderedElement(await h.renderElement(workspaceId, pageId, SECTIONS_KEY, id)).body;
        seed = assembleDraft([{ title: titleOf(el), body }]);
      } catch (e) {
        setSeedError(errText(e));
      }
      // Typing during the fetch wins — a stored entry is never overwritten by a seed.
      setDrafts((d) => (d[id] !== undefined ? d : { ...d, [id]: seed }));
      setSeedBusy(false);
      if (seeding.current === id) seeding.current = null;
    })();
  }, [restored, workbenchActive, selectedId, selectedEl, drafts, workspaceId, pageId]);

  const onResetToSource = useCallback(() => {
    const id = selectedId;
    if (id === null || seedBusy) return;
    if (draft.trim() !== "" && !resetArm) {
      setResetArm(true);
      return;
    }
    setResetArm(false);
    // Dropping the entry re-arms the seeding effect, which re-reads the section.
    seeding.current = null;
    setDrafts((d) => omit(d, id));
    draftRef.current?.focus();
  }, [selectedId, seedBusy, draft, resetArm]);

  const criticGate =
    health === null ? "Probing the critic…" : criticReady ? null : (health.reason ?? "the critic is not available");

  // ── right column per page status ──────────────────────────────────────────────

  let workbench: React.ReactNode;
  if (status === "drafting") {
    workbench = (
      <div className="notice">
        <strong>AI draft in progress</strong>
        <p className="muted">
          The studio activates once the drafting agent runs <code>submitForRestatement</code>. Sections will then be
          selectable for restatement here.
        </p>
      </div>
    );
  } else if (status === "approved") {
    workbench = (
      <div className="notice">
        <strong>Approved</strong>
        <p className="muted">
          Every section is human-verified and the review is signed off. To start another cycle, run{" "}
          <code>reopen</code> from the <Link href={pageHref(workspaceId, pageId, "model")}>Model view</Link>.
        </p>
      </div>
    );
  } else if (!workbenchActive) {
    workbench = (
      <div className="notice">
        <strong>{status}</strong>
        <p className="muted">The studio's actions live in the restating and reviewing statuses.</p>
      </div>
    );
  } else {
    workbench = (
      <>
        {status === "reviewing" && (
          <section className="restate-block">
            <h2 className="restate-block-head">Review notes</h2>
            {reviewSummary !== null && (
              /* eslint-disable-next-line react/no-danger */
              <div
                className="markdown restate-review-summary"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(reviewSummary, workspaceId) }}
              />
            )}
            {notes.loading && notes.elements.length === 0 ? (
              <p className="muted">Loading notes…</p>
            ) : notes.error !== null && notes.elements.length === 0 ? (
              <p className="restate-load-error" role="alert">
                Couldn&apos;t load review notes: {notes.error}
              </p>
            ) : notes.elements.length === 0 ? (
              <p className="muted">The review recorded no notes.</p>
            ) : (
              <>
                {openNotes.map((n) => (
                  <NoteCard
                    key={n.id}
                    workspaceId={workspaceId}
                    pageId={pageId}
                    note={n}
                    resolving={mutating}
                    onResolve={onResolve}
                  />
                ))}
                {resolvedNotes.map((n) => (
                  <NoteCard
                    key={n.id}
                    workspaceId={workspaceId}
                    pageId={pageId}
                    note={n}
                    resolving={mutating}
                    onResolve={onResolve}
                  />
                ))}
              </>
            )}
            {openNotes.length === 0 && notes.elements.length > 0 && (
              <p className="restate-approve-hint">
                All review notes are resolved — approve from the{" "}
                <Link href={pageHref(workspaceId, pageId, "model")}>Model view</Link>.
              </p>
            )}
            <div className="restate-actions">
              <button
                type="button"
                className="tf-btn tf-btn-secondary"
                disabled={!criticReady || !allVerified || reviewRun.running || mutating || specMarkdown === null}
                title={criticGate ?? (!allVerified ? "every section must be human-verified again" : undefined)}
                onClick={() => void onRunReview()}
              >
                Re-run review
              </button>
            </div>
          </section>
        )}

        {status === "restating" && allVerified && (
          <section className="restate-block restate-review-cta">
            <h2 className="restate-block-head">All sections verified</h2>
            <p className="muted">
              Run the holistic AI review: the whole spec goes to the local claude CLI, and its summary + notes are
              recorded in one commit that moves the page to <code>reviewing</code>.
            </p>
            <div className="restate-actions">
              <button
                type="button"
                className="tf-btn tf-btn-primary"
                disabled={!criticReady || reviewRun.running || mutating || specMarkdown === null}
                title={criticGate ?? undefined}
                onClick={() => void onRunReview()}
              >
                Run holistic review
              </button>
            </div>
          </section>
        )}

        {reviewRun.running && (
          <p className="restate-review-status" role="status">
            Reviewing… {elapsed}s — the page is untouched until the review returns (this can take minutes).{" "}
            <button type="button" className="restate-cancel" onClick={() => reviewAbort.current?.abort()}>
              Cancel
            </button>
          </p>
        )}
        {reviewRun.error !== null && <div className="notice error">Holistic review failed: {reviewRun.error}</div>}

        <section className={`restate-block${selectedEl !== undefined ? " restate-block-editor" : ""}`}>
          <div className="restate-block-head-row">
            <h2 className="restate-block-head">Restate</h2>
            {selectedEl !== undefined && (
              <div className="view-toggle" role="tablist" aria-label="Editor or preview">
                <button
                  type="button"
                  role="tab"
                  aria-selected={!preview}
                  className={`view-tab ${preview ? "" : "active"}`}
                  onClick={() => setPreview(false)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={preview}
                  className={`view-tab ${preview ? "active" : ""}`}
                  onClick={() => setPreview(true)}
                >
                  Preview
                </button>
              </div>
            )}
          </div>
          {selectedEl === undefined ? (
            <p className="muted">Select an AI-draft section on the left to restate it in your own words.</p>
          ) : (
            <>
              <p className="restate-sources">
                Restating <span className="restate-source">{titleOf(selectedEl)}</span>
              </p>
              <div className="restate-selection-actions">
                <button
                  type="button"
                  className={`tf-btn ${resetArm ? "tf-btn-primary" : "tf-btn-secondary"}`}
                  disabled={seedBusy || mutating}
                  title="Re-read the section's current markdown into the editor, discarding your edits"
                  onClick={onResetToSource}
                >
                  {resetArm ? "Discard your edits?" : seedBusy ? "Loading…" : "Reset to source"}
                </button>
                <button
                  type="button"
                  className="tf-btn tf-btn-secondary"
                  disabled={mutating}
                  title="Verify this section exactly as written — no restatement"
                  onClick={() => onAcceptAsIs(selectedEl.id)}
                >
                  Accept as-is
                </button>
              </div>
              {seedError !== null && (
                <p className="restate-load-error" role="alert">
                  Couldn&apos;t load the section into the editor: {seedError}
                </p>
              )}
              {preview ? (
                draftHtml === "" ? (
                  <p className="muted restate-preview restate-preview-empty">
                    Nothing to preview yet — write your restatement in the editor.
                  </p>
                ) : (
                  /* eslint-disable-next-line react/no-danger */
                  <div className="markdown restate-preview" dangerouslySetInnerHTML={{ __html: draftHtml }} />
                )
              ) : (
                <textarea
                  ref={draftRef}
                  className="restate-draft"
                  value={draft}
                  spellCheck
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={seedBusy ? "Loading the section…" : "Restate this section in your own words…"}
                />
              )}
              <p className="muted restate-hint">
                Start lines with <code>## Heading</code> to split this into multiple sections (each heading becomes a
                section title). With no headings, the whole draft becomes one section titled &ldquo;{fallbackTitle}
                &rdquo;.
              </p>
              <div className="restate-actions">
                <button
                  type="button"
                  className="tf-btn tf-btn-secondary"
                  disabled={!criticReady || critique?.streaming === true || draft.trim() === "" || mutating}
                  title={criticGate ?? undefined}
                  onClick={() => void onCritique()}
                >
                  {critique?.streaming === true
                    ? "Critiquing…"
                    : critique !== undefined && critique.verdict !== null
                      ? "Get another critique"
                      : "Get critique"}
                </button>
                <button
                  type="button"
                  className="tf-btn tf-btn-primary"
                  disabled={draft.trim() === "" || mutating}
                  onClick={() => void onAccept()}
                >
                  {mutating ? "Committing…" : "Accept restatement"}
                </button>
              </div>
              {criticGate !== null && health !== null && (
                <p className="muted restate-health">
                  Critique unavailable: {criticGate}. Restating and Accept still work — critique is optional.
                </p>
              )}
            </>
          )}

          {mutationError !== null &&
            (conflict ? (
              <div className="notice error restate-conflict">
                <strong>This section changed underneath you</strong>
                <p className="muted">
                  Someone else edited or replaced it since you selected it. Your draft is kept — re-select the current
                  section and accept again.
                </p>
                <p className="muted">{mutationError}</p>
              </div>
            ) : (
              <div className="notice error">
                {mutationError}{" "}
                <button type="button" className="restate-cancel" onClick={resetMutation}>
                  Dismiss
                </button>
              </div>
            ))}

          {selectedId !== null &&
            critique !== undefined &&
            (critique.streaming || critique.text !== "" || critique.verdict !== null || critique.error !== null) && (
              <div className="restate-critique">
                <div className="restate-critique-head">
                  <span>Critique{critique.streaming ? " — streaming…" : ""}</span>
                  {critique.streaming ? (
                    <button
                      type="button"
                      className="restate-cancel"
                      onClick={() => critiqueRuns.current.get(selectedId)?.abort()}
                    >
                      Cancel
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="restate-cancel"
                      onClick={() => {
                        endCritique(selectedId);
                        setCritiques((c) => omit(c, selectedId));
                      }}
                    >
                      Clear
                    </button>
                  )}
                </div>
                {critique.text !== "" && (
                  /* eslint-disable-next-line react/no-danger */
                  <div
                    className="markdown restate-critique-body"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(critique.text, workspaceId) }}
                  />
                )}
                {critique.verdict !== null && (
                  <div className="restate-verdict">
                    <p>
                      <strong>Verdict.</strong> {critique.verdict.summary}
                    </p>
                    {critique.verdict.gaps.length > 0 && (
                      <div className="restate-verdict-group">
                        <span className="restate-verdict-label restate-verdict-gaps">Gaps</span>
                        <ul>
                          {critique.verdict.gaps.map((g, i) => (
                            <li key={i}>{g}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {critique.verdict.improvements.length > 0 && (
                      <div className="restate-verdict-group">
                        <span className="restate-verdict-label restate-verdict-improvements">Improvements</span>
                        <ul>
                          {critique.verdict.improvements.map((g, i) => (
                            <li key={i}>{g}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
                {critique.error !== null && <p className="error">{critique.error}</p>}
              </div>
            )}
        </section>
      </>
    );
  }

  return (
    <>
      {/* Spans BOTH columns, so the spec and the workbench start at the same y. */}
      <div className="restate-bar">
        <p className="restate-progress">
          {total === 0 && elementsLoading
            ? "Loading sections…"
            : `${verified} of ${total} section${total === 1 ? "" : "s"} verified`}
        </p>
        {elementsError !== null && (
          <p className="restate-load-error" role="alert">
            Couldn&apos;t refresh sections: {elementsError}. Showing the last good read; your selection is kept.
          </p>
        )}
      </div>
      <div ref={studioRef} className="restate-studio">
        <section ref={specColRef} className="restate-spec" aria-label="Spec sections">
          {elements.map((el) => (
            <SectionCard
              key={el.id}
              workspaceId={workspaceId}
              pageId={pageId}
              el={el}
              selectable={workbenchActive && el.status === "ai-draft"}
              selected={selectedId === el.id}
              onToggle={() => toggle(el.id)}
              critique={critiqueTag(critiques[el.id])}
              action={
                !workbenchActive
                  ? null
                  : el.status === "ai-draft"
                    ? { label: "Accept as-is", busy: mutating, onRun: () => onAcceptAsIs(el.id) }
                    : el.status === "human-verified"
                      ? { label: "Unaccept", busy: mutating, onRun: () => onUnaccept(el.id) }
                      : null
              }
            />
          ))}
          {total === 0 && !elementsLoading && elementsError === null && (
            <p className="muted">No sections drafted yet.</p>
          )}
        </section>
        <div
          className="restate-divider"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize studio columns"
          title="Drag to resize · double-click to reset"
          onPointerDown={onDividerPointerDown}
          onDoubleClick={onDividerReset}
        />
        <aside className="restate-workbench" aria-label="Restatement workbench">
          {workbench}
        </aside>
      </div>
    </>
  );
}
