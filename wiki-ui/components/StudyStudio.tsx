"use client";

/**
 * The Study Studio (feature: study-notes studio) — the browser UI for `study-notes`
 * pages. Two columns: the LEFT renders the reading notes per section (renderElement →
 * HTML) with every glossary term's occurrences highlighted by status (needs-definition /
 * defined / checked-with-grade); the RIGHT is the workbench — a definition editor for the
 * selected term (or a note editor for the selected note) above the always-present
 * glossary rail.
 *
 * Marking terms is the fluid part: select any text in a note and a floating "add to
 * glossary" action appears; a note's `**bold**` runs (the learner's existing habit) are
 * offered as one-click candidate chips; and the rail takes free-typed terms. Clicking a
 * highlighted occurrence opens that term's definition panel.
 *
 * Evaluation is asynchronous and parallel (unlike the restate critic's one serialized
 * session): saving a definition auto-queues a stateless claude evaluation
 * (/api/study/evaluate), a couple run concurrently, and each verdict lands on the PAGE
 * via `recordEvaluation` (grade + feedback, term → checked) — so the wiki, not the
 * browser, is the record. Editing a checked definition downgrades it honestly
 * (`defineTerm` clears the stale verdict model-side).
 *
 * Drafts (per note / per term) and the selection persist in localStorage per
 * workspace+page, pruned when their element goes. Structure edits on notes reuse the
 * outline mechanics: move/indent/outdent walk sibling boundaries, subtrees travel whole.
 */
import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  isEditable,
  pruneBySection,
  sliceH2Section,
  splitRenderedElement,
  type CritiqueGrade,
  type CritiqueVerdict,
  type KeyValueStore,
  type RestateHealth,
} from "../lib/restate";
import { clampSplit, DEFAULT_SPLIT, loadSplit, saveSplit } from "../lib/restate-split";
import {
  boldCandidates,
  clearStudyDraft,
  definitionFromBody,
  feedbackFromBody,
  feedbackMarkdown,
  fetchStudyHealth,
  findTermMatches,
  loadStudyDraft,
  requestEvaluation,
  saveStudyDraft,
  termContext,
  type StudySelection,
} from "../lib/study";
import { canIndent, canOutdent, depthOf, hiddenByCollapse, siblingMoveTarget, subtreeIds } from "../lib/outline";
import { pageHref } from "../lib/routes";

const NOTES_KEY = "notes";
const GLOSSARY_KEY = "glossary";
/** How many evaluations run concurrently (stateless calls — no shared session). */
const EVAL_CONCURRENCY = 2;

function browserStore(): KeyValueStore | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null; // storage blocked — drafts just won't persist
  }
}

function titleOf(el: SectionElementSummary | undefined): string {
  return el?.title ?? el?.id ?? "Untitled";
}

function gradeOf(el: SectionElementSummary): string {
  const g = el.scalars?.["grade"];
  return typeof g === "string" ? g : "";
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function omit<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

const GRADE_LABEL: Record<CritiqueGrade, string> = {
  understood: "Understood",
  partial: "Partial",
  surface: "Surface",
};

const STATUS_LABEL: Record<string, string> = {
  marked: "Needs definition",
  defined: "Defined",
  checked: "Checked",
};

/** Seconds since `startedAt` (null = not running), ticking once a second. */
function useElapsedSeconds(startedAt: number | null): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (startedAt === null) {
      setElapsed(0);
      return;
    }
    setElapsed(0);
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  return elapsed;
}

// ── term highlighting (DOM post-pass over rendered note HTML) ───────────────────

interface TermRef {
  readonly id: string;
  readonly term: string;
  readonly status: string;
  readonly grade: string;
}

/**
 * Wrap every glossary-term occurrence in `root`'s text with a status-classed
 * `<mark data-term-id>`. Runs AFTER the container's innerHTML is set (the container is
 * managed manually, not via React children, so the mutation is safe). Skips code and
 * existing marks.
 */
function applyTermMarks(root: HTMLElement, terms: readonly TermRef[]): void {
  if (terms.length === 0) return;
  const byId = new Map(terms.map((t) => [t.id, t]));
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (parent === null || parent.closest("pre, code, mark, a") !== null) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) texts.push(n as Text);
  for (const node of texts) {
    const matches = findTermMatches(node.data, terms);
    if (matches.length === 0) continue;
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const m of matches) {
      if (m.start > at) frag.appendChild(document.createTextNode(node.data.slice(at, m.start)));
      const t = byId.get(m.termId)!;
      const mark = document.createElement("mark");
      mark.className = `study-term study-term-${t.status}`;
      mark.dataset.termId = t.id;
      mark.title =
        t.status === "checked" && t.grade !== ""
          ? `${t.term} — checked (${t.grade})`
          : `${t.term} — ${(STATUS_LABEL[t.status] ?? t.status).toLowerCase()}`;
      mark.textContent = node.data.slice(m.start, m.end);
      frag.appendChild(mark);
      at = m.end;
    }
    if (at < node.data.length) frag.appendChild(document.createTextNode(node.data.slice(at)));
    node.parentNode?.replaceChild(frag, node);
  }
}

/** A note body with term marks: innerHTML is managed manually so the mark pass can
 *  re-run when the glossary changes without React fighting the mutation. */
function MarkedBody({ html, terms, className }: { html: string; terms: readonly TermRef[]; className: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.innerHTML = html;
    applyTermMarks(el, terms);
  }, [html, terms]);
  return <div ref={ref} className={className} />;
}

// ── left column: one note card ──────────────────────────────────────────────────

interface NoteStructure {
  readonly canUp: boolean;
  readonly canDown: boolean;
  readonly onUp: () => void;
  readonly onDown: () => void;
  readonly canIndent: boolean;
  readonly canOutdent: boolean;
  readonly onIndent: () => void;
  readonly onOutdent: () => void;
  readonly collapsed: boolean;
  readonly onToggleCollapse: () => void;
  readonly deleting: boolean;
  readonly onToggleDelete: () => void;
  readonly onDelete: () => void;
  readonly busy: boolean;
}

function NoteCard({
  workspaceId,
  pageId,
  el,
  terms,
  selectable,
  selected,
  onSelect,
  onTermClick,
  onMarkCandidate,
  structure,
  depth,
  childCount,
}: {
  workspaceId: WorkspaceId;
  pageId: PageId;
  el: SectionElementSummary;
  terms: readonly TermRef[];
  selectable: boolean;
  selected: boolean;
  onSelect: () => void;
  onTermClick: (termId: string) => void;
  /** One-click "add this bold run to the glossary"; null hides the chip row. */
  onMarkCandidate: ((term: string) => void) | null;
  structure: NoteStructure | null;
  depth: number;
  childCount: number;
}): React.JSX.Element {
  const { markdown, loading, error } = useElementMarkdown(workspaceId, pageId, NOTES_KEY, el.id);
  const body = markdown === null ? null : splitRenderedElement(markdown).body;
  const html = useMemo(() => (body === null ? "" : renderMarkdown(body, workspaceId)), [body, workspaceId]);
  const candidates = useMemo(
    () => (body === null || onMarkCandidate === null ? [] : boldCandidates(body, terms.map((t) => t.term))),
    [body, onMarkCandidate, terms],
  );
  const collapsed = structure?.collapsed === true;
  const classes = [
    "restate-section",
    "study-note",
    selected ? "is-selected" : "",
    collapsed ? "is-collapsed" : "",
    depth > 0 ? "is-nested" : "",
  ]
    .filter((c) => c !== "")
    .join(" ");
  return (
    <div
      className={classes}
      data-el-id={el.id}
      data-depth={depth}
      onClick={(e) => {
        const mark = (e.target as HTMLElement).closest<HTMLElement>("mark[data-term-id]");
        if (mark?.dataset.termId !== undefined) {
          onTermClick(mark.dataset.termId);
          return;
        }
      }}
    >
      {depth > 0 && (
        <span className="restate-rails" aria-hidden="true">
          {Array.from({ length: depth }, (_, i) => (
            <span key={i} className="restate-rail" />
          ))}
        </span>
      )}
      <div className="restate-section-head">
        {structure === null ? (
          <span className="restate-card-lead">
            <span className="restate-card-title">{titleOf(el)}</span>
            {childCount > 0 && (
              <span className="restate-card-kids">
                {childCount} subnote{childCount === 1 ? "" : "s"}
              </span>
            )}
          </span>
        ) : (
          <button
            type="button"
            className="restate-card-lead"
            aria-expanded={!collapsed}
            title={collapsed ? "Expand this note" : "Collapse this note"}
            onClick={structure.onToggleCollapse}
          >
            <span className="restate-card-title">{titleOf(el)}</span>
            {childCount > 0 && (
              <span className="restate-card-kids">
                {childCount} subnote{childCount === 1 ? "" : "s"}
              </span>
            )}
          </button>
        )}
        <span className="restate-card-side">
          {selectable && (
            <button
              type="button"
              className="restate-select"
              aria-pressed={selected}
              aria-label={`Edit "${titleOf(el)}"`}
              onClick={onSelect}
            >
              {selected ? "Editing" : "Edit"}
            </button>
          )}
          {structure !== null && (
            <span className="restate-card-tools">
              <button type="button" className="restate-tool" disabled={!structure.canUp || structure.busy} title="Move up" onClick={structure.onUp}>
                ↑
              </button>
              <button type="button" className="restate-tool" disabled={!structure.canDown || structure.busy} title="Move down" onClick={structure.onDown}>
                ↓
              </button>
              <button
                type="button"
                className="restate-tool"
                disabled={!structure.canOutdent || structure.busy}
                title="Promote out of its parent note"
                onClick={structure.onOutdent}
              >
                ⇤
              </button>
              <button
                type="button"
                className="restate-tool"
                disabled={!structure.canIndent || structure.busy}
                title="Make this a subnote of the note above"
                onClick={structure.onIndent}
              >
                ⇥
              </button>
              <button
                type="button"
                className={`restate-tool ${structure.deleting ? "is-danger" : ""}`}
                aria-pressed={structure.deleting}
                disabled={structure.busy}
                title={childCount > 0 ? "Delete this note and its subnotes" : "Delete this note"}
                onClick={structure.onToggleDelete}
              >
                ✕
              </button>
            </span>
          )}
        </span>
      </div>
      {structure?.deleting === true && (
        <div className="restate-confirm" role="alert">
          <span>
            Delete &ldquo;{titleOf(el)}&rdquo;?
            {childCount > 0 && ` Its ${childCount} subnote${childCount === 1 ? "" : "s"} go with it.`}
          </span>
          <button type="button" className="tf-btn tf-btn-danger" disabled={structure.busy} onClick={structure.onDelete}>
            Delete
          </button>
          <button type="button" className="restate-cancel" onClick={structure.onToggleDelete}>
            Cancel
          </button>
        </div>
      )}
      {error !== null ? (
        <p className="error">{error}</p>
      ) : markdown === null && loading ? (
        <p className="muted">Loading note…</p>
      ) : collapsed ? null : (
        <>
          <MarkedBody html={html} terms={terms} className="markdown restate-section-body study-note-body" />
          {candidates.length > 0 && onMarkCandidate !== null && (
            <div className="study-candidates">
              <span className="study-candidates-label" title="Bolded runs in this note not yet in the glossary">
                Terms?
              </span>
              {candidates.map((term) => (
                <button key={term} type="button" className="study-chip" title={`Add "${term}" to the glossary`} onClick={() => onMarkCandidate(term)}>
                  + {term}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── per-term evaluation state ───────────────────────────────────────────────────

interface EvalState {
  readonly verdict: CritiqueVerdict | null;
  readonly error: string | null;
}

// ── the studio ──────────────────────────────────────────────────────────────────

export function StudyStudio({
  workspaceId,
  pageId,
  status,
  pageTitle,
  pageMarkdown,
}: {
  workspaceId: WorkspaceId;
  pageId: PageId;
  status: string;
  /** What is being studied — travels to the evaluator as SUBJECT. */
  pageTitle: string | null;
  /** The whole page's rendered markdown (usePage) — the notes slice grounds the evaluator. */
  pageMarkdown: string | null;
}): React.JSX.Element {
  const notes = useSectionElements(workspaceId, pageId, NOTES_KEY);
  const glossary = useSectionElements(workspaceId, pageId, GLOSSARY_KEY);
  const { run: runMutation, pending: mutating, error: mutationError, reset: resetMutation } = usePageMutator(
    workspaceId,
    pageId,
  );

  const [selected, setSelected] = useState<StudySelection | null>(null);
  const [noteDrafts, setNoteDrafts] = useState<Readonly<Record<string, string>>>({});
  const [termDrafts, setTermDrafts] = useState<Readonly<Record<string, string>>>({});
  const [noteTitleDraft, setNoteTitleDraft] = useState("");
  const [evals, setEvals] = useState<Readonly<Record<string, EvalState>>>({});
  const [evalRuns, setEvalRuns] = useState<Readonly<Record<string, { startedAt: number }>>>({});
  const [evalQueue, setEvalQueue] = useState<readonly { termId: string; definition: string | null }[]>([]);
  const evalAborts = useRef(new Map<string, AbortController>());
  const [restored, setRestored] = useState(false);
  const [health, setHealth] = useState<RestateHealth | null>(null);
  const [preview, setPreview] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [deleting, setDeleting] = useState<string | null>(null);
  const [newTerm, setNewTerm] = useState("");
  /** After markTerm commits, select the term once its element appears (host.mutate returns no result). */
  const [pendingTermKey, setPendingTermKey] = useState<string | null>(null);
  /** Floating "add to glossary" action for a text selection inside the notes column. */
  const [floatMark, setFloatMark] = useState<{ text: string; x: number; y: number } | null>(null);
  const studioRef = useRef<HTMLDivElement | null>(null);
  const notesColRef = useRef<HTMLElement | null>(null);
  const seeding = useRef<string | null>(null);
  const [seedBusy, setSeedBusy] = useState(false);

  const capturing = status === "capturing";
  const termRefs = useMemo<readonly TermRef[]>(
    () =>
      glossary.elements.map((e) => ({
        id: e.id,
        term: titleOf(e),
        status: e.status ?? "marked",
        grade: gradeOf(e),
      })),
    [glossary.elements],
  );
  /** The notes slice of the page render — the evaluator's source context. */
  const notesMarkdown = useMemo(
    () => (pageMarkdown === null ? null : sliceH2Section(pageMarkdown, "Notes", "first")),
    [pageMarkdown],
  );
  const contextNotes = useMemo(
    () => (notesMarkdown === null ? [] : [{ title: "Notes", markdown: notesMarkdown }]),
    [notesMarkdown],
  );

  // Restore the persisted draft once per mount (the parent keys this component by page).
  useEffect(() => {
    const store = browserStore();
    const saved = store !== null ? loadStudyDraft(store, workspaceId, pageId) : null;
    if (saved !== null) {
      if (saved.selected !== undefined) setSelected(saved.selected);
      setNoteDrafts(saved.noteDrafts);
      setTermDrafts(saved.termDrafts);
    }
    setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Probe the evaluator once per mount; evaluation buttons disable with the reason.
  useEffect(() => {
    let cancelled = false;
    void fetchStudyHealth().then((h) => {
      if (!cancelled) setHealth(h);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist {selected, drafts}; an all-empty state clears the key.
  useEffect(() => {
    if (!restored) return;
    const store = browserStore();
    if (store === null) return;
    if (selected === null && Object.keys(noteDrafts).length === 0 && Object.keys(termDrafts).length === 0) {
      clearStudyDraft(store, workspaceId, pageId);
    } else {
      saveStudyDraft(store, workspaceId, pageId, {
        ...(selected !== null ? { selected } : {}),
        noteDrafts,
        termDrafts,
      });
    }
  }, [restored, selected, noteDrafts, termDrafts, workspaceId, pageId]);

  // Per-element state survives live re-renders only while its element still exists.
  useEffect(() => {
    if (!restored || notes.loading || glossary.loading || notes.error !== null || glossary.error !== null) return;
    if (selected?.kind === "note" && !isEditable(selected.id, notes.elements)) setSelected(null);
    if (selected?.kind === "term" && !isEditable(selected.id, glossary.elements)) setSelected(null);
    const keptNotes = pruneBySection(noteDrafts, notes.elements);
    if (Object.keys(keptNotes).length !== Object.keys(noteDrafts).length) setNoteDrafts(keptNotes);
    const keptTerms = pruneBySection(termDrafts, glossary.elements);
    if (Object.keys(keptTerms).length !== Object.keys(termDrafts).length) setTermDrafts(keptTerms);
    const keptEvals = pruneBySection(evals, glossary.elements);
    if (Object.keys(keptEvals).length !== Object.keys(evals).length) setEvals(keptEvals);
    if (deleting !== null && !notes.elements.some((e) => e.id === deleting)) setDeleting(null);
    for (const [termId, ctrl] of evalAborts.current) {
      if (!glossary.elements.some((e) => e.id === termId)) {
        ctrl.abort();
        evalAborts.current.delete(termId);
      }
    }
  }, [restored, notes, glossary, selected, noteDrafts, termDrafts, evals, deleting]);

  // A freshly-marked term (chip, selection, rail input) opens for definition on arrival.
  useEffect(() => {
    if (pendingTermKey === null) return;
    const hit = glossary.elements.find((e) => titleOf(e).trim().toLowerCase() === pendingTermKey);
    if (hit !== undefined) {
      setSelected({ kind: "term", id: hit.id });
      setPendingTermKey(null);
    }
  }, [pendingTermKey, glossary.elements]);

  // Abort every in-flight evaluation on unmount.
  useEffect(() => {
    const aborts = evalAborts.current;
    return () => {
      for (const ctrl of aborts.values()) ctrl.abort();
    };
  }, []);

  // Restore the persisted column split; drags write the CSS var directly.
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

  // ── marking terms ─────────────────────────────────────────────────────────────

  const onMarkTerm = useCallback(
    async (term: string) => {
      const clean = term.trim();
      if (clean === "") return;
      setFloatMark(null);
      const ok = await runMutation("markTerm", { term: clean });
      if (ok) setPendingTermKey(clean.toLowerCase());
    },
    [runMutation],
  );

  // Selecting text in the notes column floats an "add to glossary" action at the cursor.
  const onNotesMouseUp = useCallback(() => {
    if (!capturing) return;
    const sel = window.getSelection();
    const col = notesColRef.current;
    const studio = studioRef.current;
    if (sel === null || sel.isCollapsed || col === null || studio === null) {
      setFloatMark(null);
      return;
    }
    const text = sel.toString().trim().replace(/\s+/g, " ");
    if (text === "" || text.length > 60 || text.includes("\n")) {
      setFloatMark(null);
      return;
    }
    const anchor = sel.anchorNode;
    if (anchor === null || !col.contains(anchor)) {
      setFloatMark(null);
      return;
    }
    // Already glossaried (case-insensitive) — nothing to offer.
    if (termRefs.some((t) => t.term.trim().toLowerCase() === text.toLowerCase())) {
      setFloatMark(null);
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const base = studio.getBoundingClientRect();
    setFloatMark({ text, x: rect.left - base.left + rect.width / 2, y: rect.top - base.top });
  }, [capturing, termRefs]);

  useEffect(() => {
    if (floatMark === null) return;
    const clear = (): void => setFloatMark(null);
    window.addEventListener("scroll", clear, true);
    return () => window.removeEventListener("scroll", clear, true);
  }, [floatMark]);

  // ── evaluation queue (async, parallel, capped) ────────────────────────────────

  const criticReady = health !== null && health.available;
  const criticGate =
    health === null ? "Probing the evaluator…" : criticReady ? null : (health.reason ?? "the evaluator is not available");

  const enqueueEval = useCallback((termId: string, definition: string | null) => {
    setEvalQueue((q) => (q.some((e) => e.termId === termId) ? q : [...q, { termId, definition }]));
  }, []);

  const runEval = useCallback(
    async (termId: string, definition: string | null) => {
      const el = glossary.elements.find((e) => e.id === termId);
      if (el === undefined) return;
      const term = titleOf(el);
      const ctrl = new AbortController();
      evalAborts.current.get(termId)?.abort();
      evalAborts.current.set(termId, ctrl);
      setEvals((s) => omit(s, termId));
      setEvalRuns((r) => ({ ...r, [termId]: { startedAt: Date.now() } }));
      const land = (state: EvalState | null): void => {
        if (evalAborts.current.get(termId) === ctrl) evalAborts.current.delete(termId);
        setEvalRuns((r) => omit(r, termId));
        if (state !== null) setEvals((s) => ({ ...s, [termId]: state }));
      };
      try {
        let def = definition;
        if (def === null) {
          const h = await getHost();
          def = definitionFromBody(splitRenderedElement(await h.renderElement(workspaceId, pageId, GLOSSARY_KEY, termId)).body);
        }
        if (def.trim() === "") {
          land({ verdict: null, error: "nothing to evaluate — the definition is empty" });
          return;
        }
        const out = await requestEvaluation({
          term,
          definition: def,
          context: termContext(contextNotes, term),
          ...(pageTitle !== null ? { subject: pageTitle } : {}),
          signal: ctrl.signal,
        });
        if (ctrl.signal.aborted) {
          land(null);
          return;
        }
        if (!out.ok) {
          land({ verdict: null, error: out.message });
          return;
        }
        // The verdict is recorded ON THE PAGE — grade + feedback + checked, one commit.
        // Direct host call: an eval failure belongs to this term's panel, not the global
        // mutation banner.
        const h = await getHost();
        try {
          await h.mutate(workspaceId, pageId, "recordEvaluation", {
            termId,
            grade: out.verdict.grade,
            markdown: feedbackMarkdown(out.verdict),
          });
        } catch (e) {
          land({ verdict: out.verdict, error: `verdict not recorded: ${errText(e)}` });
          return;
        }
        land({ verdict: out.verdict, error: null });
      } catch (e) {
        land(ctrl.signal.aborted ? null : { verdict: null, error: errText(e) });
      }
    },
    [glossary.elements, workspaceId, pageId, contextNotes, pageTitle],
  );

  // Drain the queue while slots are free.
  useEffect(() => {
    if (evalQueue.length === 0 || Object.keys(evalRuns).length >= EVAL_CONCURRENCY) return;
    const [next, ...rest] = evalQueue;
    setEvalQueue(rest);
    void runEval(next!.termId, next!.definition);
  }, [evalQueue, evalRuns, runEval]);

  const cancelEval = useCallback((termId: string) => {
    evalAborts.current.get(termId)?.abort();
    setEvalQueue((q) => q.filter((e) => e.termId !== termId));
  }, []);

  // ── selection + editors ───────────────────────────────────────────────────────

  const selectTerm = useCallback((termId: string) => {
    setSelected((prev) => (prev?.kind === "term" && prev.id === termId ? null : { kind: "term", id: termId }));
    setPreview(false);
  }, []);

  const selectNote = useCallback(
    (noteId: string) => {
      setSelected((prev) => (prev?.kind === "note" && prev.id === noteId ? null : { kind: "note", id: noteId }));
      setPreview(false);
      const el = notes.elements.find((e) => e.id === noteId);
      setNoteTitleDraft(titleOf(el));
    },
    [notes.elements],
  );

  const composeNote = useCallback((afterId: string | null) => {
    setSelected({ kind: "new-note", afterId });
    setNoteTitleDraft("");
    setPreview(false);
  }, []);

  const selectedNoteEl = selected?.kind === "note" ? notes.elements.find((e) => e.id === selected.id) : undefined;
  const selectedTermEl = selected?.kind === "term" ? glossary.elements.find((e) => e.id === selected.id) : undefined;

  // Selecting a note seeds its editor with its current markdown — the FIRST time only.
  useEffect(() => {
    if (!restored || selected?.kind !== "note" || selectedNoteEl === undefined) return;
    const id = selected.id;
    if (noteDrafts[id] !== undefined || seeding.current === `note:${id}`) return;
    seeding.current = `note:${id}`;
    setSeedBusy(true);
    void (async () => {
      let seed = "";
      try {
        const h = await getHost();
        seed = splitRenderedElement(await h.renderElement(workspaceId, pageId, NOTES_KEY, id)).body;
      } catch {
        // fall back to an empty editor; the card still shows the content
      }
      setNoteDrafts((d) => (d[id] !== undefined ? d : { ...d, [id]: seed }));
      setSeedBusy(false);
      if (seeding.current === `note:${id}`) seeding.current = null;
    })();
  }, [restored, selected, selectedNoteEl, noteDrafts, workspaceId, pageId]);

  // Selecting a term seeds its definition editor from the stored definition.
  useEffect(() => {
    if (!restored || selected?.kind !== "term" || selectedTermEl === undefined) return;
    const id = selected.id;
    if (termDrafts[id] !== undefined || seeding.current === `term:${id}`) return;
    seeding.current = `term:${id}`;
    setSeedBusy(true);
    void (async () => {
      let seed = "";
      try {
        const h = await getHost();
        seed = definitionFromBody(splitRenderedElement(await h.renderElement(workspaceId, pageId, GLOSSARY_KEY, id)).body);
      } catch {
        // fall back to an empty editor
      }
      setTermDrafts((d) => (d[id] !== undefined ? d : { ...d, [id]: seed }));
      setSeedBusy(false);
      if (seeding.current === `term:${id}`) seeding.current = null;
    })();
  }, [restored, selected, selectedTermEl, termDrafts, workspaceId, pageId]);

  const onSaveNote = useCallback(async () => {
    if (selected?.kind === "note") {
      const body = noteDrafts[selected.id] ?? "";
      const title = noteTitleDraft.trim();
      if (title === "") return;
      const ok = await runMutation("reviseNote", { noteId: selected.id, title, markdown: body });
      if (ok) {
        setSelected(null);
        setNoteDrafts((d) => omit(d, selected.id));
      }
    } else if (selected?.kind === "new-note") {
      const body = noteDrafts[""] ?? "";
      const title = noteTitleDraft.trim();
      if (title === "") return;
      const ok = await runMutation("captureNote", {
        title,
        markdown: body,
        ...(selected.afterId !== null ? { afterId: selected.afterId } : {}),
      });
      if (ok) {
        setSelected(null);
        setNoteDrafts((d) => omit(d, ""));
      }
    }
  }, [selected, noteDrafts, noteTitleDraft, runMutation]);

  const onSaveDefinition = useCallback(async () => {
    if (selected?.kind !== "term") return;
    const id = selected.id;
    const markdown = (termDrafts[id] ?? "").trim();
    if (markdown === "") return;
    // A stale in-flight evaluation is about text that no longer exists.
    cancelEval(id);
    const ok = await runMutation("defineTerm", { termId: id, markdown });
    if (ok && criticReady) enqueueEval(id, markdown);
  }, [selected, termDrafts, runMutation, cancelEval, criticReady, enqueueEval]);

  const onRemoveTerm = useCallback(
    async (termId: string) => {
      cancelEval(termId);
      const ok = await runMutation("unmarkTerm", { termId });
      if (ok) setSelected((prev) => (prev?.kind === "term" && prev.id === termId ? null : prev));
    },
    [cancelEval, runMutation],
  );

  // ── note structure ────────────────────────────────────────────────────────────

  const onMove = useCallback(
    (id: string, toIndex: number) => void runMutation("moveNote", { noteId: id, toIndex }),
    [runMutation],
  );
  const onRemoveNote = useCallback(
    async (id: string) => {
      const ok = await runMutation("removeNote", { noteId: id });
      if (ok) setDeleting(null);
    },
    [runMutation],
  );
  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  // ── derived views ─────────────────────────────────────────────────────────────

  const hidden = useMemo(() => hiddenByCollapse(notes.elements, collapsed), [notes.elements, collapsed]);
  const marked = glossary.elements.filter((e) => e.status === "marked");
  const defined = glossary.elements.filter((e) => e.status === "defined");
  const checked = glossary.elements.filter((e) => e.status === "checked");
  const evaluating = Object.keys(evalRuns).length > 0 || evalQueue.length > 0;

  const draftKey = selected?.kind === "note" ? selected.id : selected?.kind === "new-note" ? "" : null;
  const noteDraft = draftKey === null ? "" : (noteDrafts[draftKey] ?? "");
  const termDraft = selected?.kind === "term" ? (termDrafts[selected.id] ?? "") : "";
  const draftHtml = useMemo(() => {
    const text = selected?.kind === "term" ? termDraft : noteDraft;
    return preview && text.trim() !== "" ? renderMarkdown(text, workspaceId) : "";
  }, [preview, selected, termDraft, noteDraft, workspaceId]);

  const editorTabs = (
    <div className="view-toggle" role="tablist" aria-label="Editor or preview">
      <button type="button" role="tab" aria-selected={!preview} className={`view-tab ${preview ? "" : "active"}`} onClick={() => setPreview(false)}>
        Edit
      </button>
      <button type="button" role="tab" aria-selected={preview} className={`view-tab ${preview ? "active" : ""}`} onClick={() => setPreview(true)}>
        Preview
      </button>
    </div>
  );

  const mutationNotice =
    mutationError === null ? null : (
      <div className="notice error">
        {mutationError}{" "}
        <button type="button" className="restate-cancel" onClick={resetMutation}>
          Dismiss
        </button>
      </div>
    );

  // ── workbench: term panel ─────────────────────────────────────────────────────

  const termPanel = ((): React.ReactNode => {
    if (selected?.kind !== "term" || selectedTermEl === undefined) return null;
    const id = selected.id;
    const termStatus = selectedTermEl.status ?? "marked";
    const grade = gradeOf(selectedTermEl);
    const evalState = evals[id];
    const running = evalRuns[id] !== undefined;
    const queued = evalQueue.some((e) => e.termId === id);
    const occurrences = notesMarkdown === null ? 0 : findTermMatches(notesMarkdown, [{ id, term: titleOf(selectedTermEl) }]).length;
    return (
      <TermPanel
        workspaceId={workspaceId}
        pageId={pageId}
        el={selectedTermEl}
        termStatus={termStatus}
        grade={grade}
        draft={termDraft}
        setDraft={(text) => setTermDrafts((d) => ({ ...d, [id]: text }))}
        preview={preview}
        draftHtml={draftHtml}
        editorTabs={editorTabs}
        seedBusy={seedBusy}
        capturing={capturing}
        mutating={mutating}
        occurrences={occurrences}
        evalState={evalState}
        running={running}
        queued={queued}
        startedAt={evalRuns[id]?.startedAt ?? null}
        criticReady={criticReady}
        criticGate={criticGate}
        onSave={() => void onSaveDefinition()}
        onEvaluate={() => enqueueEval(id, termDraft.trim() !== "" ? termDraft : null)}
        onCancelEval={() => cancelEval(id)}
        onRemove={() => void onRemoveTerm(id)}
        onClose={() => setSelected(null)}
      />
    );
  })();

  // ── workbench: note editor ────────────────────────────────────────────────────

  const noteEditor = ((): React.ReactNode => {
    if (selected?.kind !== "note" && selected?.kind !== "new-note") return null;
    const isNew = selected.kind === "new-note";
    const candidates = boldCandidates(noteDraft, termRefs.map((t) => t.term));
    return (
      <section className="restate-block restate-block-editor restate-block-selected">
        <div className="restate-block-head-row">
          <h2 className="restate-block-head">{isNew ? "New note" : "Edit note"}</h2>
          {editorTabs}
        </div>
        {isNew && selected.afterId !== null && (
          <p className="restate-sources">
            Inserting after <span className="restate-source">{titleOf(notes.elements.find((e) => e.id === selected.afterId))}</span> (and its subnotes).
          </p>
        )}
        <input
          type="text"
          className="restate-compose-title"
          value={noteTitleDraft}
          placeholder="Note title (a chapter, a section, a topic…)"
          aria-label="Note title"
          onChange={(e) => setNoteTitleDraft(e.target.value)}
        />
        {preview ? (
          draftHtml === "" ? (
            <p className="muted restate-preview restate-preview-empty">Nothing to preview yet.</p>
          ) : (
            /* eslint-disable-next-line react/no-danger */
            <div className="markdown restate-preview" dangerouslySetInnerHTML={{ __html: draftHtml }} />
          )
        ) : (
          <textarea
            className="restate-draft"
            value={noteDraft}
            spellCheck
            placeholder={seedBusy ? "Loading the note…" : "Write your notes… (bold a term with **term** to make it a glossary candidate)"}
            onChange={(e) => {
              const text = e.target.value;
              if (draftKey !== null) setNoteDrafts((d) => ({ ...d, [draftKey]: text }));
            }}
          />
        )}
        {candidates.length > 0 && (
          <div className="study-candidates">
            <span className="study-candidates-label">Terms?</span>
            {candidates.map((term) => (
              <button key={term} type="button" className="study-chip" title={`Add "${term}" to the glossary`} onClick={() => void onMarkTerm(term)}>
                + {term}
              </button>
            ))}
          </div>
        )}
        <div className="restate-actions">
          <button type="button" className="tf-btn tf-btn-secondary" onClick={() => setSelected(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="tf-btn tf-btn-primary"
            disabled={mutating || noteTitleDraft.trim() === ""}
            onClick={() => void onSaveNote()}
          >
            {mutating ? "Committing…" : isNew ? "Add note" : "Save note"}
          </button>
        </div>
        {mutationNotice}
      </section>
    );
  })();

  // ── workbench: the glossary rail ──────────────────────────────────────────────

  const termRow = (el: SectionElementSummary): React.JSX.Element => {
    const running = evalRuns[el.id] !== undefined;
    const queued = evalQueue.some((e) => e.termId === el.id);
    const grade = gradeOf(el);
    const isSel = selected?.kind === "term" && selected.id === el.id;
    return (
      <li key={el.id}>
        <button type="button" className={`study-term-row${isSel ? " is-selected" : ""}`} onClick={() => selectTerm(el.id)}>
          <span className="study-term-name">{titleOf(el)}</span>
          {running ? (
            <span className="restate-badge study-badge-running">Evaluating…</span>
          ) : queued ? (
            <span className="restate-badge">Queued</span>
          ) : el.status === "checked" && grade !== "" ? (
            <span className={`restate-badge restate-grade-${grade}`}>{GRADE_LABEL[grade as CritiqueGrade] ?? grade}</span>
          ) : (
            <span className={`restate-badge study-badge-${el.status ?? "marked"}`}>{STATUS_LABEL[el.status ?? "marked"] ?? el.status}</span>
          )}
        </button>
      </li>
    );
  };

  const glossaryRail = (
    <section className="restate-block">
      <div className="restate-block-head-row">
        <h2 className="restate-block-head">Glossary</h2>
        {defined.length > 0 && capturing && (
          <button
            type="button"
            className="tf-btn tf-btn-secondary"
            disabled={!criticReady || mutating}
            title={criticGate ?? "Queue an evaluation for every defined-but-unchecked term"}
            onClick={() => defined.forEach((e) => enqueueEval(e.id, null))}
          >
            Evaluate defined ({defined.length})
          </button>
        )}
      </div>
      {capturing && (
        <div className="study-add-term">
          <input
            type="text"
            value={newTerm}
            placeholder="Add a term…"
            aria-label="Add a term to the glossary"
            onChange={(e) => setNewTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newTerm.trim() !== "" && !mutating) {
                void onMarkTerm(newTerm);
                setNewTerm("");
              }
            }}
          />
          <button
            type="button"
            className="tf-btn tf-btn-secondary"
            disabled={mutating || newTerm.trim() === ""}
            onClick={() => {
              void onMarkTerm(newTerm);
              setNewTerm("");
            }}
          >
            Mark
          </button>
        </div>
      )}
      {glossary.loading && glossary.elements.length === 0 ? (
        <p className="muted">Loading glossary…</p>
      ) : glossary.elements.length === 0 ? (
        <p className="muted">
          No terms yet. Select text in a note, click a suggested <span className="study-chip study-chip-demo">+ term</span> chip, or type one
          above.
        </p>
      ) : (
        <>
          {marked.length > 0 && (
            <>
              <h3 className="study-rail-head">Needs definition ({marked.length})</h3>
              <ul className="study-term-list">{marked.map(termRow)}</ul>
            </>
          )}
          {defined.length > 0 && (
            <>
              <h3 className="study-rail-head">Defined ({defined.length})</h3>
              <ul className="study-term-list">{defined.map(termRow)}</ul>
            </>
          )}
          {checked.length > 0 && (
            <>
              <h3 className="study-rail-head">Checked ({checked.length})</h3>
              <ul className="study-term-list">{checked.map(termRow)}</ul>
            </>
          )}
        </>
      )}
      {criticGate !== null && health !== null && (
        <p className="muted restate-health">Auto-evaluation unavailable: {criticGate}. Defining terms still works.</p>
      )}
    </section>
  );

  // ── render ────────────────────────────────────────────────────────────────────

  const total = glossary.elements.length;

  return (
    <>
      <div className="restate-bar">
        <p className="restate-progress">
          {notes.elements.length} note{notes.elements.length === 1 ? "" : "s"} · {total} term{total === 1 ? "" : "s"}
          {marked.length > 0 && <span className="study-bar-marked"> · {marked.length} need{marked.length === 1 ? "s" : ""} a definition</span>}
          {checked.length > 0 && ` · ${checked.length} checked`}
          {evaluating && <span className="study-bar-evaluating"> · evaluating…</span>}
        </p>
        {(notes.error !== null || glossary.error !== null) && (
          <p className="restate-load-error" role="alert">
            Couldn&apos;t refresh: {notes.error ?? glossary.error}. Showing the last good read.
          </p>
        )}
        {!capturing && (
          <span className="restate-bar-note">
            {status} — reopen from the <Link href={pageHref(workspaceId, pageId, "model")}>Model view</Link> to keep capturing
          </span>
        )}
        {capturing && marked.length === 0 && total > 0 && (
          <span className="restate-bar-note" title="finish is a human gate on the Model view">
            every term defined — <Link href={pageHref(workspaceId, pageId, "model")}>finish from the Model view</Link>
          </span>
        )}
        {capturing && (
          <button type="button" className="restate-bar-btn" onClick={() => composeNote(notes.elements.length > 0 ? notes.elements[notes.elements.length - 1]!.id : null)}>
            + Add note
          </button>
        )}
        {notes.elements.length > 0 && (
          <button
            type="button"
            className="restate-bar-btn"
            onClick={() =>
              setCollapsed((prev) => (prev.size === notes.elements.length ? new Set() : new Set(notes.elements.map((e) => e.id))))
            }
          >
            {collapsed.size === notes.elements.length ? "Expand all" : "Collapse all"}
          </button>
        )}
      </div>
      <div ref={studioRef} className="restate-studio study-studio">
        {floatMark !== null && (
          <button
            type="button"
            className="study-float-mark"
            style={{ left: floatMark.x, top: floatMark.y }}
            disabled={mutating}
            onClick={() => void onMarkTerm(floatMark.text)}
          >
            + Add &ldquo;{floatMark.text}&rdquo; to glossary
          </button>
        )}
        <section ref={notesColRef} className="restate-spec" aria-label="Notes" onMouseUp={onNotesMouseUp}>
          {notes.elements.map((el, i) => {
            if (hidden.has(el.id)) return null;
            const depth = depthOf(el);
            const kids = subtreeIds(notes.elements, i).length - 1;
            return (
              <Fragment key={el.id}>
                <NoteCard
                  workspaceId={workspaceId}
                  pageId={pageId}
                  el={el}
                  terms={termRefs}
                  selectable={capturing}
                  selected={selected?.kind === "note" && selected.id === el.id}
                  onSelect={() => selectNote(el.id)}
                  onTermClick={selectTerm}
                  onMarkCandidate={capturing ? (t) => void onMarkTerm(t) : null}
                  depth={depth}
                  childCount={kids}
                  structure={
                    !capturing
                      ? null
                      : {
                          canUp: siblingMoveTarget(notes.elements, i, "up") !== null,
                          canDown: siblingMoveTarget(notes.elements, i, "down") !== null,
                          onUp: () => {
                            const to = siblingMoveTarget(notes.elements, i, "up");
                            if (to !== null) onMove(el.id, to);
                          },
                          onDown: () => {
                            const to = siblingMoveTarget(notes.elements, i, "down");
                            if (to !== null) onMove(el.id, to);
                          },
                          canIndent: canIndent(notes.elements, i),
                          canOutdent: canOutdent(notes.elements, i),
                          onIndent: () => void runMutation("indentNote", { noteId: el.id }),
                          onOutdent: () => void runMutation("outdentNote", { noteId: el.id }),
                          collapsed: collapsed.has(el.id),
                          onToggleCollapse: () => toggleCollapse(el.id),
                          deleting: deleting === el.id,
                          onToggleDelete: () => setDeleting((prev) => (prev === el.id ? null : el.id)),
                          onDelete: () => void onRemoveNote(el.id),
                          busy: mutating,
                        }
                  }
                />
                {capturing && (
                  <div className="restate-gap" data-depth={depth}>
                    <div className="restate-gap-actions">
                      <button
                        type="button"
                        className="restate-gap-btn"
                        disabled={mutating}
                        title={`Write a new note after "${titleOf(el)}"${kids > 0 ? " and its subnotes" : ""}`}
                        onClick={() => composeNote(el.id)}
                      >
                        + Add note
                      </button>
                    </div>
                  </div>
                )}
              </Fragment>
            );
          })}
          {notes.elements.length === 0 && !notes.loading && notes.error === null && (
            <div className="notice">
              <strong>No notes yet</strong>
              <p className="muted">
                Capture your first note with <em>+ Add note</em>{capturing ? "" : " (after reopening the page)"} — write freely, bold the
                terms worth defining, and the glossary builds itself alongside.
              </p>
              {capturing && (
                <button type="button" className="tf-btn tf-btn-primary" onClick={() => composeNote(null)}>
                  + Add note
                </button>
              )}
            </div>
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
        <aside className="restate-workbench" aria-label="Study workbench">
          {termPanel}
          {noteEditor}
          {selected === null && mutationNotice}
          {glossaryRail}
        </aside>
      </div>
    </>
  );
}

// ── the term definition panel ───────────────────────────────────────────────────

function TermPanel({
  workspaceId,
  pageId,
  el,
  termStatus,
  grade,
  draft,
  setDraft,
  preview,
  draftHtml,
  editorTabs,
  seedBusy,
  capturing,
  mutating,
  occurrences,
  evalState,
  running,
  queued,
  startedAt,
  criticReady,
  criticGate,
  onSave,
  onEvaluate,
  onCancelEval,
  onRemove,
  onClose,
}: {
  workspaceId: WorkspaceId;
  pageId: PageId;
  el: SectionElementSummary;
  termStatus: string;
  grade: string;
  draft: string;
  setDraft: (text: string) => void;
  preview: boolean;
  draftHtml: string;
  editorTabs: React.ReactNode;
  seedBusy: boolean;
  capturing: boolean;
  mutating: boolean;
  occurrences: number;
  evalState: { verdict: CritiqueVerdict | null; error: string | null } | undefined;
  running: boolean;
  queued: boolean;
  startedAt: number | null;
  criticReady: boolean;
  criticGate: string | null;
  onSave: () => void;
  onEvaluate: () => void;
  onCancelEval: () => void;
  onRemove: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const { markdown } = useElementMarkdown(workspaceId, pageId, GLOSSARY_KEY, el.id);
  const storedFeedback = useMemo(() => {
    if (markdown === null) return null;
    return feedbackFromBody(splitRenderedElement(markdown).body);
  }, [markdown]);
  const storedFeedbackHtml = useMemo(
    () => (storedFeedback === null ? "" : renderMarkdown(storedFeedback, workspaceId)),
    [storedFeedback, workspaceId],
  );
  const elapsed = useElapsedSeconds(running ? startedAt : null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => setConfirmRemove(false), [el.id]);
  const verdict = evalState?.verdict ?? null;

  return (
    <section className="restate-block restate-block-editor restate-block-selected study-term-panel">
      <div className="restate-block-head-row">
        <h2 className="restate-block-head">
          {titleOf(el)}{" "}
          {termStatus === "checked" && grade !== "" ? (
            <span className={`restate-badge restate-grade-${grade}`}>{GRADE_LABEL[grade as CritiqueGrade] ?? grade}</span>
          ) : (
            <span className={`restate-badge study-badge-${termStatus}`}>{STATUS_LABEL[termStatus] ?? termStatus}</span>
          )}
        </h2>
        {capturing && editorTabs}
      </div>
      <p className="muted study-term-meta">
        {occurrences > 0 ? `${occurrences} occurrence${occurrences === 1 ? "" : "s"} in your notes` : "not found in your notes"}
        {" · "}
        <button type="button" className="restate-cancel" onClick={onClose}>
          Close
        </button>
        {" · "}
        {confirmRemove ? (
          <>
            remove this term?{" "}
            <button type="button" className="restate-cancel study-remove-confirm" disabled={mutating} onClick={onRemove}>
              Yes, remove
            </button>{" "}
            <button type="button" className="restate-cancel" onClick={() => setConfirmRemove(false)}>
              Keep
            </button>
          </>
        ) : (
          <button type="button" className="restate-cancel" disabled={!capturing} onClick={() => setConfirmRemove(true)}>
            Remove from glossary
          </button>
        )}
      </p>
      {capturing ? (
        <>
          {preview ? (
            draftHtml === "" ? (
              <p className="muted restate-preview restate-preview-empty">Nothing to preview yet — write your definition.</p>
            ) : (
              /* eslint-disable-next-line react/no-danger */
              <div className="markdown restate-preview" dangerouslySetInnerHTML={{ __html: draftHtml }} />
            )
          ) : (
            <textarea
              className="restate-draft study-definition"
              value={draft}
              spellCheck
              placeholder={seedBusy ? "Loading the definition…" : "Define this term in your own words — what it is, and why it matters…"}
              onChange={(e) => setDraft(e.target.value)}
            />
          )}
          <div className="restate-actions">
            <button
              type="button"
              className="tf-btn tf-btn-secondary"
              disabled={!criticReady || running || queued || mutating || (draft.trim() === "" && termStatus === "marked")}
              title={criticGate ?? "Evaluate this definition without saving edits first"}
              onClick={onEvaluate}
            >
              {running ? "Evaluating…" : queued ? "Queued…" : "Evaluate"}
            </button>
            <button
              type="button"
              className="tf-btn tf-btn-primary"
              disabled={draft.trim() === "" || mutating}
              title={criticReady ? "Save your definition — an evaluation queues automatically" : "Save your definition"}
              onClick={onSave}
            >
              {mutating ? "Committing…" : criticReady ? "Save & evaluate" : "Save definition"}
            </button>
          </div>
        </>
      ) : (
        <p className="muted">This page is {termStatus === "marked" ? "read-only" : "finished"} — reopen it to edit definitions.</p>
      )}

      {(running || queued || evalState !== undefined) && (
        <div className="restate-critique">
          <div className="restate-critique-head">
            <span>
              {running ? (
                `Evaluating… ${elapsed}s`
              ) : queued ? (
                "Evaluation queued…"
              ) : verdict !== null ? (
                <>
                  Evaluation <span className={`restate-badge restate-grade-${verdict.grade}`}>{GRADE_LABEL[verdict.grade]}</span>
                </>
              ) : (
                "Evaluation"
              )}
            </span>
            {(running || queued) && (
              <button type="button" className="restate-cancel" onClick={onCancelEval}>
                Cancel
              </button>
            )}
          </div>
          {verdict !== null && (
            <div className="restate-verdict">
              <p className="restate-verdict-summary">{verdict.summary}</p>
              {verdict.gaps.length > 0 && (
                <div className="restate-verdict-group">
                  <span className="restate-verdict-label restate-verdict-gaps">Gaps</span>
                  <ul>
                    {verdict.gaps.map((g, i) => (
                      <li key={i}>{g}</li>
                    ))}
                  </ul>
                </div>
              )}
              {verdict.improvements.length > 0 && (
                <div className="restate-verdict-group">
                  <span className="restate-verdict-label restate-verdict-improvements">Strengths</span>
                  <ul>
                    {verdict.improvements.map((g, i) => (
                      <li key={i}>{g}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {evalState?.error != null && <p className="error">{evalState.error}</p>}
        </div>
      )}

      {!running && !queued && evalState === undefined && storedFeedback !== null && (
        <div className="restate-critique">
          <div className="restate-critique-head">
            <span>
              Last evaluation{" "}
              {grade !== "" && <span className={`restate-badge restate-grade-${grade}`}>{GRADE_LABEL[grade as CritiqueGrade] ?? grade}</span>}
            </span>
          </div>
          {/* eslint-disable-next-line react/no-danger */}
          <div className="markdown restate-verdict" dangerouslySetInnerHTML={{ __html: storedFeedbackHtml }} />
        </div>
      )}
    </section>
  );
}
