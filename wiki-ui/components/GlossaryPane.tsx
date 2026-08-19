"use client";

/**
 * The GLOSSARY PANE — the term rail shared by every studio with a glossary: the
 * `study-notes` right column and the standalone `restatement-glossary` page. It renders
 * the rail's inner block (sticky head with filter and order, then the scrolling term
 * list); the surrounding column, and whether it collapses, belong to the host studio.
 *
 * It owns the working state of the loop — save-on-blur per term, the evaluation queue,
 * the critic health probe, the filter, the order and the armed trash — while the two
 * things the host persists (the expanded row and the definition drafts) are CONTROLLED
 * props, so a study page can keep them in the same localStorage blob as its note drafts.
 *
 * Definitions save on BLUR and then auto-evaluate: the verdict is recorded on the PAGE
 * via `recordEvaluation` (the wiki is the record, not the browser). Evaluations are
 * stateless and run a couple at a time. Note-derived extras — the `N×` reference count
 * and the critic's source excerpts — are OPTIONAL: a standalone glossary has no notes,
 * so it passes neither and the critic judges term + definition + subject alone.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PageId, WorkspaceId } from "wiki";
import { getHost } from "../lib/host-client";
import { useElementMarkdown, type SectionElements, type SectionElementSummary } from "../lib/live";
import { renderMarkdown } from "../lib/markdown";
import {
  GLOSSARY_SECTION_KEY,
  GRADE_LABEL,
  gradeOf,
  STATUS_LABEL,
  termRefsOf,
  titleOf,
  type SaveState,
  type TermRef,
} from "../lib/glossary";
import { pruneBySection, splitRenderedElement, type CritiqueGrade, type RestateHealth } from "../lib/restate";
import {
  definitionFromBody,
  evaluationFeedbackMarkdown,
  feedbackFromBody,
  fetchStudyHealth,
  parseEvaluationFeedback,
  requestEvaluation,
  termContext,
  termFilterRank,
  type StudyVerdict,
} from "../lib/study";
import { MarkdownEditor } from "./MarkdownEditor";

/** How many evaluations run concurrently (stateless calls — no shared session). */
const EVAL_CONCURRENCY = 2;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function omit<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

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

// ── one glossary term (accordion row): one glossary term (accordion row) ─────────────────────────────

interface EvalState {
  readonly verdict: StudyVerdict | null;
  readonly error: string | null;
}

/** The critic's suggested definition, blurred until deliberately revealed — reading it
 *  first would defeat the flashcard. */
function Suggestion({ text }: { text: string }): React.JSX.Element {
  const [revealed, setRevealed] = useState(false);
  useEffect(() => setRevealed(false), [text]);
  return (
    <div
      className={`study-suggestion${revealed ? " is-revealed" : ""}`}
      role={revealed ? undefined : "button"}
      title={revealed ? undefined : "Click to reveal the suggested definition"}
      onClick={() => setRevealed(true)}
    >
      <span className="restate-verdict-label study-suggestion-label">Suggestion</span>
      <span className="study-suggestion-text">{text}</span>
    </div>
  );
}

function termBadge(el: SectionElementSummary, running: boolean, queued: boolean): React.JSX.Element {
  const grade = gradeOf(el);
  if (running) return <span className="restate-badge study-badge-running">Evaluating…</span>;
  if (queued) return <span className="restate-badge">Queued</span>;
  if (el.status === "accepted") return <span className="restate-badge study-badge-accepted">✓ Accepted</span>;
  if (el.status === "checked" && grade !== "") {
    return <span className={`restate-badge restate-grade-${grade}`}>{GRADE_LABEL[grade as CritiqueGrade] ?? grade}</span>;
  }
  return <span className={`restate-badge study-badge-${el.status ?? "marked"}`}>{STATUS_LABEL[el.status ?? "marked"] ?? el.status}</span>;
}

/** The expanded term's body — its own component so the element render + draft seeding
 *  only run for the open row. */

function TermRowBody({
  workspaceId,
  pageId,
  el,
  draft,
  onDraftChange,
  onEditorBlur,
  onSeed,
  capturing,
  saveState,
  evalState,
  running,
  queued,
  startedAt,
  onCancelEval,
  onAccept,
  onReopen,
}: {
  workspaceId: WorkspaceId;
  pageId: PageId;
  el: SectionElementSummary;
  draft: string | undefined;
  onDraftChange: (text: string) => void;
  /** Focus left the definition editor: the save-and-evaluate moment. */
  onEditorBlur: () => void;
  onSeed: (text: string) => void;
  capturing: boolean;
  saveState: SaveState | undefined;
  evalState: EvalState | undefined;
  running: boolean;
  queued: boolean;
  startedAt: number | null;
  onCancelEval: () => void;
  /** The human's "I understand this" — the only exit from the working set. */
  onAccept: () => void;
  onReopen: () => void;
}): React.JSX.Element {
  const { markdown, loading } = useElementMarkdown(workspaceId, pageId, GLOSSARY_SECTION_KEY, el.id);
  const parsedBody = markdown === null ? null : splitRenderedElement(markdown).body;
  const storedFeedback = useMemo(() => {
    const raw = parsedBody === null ? null : feedbackFromBody(parsedBody);
    return raw === null ? null : parseEvaluationFeedback(raw);
  }, [parsedBody]);
  const storedFeedbackHtml = useMemo(
    () => (storedFeedback === null || storedFeedback.body === "" ? "" : renderMarkdown(storedFeedback.body, workspaceId)),
    [storedFeedback, workspaceId],
  );
  const elapsed = useElapsedSeconds(running ? startedAt : null);
  const grade = gradeOf(el);
  const verdict = evalState?.verdict ?? null;
  const termStatus = el.status ?? "marked";

  // Seed the definition editor from the stored definition — the FIRST time only; the
  // draft entry then owns the text (typing during the fetch is never overwritten).
  useEffect(() => {
    if (draft !== undefined || parsedBody === null) return;
    onSeed(definitionFromBody(parsedBody));
  }, [draft, parsedBody, onSeed]);

  const text = draft ?? (parsedBody === null ? "" : definitionFromBody(parsedBody));

  return (
    <div className="study-term-body">
      {capturing && saveState !== undefined && (
        <p className="muted study-term-meta">
          <span
            className={`study-save-state${saveState.state === "error" ? " is-error" : ""}`}
            role={saveState.state === "error" ? "alert" : "status"}
            title={saveState.state === "error" ? saveState.message : undefined}
          >
            {saveState.state === "saving" ? "Saving…" : saveState.state === "saved" ? "Saved" : "Save failed"}
          </span>
        </p>
      )}
      {capturing ? (
        <>
          <div className="study-definition-editor">
            <MarkdownEditor
              value={text}
              onChange={onDraftChange}
              onBlur={onEditorBlur}
              terms={[]}
              onTermClick={() => {}}
              submitOnEnter
              placeholder={
                draft === undefined && loading ? "Loading the definition…" : "Define this term in your own words — Enter saves and evaluates…"
              }
            />
          </div>
          {saveState?.state === "error" && (
            <p className="error study-save-error">Autosave failed: {saveState.message} — your text is kept; it retries on the next pause.</p>
          )}
        </>
      ) : parsedBody !== null && definitionFromBody(parsedBody) !== "" ? (
        /* eslint-disable-next-line react/no-danger */
        <div className="markdown restate-preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(definitionFromBody(parsedBody), workspaceId) }} />
      ) : (
        <p className="muted">No definition — reopen the page to write one.</p>
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
              {verdict.points.length > 0 && (
                <ul className="study-eval-points">
                  {verdict.points.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              )}
              {verdict.suggestion !== null && <Suggestion text={verdict.suggestion} />}
            </div>
          )}
          {evalState?.error != null && <p className="error">{evalState.error}</p>}
        </div>
      )}

      {!running && !queued && evalState === undefined && termStatus !== "marked" && grade !== "" && storedFeedback !== null && (
        <div className="restate-critique">
          <div className="restate-critique-head">
            <span>
              Last evaluation{" "}
              {grade !== "" && <span className={`restate-badge restate-grade-${grade}`}>{GRADE_LABEL[grade as CritiqueGrade] ?? grade}</span>}
            </span>
          </div>
          <div className="restate-verdict">
            {storedFeedbackHtml !== "" && (
              /* eslint-disable-next-line react/no-danger */
              <div className="markdown" dangerouslySetInnerHTML={{ __html: storedFeedbackHtml }} />
            )}
            {storedFeedback.suggestion !== null && <Suggestion text={storedFeedback.suggestion} />}
          </div>
        </div>
      )}

      {capturing && termStatus !== "marked" && (
        <div className="study-term-actions">
          {termStatus === "accepted" ? (
            <button type="button" className="restate-cancel" title="Put this term back in the working set" onClick={onReopen}>
              Reopen
            </button>
          ) : (
            <button
              type="button"
              className="restate-gap-btn"
              disabled={running || queued}
              title={running || queued ? "The evaluation lands in a moment — read it first" : "Move this term to the accepted glossary"}
              onClick={onAccept}
            >
              Mark as understood
            </button>
          )}
        </div>
      )}
    </div>
  );
}


/** The term list's own way in: the rail's `+ Add term` button swaps itself for this
 *  in-list composer. A term already in the glossary would be refused model-side, so the
 *  button opens that row instead of marking a duplicate. */
function TermComposer({
  terms,
  busy,
  onAdd,
  onReveal,
  onClose,
}: {
  terms: readonly TermRef[];
  busy: boolean;
  onAdd: (term: string) => void;
  onReveal: (termId: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [text, setText] = useState("");
  const clean = text.trim().replace(/\s+/g, " ");
  const dup = clean === "" ? undefined : terms.find((t) => t.term.trim().toLowerCase() === clean.toLowerCase());
  const submit = (): void => {
    if (clean === "" || busy) return;
    if (dup === undefined) onAdd(clean);
    else onReveal(dup.id);
    onClose();
  };
  return (
    <form
      className="study-add-term"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        type="text"
        value={text}
        autoFocus
        placeholder="New term…"
        aria-label="New glossary term"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      />
      {dup !== undefined && <p className="study-add-term-dup">Already in the glossary.</p>}
      <div className="study-add-term-actions">
        <button type="button" className="restate-cancel" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="restate-gap-btn" disabled={busy || clean === ""}>
          {dup === undefined ? "Add term" : `Open “${dup.term}”`}
        </button>
      </div>
    </form>
  );
}

// ── the pane ────────────────────────────────────────────────────────────────────

export interface GlossaryPaneProps {
  workspaceId: WorkspaceId;
  pageId: PageId;
  /** The section's live elements — the host reads them once and shares them, so a commit
   *  costs one worker read, not two. */
  glossary: SectionElements;
  /** Writes allowed: the model's glossary section is mutable in the page's status. */
  editable: boolean;
  /** What is being defined — travels to the evaluator as SUBJECT. */
  subject: string | null;
  /** Definition text per lowercased term, so the filter searches definitions without a
   *  fetch per row (see `glossaryDefinitions` — the occurrence differs by page type). */
  definitions: ReadonlyMap<string, string>;
  /** CONTROLLED: the open row, which the host persists. */
  expandedTerm: string | null;
  onExpandedTermChange: React.Dispatch<React.SetStateAction<string | null>>;
  /** CONTROLLED: definition drafts by term id, which the host persists. */
  termDrafts: Readonly<Record<string, string>>;
  onTermDraftsChange: React.Dispatch<React.SetStateAction<Readonly<Record<string, string>>>>;
  /** The host owns markTerm — it also reveals the new row once the element arrives. */
  onMarkTerm: (term: string) => void;
  /** Open a term that already exists (the composer's duplicate case). */
  onRevealTerm: (termId: string) => void;
  /** The host's page mutator, for the verbs whose errors belong in its banner. */
  runMutation: (command: string, args: Record<string, unknown>) => Promise<boolean>;
  mutating: boolean;
  /** Reported up for the host's status bar. */
  onEvaluatingChange?: (evaluating: boolean) => void;
  /** OPTIONAL, note-derived. Excerpts grounding the critic; absent = term + definition alone. */
  contextNotes?: readonly { readonly title: string; readonly markdown: string }[];
  /** OPTIONAL, note-derived. Absent hides the `N×` chip AND the order toggle. */
  termCounts?: ReadonlyMap<string, number>;
  /** Rendered beside the heading — the host's collapse control. */
  headerAction?: React.ReactNode;
  /** Shown when the glossary is empty; the host names its own ways in. */
  emptyHint?: React.ReactNode;
}

export function GlossaryPane({
  workspaceId,
  pageId,
  glossary,
  editable,
  subject,
  definitions,
  expandedTerm,
  onExpandedTermChange,
  termDrafts,
  onTermDraftsChange,
  onMarkTerm,
  onRevealTerm,
  runMutation,
  mutating,
  onEvaluatingChange,
  contextNotes,
  termCounts,
  headerAction,
  emptyHint,
}: GlossaryPaneProps): React.JSX.Element {
  const [evals, setEvals] = useState<Readonly<Record<string, EvalState>>>({});
  const [evalRuns, setEvalRuns] = useState<Readonly<Record<string, { startedAt: number }>>>({});
  const [evalQueue, setEvalQueue] = useState<readonly { termId: string; definition: string | null }[]>([]);
  const evalAborts = useRef(new Map<string, AbortController>());
  const [health, setHealth] = useState<RestateHealth | null>(null);
  /** The filter box: narrows terms by name and definition, relevance-ordered. */
  const [filterText, setFilterText] = useState("");
  /** Ordering outside a filter: stored alphabetical, or by reference count. */
  const [sortMode, setSortMode] = useState<"alpha" | "refs">("alpha");
  /** The term whose trash icon is armed — the second click deletes. */
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  /** The in-list term composer is open (the `+ Add term` button opened it). */
  const [addingTerm, setAddingTerm] = useState(false);
  const [termSaveStates, setTermSaveStates] = useState<Readonly<Record<string, SaveState>>>({});
  /** The definition the wiki last accepted per term (trimmed) — only real changes commit. */
  const termLastSaved = useRef(new Map<string, string>());

  const termRefs = useMemo<readonly TermRef[]>(() => termRefsOf(glossary.elements), [glossary.elements]);
  const showCounts = termCounts !== undefined;

  // Probe the evaluator once per mount; the gate names the reason it can't run.
  useEffect(() => {
    let cancelled = false;
    void fetchStudyHealth().then((h) => {
      if (!cancelled) setHealth(h);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const criticReady = health !== null && health.available;
  const criticGate =
    health === null ? "Probing the evaluator…" : criticReady ? null : (health.reason ?? "the evaluator is not available");

  // ── evaluation queue (async, parallel, capped) ────────────────────────────────

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
          def = definitionFromBody(splitRenderedElement(await h.renderElement(workspaceId, pageId, GLOSSARY_SECTION_KEY, termId)).body);
        }
        if (def.trim() === "") {
          land({ verdict: null, error: "nothing to evaluate — the definition is empty" });
          return;
        }
        const context = contextNotes === undefined ? "" : termContext(contextNotes, term);
        const out = await requestEvaluation({
          term,
          definition: def,
          ...(context !== "" ? { context } : {}),
          ...(subject !== null ? { subject } : {}),
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
        // Direct host call: an eval failure belongs to this term's row, not the global
        // mutation banner.
        const h = await getHost();
        try {
          await h.mutate(workspaceId, pageId, "recordEvaluation", {
            termId,
            grade: out.verdict.grade,
            markdown: evaluationFeedbackMarkdown(out.verdict),
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
    [glossary.elements, workspaceId, pageId, contextNotes, subject],
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

  // Abort every in-flight evaluation on unmount.
  useEffect(() => {
    const aborts = evalAborts.current;
    return () => {
      for (const ctrl of aborts.values()) ctrl.abort();
    };
  }, []);

  const evaluating = Object.keys(evalRuns).length > 0 || evalQueue.length > 0;
  useEffect(() => {
    onEvaluatingChange?.(evaluating);
  }, [evaluating, onEvaluatingChange]);

  // ── term editing (SAVE-ON-BLUR, then auto-evaluate) ───────────────────────────

  // The blur handler reads the LATEST drafts through refs.
  const termDraftsRef = useRef(termDrafts);
  const criticReadyRef = useRef(criticReady);
  useEffect(() => {
    termDraftsRef.current = termDrafts;
  }, [termDrafts]);
  useEffect(() => {
    criticReadyRef.current = criticReady;
  }, [criticReady]);

  /** Commit a term's definition (if dirty) — fired on editor BLUR, never mid-typing —
   *  then AUTO-EVALUATE the settled text. */
  const flushTermSave = useCallback(
    async (termId: string): Promise<void> => {
      const markdown = (termDraftsRef.current[termId] ?? "").trim();
      if (markdown === "" || termLastSaved.current.get(termId) === markdown) return;
      // A stale in-flight evaluation is about text that no longer exists.
      cancelEval(termId);
      setTermSaveStates((s) => ({ ...s, [termId]: { state: "saving" } }));
      try {
        const h = await getHost();
        await h.mutate(workspaceId, pageId, "defineTerm", { termId, markdown });
        termLastSaved.current.set(termId, markdown);
        setTermSaveStates((s) => ({ ...s, [termId]: { state: "saved" } }));
        if (criticReadyRef.current) enqueueEval(termId, markdown);
      } catch (e) {
        setTermSaveStates((s) => ({ ...s, [termId]: { state: "error", message: errText(e) } }));
      }
    },
    [workspaceId, pageId, cancelEval, enqueueEval],
  );

  // Best effort: leaving the studio commits the definition still open in the editor.
  const expandedTermRef = useRef(expandedTerm);
  useEffect(() => {
    expandedTermRef.current = expandedTerm;
  }, [expandedTerm]);
  useEffect(() => {
    return () => {
      const open = expandedTermRef.current;
      if (open !== null) void flushTermSave(open);
    };
  }, [flushTermSave]);

  /** A term's stored definition reached its editor: the autosave baseline. */
  const onTermSeeded = useCallback(
    (termId: string, text: string) => {
      if (!termLastSaved.current.has(termId)) termLastSaved.current.set(termId, text.trim());
      onTermDraftsChange((d) => (d[termId] !== undefined ? d : { ...d, [termId]: text }));
    },
    [onTermDraftsChange],
  );

  // A deleted term leaves no save baseline, verdict or in-flight evaluation behind.
  useEffect(() => {
    if (glossary.loading || glossary.error !== null) return;
    for (const termId of [...termLastSaved.current.keys()]) {
      if (!glossary.elements.some((e) => e.id === termId)) termLastSaved.current.delete(termId);
    }
    const kept = pruneBySection(termSaveStates, glossary.elements);
    if (Object.keys(kept).length !== Object.keys(termSaveStates).length) setTermSaveStates(kept);
    const keptEvals = pruneBySection(evals, glossary.elements);
    if (Object.keys(keptEvals).length !== Object.keys(evals).length) setEvals(keptEvals);
    for (const [termId, ctrl] of evalAborts.current) {
      if (!glossary.elements.some((e) => e.id === termId)) {
        ctrl.abort();
        evalAborts.current.delete(termId);
      }
    }
  }, [glossary, termSaveStates, evals]);

  const removeTerm = useCallback(
    async (termId: string) => {
      cancelEval(termId);
      const ok = await runMutation("unmarkTerm", { termId });
      if (ok) {
        onExpandedTermChange((prev) => (prev === termId ? null : prev));
        setConfirmRemoveId((prev) => (prev === termId ? null : prev));
      }
    },
    [cancelEval, runMutation, onExpandedTermChange],
  );

  // An armed trash disarms when attention moves elsewhere.
  useEffect(() => {
    if (confirmRemoveId === null) return;
    const clear = (): void => setConfirmRemoveId(null);
    window.addEventListener("click", clear, true);
    return () => window.removeEventListener("click", clear, true);
  }, [confirmRemoveId]);

  // ── derived views ─────────────────────────────────────────────────────────────

  /** The list has exactly two groups, and only the human's accept moves a term between
   *  them — defining a term or a verdict landing must never make a row jump. */
  const working = glossary.elements.filter((e) => e.status !== "accepted");
  const accepted = glossary.elements.filter((e) => e.status === "accepted");
  const total = glossary.elements.length;

  const filterQuery = filterText.trim();
  const filtering = filterQuery !== "";
  /** Filter matches across ALL statuses, relevance-ordered: name matches first. */
  const filteredTerms = useMemo(() => {
    if (!filtering) return [];
    const ranked: { el: SectionElementSummary; rank: number }[] = [];
    for (const el of glossary.elements) {
      const name = titleOf(el);
      const rank = termFilterRank(filterQuery, name, definitions.get(name.trim().toLowerCase()) ?? "");
      if (rank !== null) ranked.push({ el, rank });
    }
    ranked.sort((a, b) => a.rank - b.rank || titleOf(a.el).localeCompare(titleOf(b.el)));
    return ranked.map((r) => r.el);
  }, [filtering, filterQuery, glossary.elements, definitions]);
  const filterHasExactMatch = glossary.elements.some((e) => titleOf(e).trim().toLowerCase() === filterQuery.toLowerCase());

  /** Group ordering: stored alphabetical, or most-referenced first. */
  const sortRows = useCallback(
    (rows: readonly SectionElementSummary[]): readonly SectionElementSummary[] =>
      sortMode === "alpha" || termCounts === undefined
        ? rows
        : [...rows].sort((a, b) => (termCounts.get(b.id) ?? 0) - (termCounts.get(a.id) ?? 0) || titleOf(a).localeCompare(titleOf(b))),
    [sortMode, termCounts],
  );

  const termRow = (el: SectionElementSummary): React.JSX.Element => {
    const running = evalRuns[el.id] !== undefined;
    const queued = evalQueue.some((e) => e.termId === el.id);
    const expanded = expandedTerm === el.id;
    const count = termCounts?.get(el.id) ?? 0;
    const armed = confirmRemoveId === el.id;
    return (
      <li key={el.id} data-term-id={el.id} className={`study-term-item${expanded ? " is-expanded" : ""}`}>
        <div className="study-term-head">
          <button
            type="button"
            className={`study-term-row${expanded ? " is-selected" : ""}`}
            aria-expanded={expanded}
            onClick={() => onExpandedTermChange((prev) => (prev === el.id ? null : el.id))}
          >
            <span className="study-term-name">{titleOf(el)}</span>
            {showCounts && (
              <span
                className={`study-term-count${count === 0 ? " is-zero" : ""}`}
                title={count === 0 ? "not found in your notes" : `${count} occurrence${count === 1 ? "" : "s"} in your notes`}
              >
                {count}×
              </span>
            )}
            {termBadge(el, running, queued)}
          </button>
          {editable && (
            <button
              type="button"
              className={`restate-tool study-term-trash${armed ? " is-danger" : ""}`}
              aria-pressed={armed}
              disabled={mutating}
              title={armed ? `Click again to remove "${titleOf(el)}"` : "Remove this term"}
              onClick={() => {
                if (armed) void removeTerm(el.id);
                else setConfirmRemoveId(el.id);
              }}
            >
              🗑
            </button>
          )}
        </div>
        {expanded && (
          <TermRowBody
            workspaceId={workspaceId}
            pageId={pageId}
            el={el}
            draft={termDrafts[el.id]}
            onDraftChange={(text) => onTermDraftsChange((d) => ({ ...d, [el.id]: text }))}
            onEditorBlur={() => void flushTermSave(el.id)}
            onSeed={(text) => onTermSeeded(el.id, text)}
            capturing={editable}
            saveState={termSaveStates[el.id]}
            evalState={evals[el.id]}
            running={running}
            queued={queued}
            startedAt={evalRuns[el.id]?.startedAt ?? null}
            onCancelEval={() => cancelEval(el.id)}
            onAccept={() => void runMutation("acceptTerm", { termId: el.id })}
            onReopen={() => void runMutation("reopenTerm", { termId: el.id })}
          />
        )}
      </li>
    );
  };

  return (
    <section className="restate-block study-rail">
      {/* Pinned while the term list scrolls: the filter and the collapse control stay
          reachable from anywhere in a long glossary. */}
      <div className="study-rail-sticky">
        <div className="restate-block-head-row">
          <span className="study-rail-title">
            <h2 className="restate-block-head">Glossary</h2>
            {headerAction}
          </span>
          <span className="study-rail-controls">
            {showCounts && total > 1 && (
              <div className="view-toggle" role="tablist" aria-label="Glossary order">
                <button
                  type="button"
                  role="tab"
                  aria-selected={sortMode === "alpha"}
                  className={`view-tab ${sortMode === "alpha" ? "active" : ""}`}
                  title="Order alphabetically"
                  onClick={() => setSortMode("alpha")}
                >
                  A–Z
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={sortMode === "refs"}
                  className={`view-tab ${sortMode === "refs" ? "active" : ""}`}
                  title="Order by how often the term appears in your notes"
                  onClick={() => setSortMode("refs")}
                >
                  Refs
                </button>
              </div>
            )}
          </span>
        </div>
        {(total > 0 || editable) && (
          <div className="study-filter">
            <input
              type="text"
              value={filterText}
              placeholder="Filter terms…"
              aria-label="Filter glossary terms by name and definition"
              onChange={(e) => setFilterText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setFilterText("");
              }}
            />
            {filtering && (
              <button type="button" className="restate-cancel" title="Clear the filter" onClick={() => setFilterText("")}>
                ✕
              </button>
            )}
          </div>
        )}
      </div>
      <div className="study-rail-body">
        {editable &&
          !filtering &&
          (addingTerm ? (
            <TermComposer
              terms={termRefs}
              busy={mutating}
              onAdd={(t) => onMarkTerm(t)}
              onReveal={onRevealTerm}
              onClose={() => setAddingTerm(false)}
            />
          ) : (
            <button
              type="button"
              className="restate-gap-btn study-add-term-open"
              disabled={mutating}
              title="Add a term to the glossary"
              onClick={() => setAddingTerm(true)}
            >
              + Add term
            </button>
          ))}
        {glossary.loading && glossary.elements.length === 0 ? (
          <p className="muted">Loading glossary…</p>
        ) : glossary.elements.length === 0 && !filtering ? (
          <p className="muted">
            {emptyHint ?? (
              <>
                No terms yet. Hit <strong>+ Add term</strong> above.
              </>
            )}
          </p>
        ) : filtering ? (
          <>
            {filteredTerms.length > 0 ? (
              <ul className="study-term-list">{filteredTerms.map(termRow)}</ul>
            ) : (
              <p className="muted">No term matches &ldquo;{filterQuery}&rdquo;.</p>
            )}
            {editable && !filterHasExactMatch && (
              <button
                type="button"
                className="study-chip study-filter-mark"
                disabled={mutating}
                title={`Add "${filterQuery}" to the glossary`}
                onClick={() => {
                  onMarkTerm(filterQuery);
                  setFilterText("");
                }}
              >
                + Mark &ldquo;{filterQuery}&rdquo; as a term
              </button>
            )}
          </>
        ) : (
          <>
            {working.length > 0 && (
              <>
                <h3 className="study-rail-head">Working ({working.length})</h3>
                <ul className="study-term-list">{sortRows(working).map(termRow)}</ul>
              </>
            )}
            {accepted.length > 0 && (
              <>
                <h3 className="study-rail-head">Accepted ({accepted.length})</h3>
                <ul className="study-term-list">{sortRows(accepted).map(termRow)}</ul>
              </>
            )}
          </>
        )}
        {criticGate !== null && health !== null && (
          <p className="muted restate-health">Auto-evaluation unavailable: {criticGate}. Defining terms still works.</p>
        )}
      </div>
    </section>
  );
}
