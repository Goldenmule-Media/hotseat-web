"use client";

/**
 * The Study Studio (feature: study-notes studio) — the browser UI for `study-notes`
 * pages. Two columns. The LEFT is the notes outline, and every card IS a live markdown
 * editor (Obsidian-style: CodeMirror live preview, lib/md-live.ts) — the note reads as
 * rendered markdown, the construct under the cursor reveals its raw source, and there is
 * no edit mode at all: type anywhere, edits AUTOSAVE on a typing pause (debounced
 * `reviseNote`). Glossary-term occurrences underline by status inside the editor;
 * ⌘-click one to open it on the right.
 * Every glossary term's occurrences are highlighted in the rendered bodies by status
 * (needs-definition / defined / checked), and clicking one jumps to that term on the
 * right. The RIGHT is the glossary as an accordion: clicking a term expands it IN PLACE
 * into its definition editor (occurrences, Save & evaluate, the critic's verdict, remove).
 *
 * Marking terms is the fluid part: select any text in a note and a floating "add to
 * glossary" action appears; a note's `**bold**` runs (the learner's existing habit) are
 * offered as one-click candidate chips; and the rail takes free-typed terms. A
 * freshly-marked term expands on the right, ready to define.
 *
 * Evaluation is asynchronous and parallel (unlike the restate critic's one serialized
 * session): saving a definition auto-queues a stateless claude evaluation
 * (/api/study/evaluate), a couple run concurrently, and each verdict lands on the PAGE
 * via `recordEvaluation` (grade + feedback, term → checked) — the wiki, not the browser,
 * is the record. Editing a checked definition downgrades it honestly (`defineTerm`
 * clears the stale verdict model-side).
 *
 * A note card is in edit mode exactly when it has a DRAFT (`noteDrafts[id]`), so
 * in-progress edits survive reloads via localStorage (per workspace+page), pruned when
 * their element goes. Structure edits reuse the outline mechanics: move/indent/outdent
 * walk sibling boundaries, subtrees travel whole.
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
} from "../lib/study";
import { canIndent, canOutdent, depthOf, hiddenByCollapse, siblingMoveTarget, subtreeIds } from "../lib/outline";
import { pageHref } from "../lib/routes";
import { MarkdownEditor } from "./MarkdownEditor";

const NOTES_KEY = "notes";
const GLOSSARY_KEY = "glossary";
/** The composer's draft key in `noteDrafts` — a new note has no element id yet. */
const NEW_NOTE_KEY = "";
/** How many evaluations run concurrently (stateless calls — no shared session). */
const EVAL_CONCURRENCY = 2;
/** Autosave debounce: one `reviseNote` per typing pause, not per keystroke. */
const AUTOSAVE_MS = 1000;

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

// ── candidate chips (a body's bold runs not yet in the glossary) ────────────────

function CandidateChips({
  markdown,
  terms,
  onMark,
  busy,
}: {
  markdown: string;
  terms: readonly TermRef[];
  onMark: (term: string) => void;
  busy: boolean;
}): React.JSX.Element | null {
  const candidates = useMemo(() => boldCandidates(markdown, terms.map((t) => t.term)), [markdown, terms]);
  if (candidates.length === 0) return null;
  return (
    <div className="study-candidates">
      <span className="study-candidates-label" title="Bolded runs in this note not yet in the glossary">
        Terms?
      </span>
      {candidates.map((term) => (
        <button key={term} type="button" className="study-chip" disabled={busy} title={`Add "${term}" to the glossary`} onClick={() => onMark(term)}>
          + {term}
        </button>
      ))}
    </div>
  );
}

// ── left column: one note card (always a live editor while capturing) ───────────

/** One note's autosave status, shown quietly on the card. */
type SaveState = { readonly state: "saving" | "saved" } | { readonly state: "error"; readonly message: string };

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
  draft,
  titleDraft,
  saveState,
  onSeeded,
  onDraftChange,
  onTitleChange,
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
  /** Local edits, if any — they win over the stored body until pruned. */
  draft: string | undefined;
  titleDraft: string;
  saveState: SaveState | undefined;
  /** The stored body reached the editor: the baseline autosave diffs against. */
  onSeeded: (body: string) => void;
  onDraftChange: (text: string) => void;
  onTitleChange: (text: string) => void;
  onTermClick: (termId: string) => void;
  onMarkCandidate: (term: string) => void;
  /** Structure tools; null = the page is finished and the card renders read-only. */
  structure: NoteStructure | null;
  depth: number;
  childCount: number;
}): React.JSX.Element {
  const { markdown, loading, error } = useElementMarkdown(workspaceId, pageId, NOTES_KEY, el.id);
  const body = markdown === null ? null : splitRenderedElement(markdown).body;
  const editable = structure !== null;
  const html = useMemo(() => (!editable && body !== null ? renderMarkdown(body, workspaceId) : ""), [editable, body, workspaceId]);
  const collapsed = structure?.collapsed === true;
  // Tell the parent once when the stored body is in hand, so autosave knows the baseline.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || body === null) return;
    seededRef.current = true;
    onSeeded(body);
  }, [body, onSeeded]);
  const classes = [
    "restate-section",
    "study-note",
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
        // Read-only view: plain click on a term jumps to it (the live editor uses ⌘-click).
        if (editable) return;
        const mark = (e.target as HTMLElement).closest<HTMLElement>("mark[data-term-id]");
        if (mark?.dataset.termId !== undefined) onTermClick(mark.dataset.termId);
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
        {editable ? (
          <>
            <button
              type="button"
              className="study-collapse-btn"
              aria-expanded={!collapsed}
              title={collapsed ? "Expand this note" : "Collapse this note"}
              onClick={structure.onToggleCollapse}
            >
              {collapsed ? "▸" : "▾"}
            </button>
            <input
              type="text"
              className="study-title-inline"
              value={titleDraft}
              aria-label="Note title"
              placeholder="Note title"
              onChange={(e) => onTitleChange(e.target.value)}
            />
            {childCount > 0 && (
              <span className="restate-card-kids">
                {childCount} subnote{childCount === 1 ? "" : "s"}
              </span>
            )}
          </>
        ) : (
          <span className="restate-card-lead">
            <span className="restate-card-title">{titleOf(el)}</span>
            {childCount > 0 && (
              <span className="restate-card-kids">
                {childCount} subnote{childCount === 1 ? "" : "s"}
              </span>
            )}
          </span>
        )}
        <span className="restate-card-side">
          {saveState !== undefined && (
            <span
              className={`study-save-state${saveState.state === "error" ? " is-error" : ""}`}
              role={saveState.state === "error" ? "alert" : "status"}
              title={saveState.state === "error" ? saveState.message : undefined}
            >
              {saveState.state === "saving" ? "Saving…" : saveState.state === "saved" ? "Saved" : "Save failed"}
            </span>
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
      ) : body === null && loading ? (
        <p className="muted">Loading note…</p>
      ) : collapsed ? null : editable ? (
        <>
          <MarkdownEditor
            value={draft ?? body ?? ""}
            onChange={onDraftChange}
            terms={terms}
            onTermClick={onTermClick}
            placeholder="Write your notes… (bold a term with **term** to make it a glossary candidate)"
          />
          <CandidateChips markdown={draft ?? body ?? ""} terms={terms} onMark={onMarkCandidate} busy={structure.busy} />
          {saveState?.state === "error" && (
            <p className="error study-save-error">Autosave failed: {saveState.message} — your text is kept; it retries on the next pause.</p>
          )}
        </>
      ) : (
        <MarkedBody html={html} terms={terms} className="markdown restate-section-body study-note-body" />
      )}
    </div>
  );
}

// ── left column: the inline new-note composer ───────────────────────────────────

function NoteComposer({
  afterTitle,
  title,
  body,
  onTitleChange,
  onBodyChange,
  terms,
  onTermClick,
  onMarkCandidate,
  onSave,
  onCancel,
  busy,
}: {
  /** The note this composer inserts after, or null when appending/first. */
  afterTitle: string | null;
  title: string;
  body: string;
  onTitleChange: (t: string) => void;
  onBodyChange: (t: string) => void;
  terms: readonly TermRef[];
  onTermClick: (termId: string) => void;
  onMarkCandidate: (term: string) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
}): React.JSX.Element {
  return (
    <div className="restate-section study-note study-composer">
      <div className="restate-section-head">
        <input
          type="text"
          className="study-title-inline"
          value={title}
          autoFocus
          aria-label="Note title"
          placeholder="Note title (a chapter, a section, a topic…)"
          onChange={(e) => onTitleChange(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") onSave();
            if (e.key === "Escape") onCancel();
          }}
        />
      </div>
      {afterTitle !== null && (
        <p className="muted study-composer-hint">
          Inserting after <span className="restate-source">{afterTitle}</span> (and its subnotes).
        </p>
      )}
      <MarkdownEditor
        value={body}
        onChange={onBodyChange}
        terms={terms}
        onTermClick={onTermClick}
        placeholder="Write your notes… (bold a term with **term** to make it a glossary candidate)"
      />
      <CandidateChips markdown={body} terms={terms} onMark={onMarkCandidate} busy={busy} />
      <div className="restate-actions">
        <button type="button" className="tf-btn tf-btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="tf-btn tf-btn-primary" disabled={busy || title.trim() === ""} title="Add this note (⌘↵)" onClick={onSave}>
          {busy ? "Committing…" : "Add note"}
        </button>
      </div>
    </div>
  );
}

// ── right column: one glossary term (accordion row) ─────────────────────────────

interface EvalState {
  readonly verdict: CritiqueVerdict | null;
  readonly error: string | null;
}

function termBadge(el: SectionElementSummary, running: boolean, queued: boolean): React.JSX.Element {
  const grade = gradeOf(el);
  if (running) return <span className="restate-badge study-badge-running">Evaluating…</span>;
  if (queued) return <span className="restate-badge">Queued</span>;
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
  onSeed,
  capturing,
  mutating,
  saveState,
  evalState,
  running,
  queued,
  startedAt,
  onCancelEval,
  onRemove,
}: {
  workspaceId: WorkspaceId;
  pageId: PageId;
  el: SectionElementSummary;
  draft: string | undefined;
  onDraftChange: (text: string) => void;
  onSeed: (text: string) => void;
  capturing: boolean;
  mutating: boolean;
  saveState: SaveState | undefined;
  evalState: EvalState | undefined;
  running: boolean;
  queued: boolean;
  startedAt: number | null;
  onCancelEval: () => void;
  onRemove: () => void;
}): React.JSX.Element {
  const { markdown, loading } = useElementMarkdown(workspaceId, pageId, GLOSSARY_KEY, el.id);
  const parsedBody = markdown === null ? null : splitRenderedElement(markdown).body;
  const storedFeedback = useMemo(() => (parsedBody === null ? null : feedbackFromBody(parsedBody)), [parsedBody]);
  const storedFeedbackHtml = useMemo(
    () => (storedFeedback === null ? "" : renderMarkdown(storedFeedback, workspaceId)),
    [storedFeedback, workspaceId],
  );
  const elapsed = useElapsedSeconds(running ? startedAt : null);
  const [confirmRemove, setConfirmRemove] = useState(false);
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
      {capturing && (
        <p className="muted study-term-meta">
          {saveState !== undefined && (
            <span
              className={`study-save-state${saveState.state === "error" ? " is-error" : ""}`}
              role={saveState.state === "error" ? "alert" : "status"}
              title={saveState.state === "error" ? saveState.message : undefined}
            >
              {saveState.state === "saving" ? "Saving…" : saveState.state === "saved" ? "Saved" : "Save failed"}
            </span>
          )}
          {saveState !== undefined && " · "}
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
            <button type="button" className="restate-cancel" onClick={() => setConfirmRemove(true)}>
              Remove
            </button>
          )}
        </p>
      )}
      {capturing ? (
        <>
          <div className="study-definition-editor">
            <MarkdownEditor
              value={text}
              onChange={onDraftChange}
              terms={[]}
              onTermClick={() => {}}
              placeholder={
                draft === undefined && loading ? "Loading the definition…" : "Define this term in your own words — what it is, and why it matters…"
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

      {!running && !queued && evalState === undefined && termStatus === "checked" && storedFeedback !== null && (
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
    </div>
  );
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

  /** Note-body drafts by element id; NEW_NOTE_KEY holds the composer's body. A note card
   *  is in edit mode exactly when it has an entry here. */
  const [noteDrafts, setNoteDrafts] = useState<Readonly<Record<string, string>>>({});
  /** Note-title drafts, seeded from the element when an edit opens (session-local). */
  const [titleDrafts, setTitleDrafts] = useState<Readonly<Record<string, string>>>({});
  const [termDrafts, setTermDrafts] = useState<Readonly<Record<string, string>>>({});
  /** Where the composer inserts: afterId, or null for "first note". Hidden when absent. */
  const [composing, setComposing] = useState<{ afterId: string | null } | null>(null);
  const [expandedTerm, setExpandedTerm] = useState<string | null>(null);
  const [evals, setEvals] = useState<Readonly<Record<string, EvalState>>>({});
  const [evalRuns, setEvalRuns] = useState<Readonly<Record<string, { startedAt: number }>>>({});
  const [evalQueue, setEvalQueue] = useState<readonly { termId: string; definition: string | null }[]>([]);
  const evalAborts = useRef(new Map<string, AbortController>());
  const [restored, setRestored] = useState(false);
  const [health, setHealth] = useState<RestateHealth | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [deleting, setDeleting] = useState<string | null>(null);
  const [newTerm, setNewTerm] = useState("");
  /** After markTerm commits, expand the term once its element appears (host.mutate returns no result). */
  const [pendingTermKey, setPendingTermKey] = useState<string | null>(null);
  /** Floating "add to glossary" action for a text selection inside the notes column. */
  const [floatMark, setFloatMark] = useState<{ text: string; x: number; y: number } | null>(null);
  const studioRef = useRef<HTMLDivElement | null>(null);
  const notesColRef = useRef<HTMLElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);

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

  // Restore the persisted drafts once per mount (the parent keys this component by page).
  useEffect(() => {
    const store = browserStore();
    const saved = store !== null ? loadStudyDraft(store, workspaceId, pageId) : null;
    if (saved !== null) {
      if (saved.selected?.kind === "term") setExpandedTerm(saved.selected.id);
      setNoteDrafts(saved.noteDrafts);
      setTermDrafts(saved.termDrafts);
      if (saved.noteDrafts[NEW_NOTE_KEY] !== undefined) setComposing({ afterId: null });
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

  // Persist {expanded term, drafts}; an all-empty state clears the key.
  useEffect(() => {
    if (!restored) return;
    const store = browserStore();
    if (store === null) return;
    if (expandedTerm === null && Object.keys(noteDrafts).length === 0 && Object.keys(termDrafts).length === 0) {
      clearStudyDraft(store, workspaceId, pageId);
    } else {
      saveStudyDraft(store, workspaceId, pageId, {
        ...(expandedTerm !== null ? { selected: { kind: "term", id: expandedTerm } } : {}),
        noteDrafts,
        termDrafts,
      });
    }
  }, [restored, expandedTerm, noteDrafts, termDrafts, workspaceId, pageId]);

  // Per-element state survives live re-renders only while its element still exists.
  useEffect(() => {
    if (!restored || notes.loading || glossary.loading || notes.error !== null || glossary.error !== null) return;
    if (expandedTerm !== null && !isEditable(expandedTerm, glossary.elements)) setExpandedTerm(null);
    const keptNotes = pruneBySection(noteDrafts, notes.elements);
    // The composer's draft is keyed by NEW_NOTE_KEY, which is no element's id — keep it.
    if (noteDrafts[NEW_NOTE_KEY] !== undefined) keptNotes[NEW_NOTE_KEY] = noteDrafts[NEW_NOTE_KEY];
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
    // A deleted note's pending autosave must never fire against a gone element.
    for (const [noteId, timer] of saveTimers.current) {
      if (noteId !== NEW_NOTE_KEY && !notes.elements.some((e) => e.id === noteId)) {
        clearTimeout(timer);
        saveTimers.current.delete(noteId);
        lastSaved.current.delete(noteId);
      }
    }
  }, [restored, notes, glossary, expandedTerm, noteDrafts, termDrafts, evals, deleting]);

  /** Expand a term on the right and bring its row into view (the rail scrolls, not the window). */
  const revealTerm = useCallback((termId: string) => {
    setExpandedTerm(termId);
    requestAnimationFrame(() => {
      const rail = railRef.current;
      if (rail === null) return;
      const row = rail.querySelector<HTMLElement>(`[data-term-id="${CSS.escape(termId)}"]`);
      row?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, []);

  // A freshly-marked term (chip, selection, rail input) expands for definition on arrival.
  useEffect(() => {
    if (pendingTermKey === null) return;
    const hit = glossary.elements.find((e) => titleOf(e).trim().toLowerCase() === pendingTermKey);
    if (hit !== undefined) {
      revealTerm(hit.id);
      setPendingTermKey(null);
    }
  }, [pendingTermKey, glossary.elements, revealTerm]);

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
    // Selections inside an open editor are text edits, not term marking.
    if (anchor.parentElement !== null && anchor.parentElement.closest("textarea, input, .study-note-editor") !== null) {
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
        // Direct host call: an eval failure belongs to this term's row, not the global
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

  // ── note editing (inline, on the left; debounced autosave, no save button) ────

  const [saveStates, setSaveStates] = useState<Readonly<Record<string, SaveState>>>({});
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** What the wiki last accepted per note — autosave only commits real changes. */
  const lastSaved = useRef(new Map<string, { title: string; markdown: string }>());
  // The debounce fires from a timer, so it reads the LATEST drafts through refs.
  const noteDraftsRef = useRef(noteDrafts);
  const titleDraftsRef = useRef(titleDrafts);
  const notesElementsRef = useRef(notes.elements);
  useEffect(() => {
    noteDraftsRef.current = noteDrafts;
  }, [noteDrafts]);
  useEffect(() => {
    titleDraftsRef.current = titleDrafts;
  }, [titleDrafts]);
  useEffect(() => {
    notesElementsRef.current = notes.elements;
  }, [notes.elements]);

  /** Commit a note's pending edit now (if dirty). Resolves false only on a FAILED write. */
  const flushSave = useCallback(
    async (noteId: string): Promise<boolean> => {
      const timer = saveTimers.current.get(noteId);
      if (timer !== undefined) {
        clearTimeout(timer);
        saveTimers.current.delete(noteId);
      }
      const markdown = noteDraftsRef.current[noteId];
      if (markdown === undefined) return true;
      const el = notesElementsRef.current.find((e) => e.id === noteId);
      const title = (titleDraftsRef.current[noteId] ?? "").trim() || titleOf(el);
      const last = lastSaved.current.get(noteId);
      if (last !== undefined && last.title === title && last.markdown === markdown) return true;
      setSaveStates((s) => ({ ...s, [noteId]: { state: "saving" } }));
      try {
        const h = await getHost();
        await h.mutate(workspaceId, pageId, "reviseNote", { noteId, title, markdown });
        lastSaved.current.set(noteId, { title, markdown });
        setSaveStates((s) => ({ ...s, [noteId]: { state: "saved" } }));
        return true;
      } catch (e) {
        setSaveStates((s) => ({ ...s, [noteId]: { state: "error", message: errText(e) } }));
        return false;
      }
    },
    [workspaceId, pageId],
  );

  const scheduleSave = useCallback(
    (noteId: string) => {
      const prev = saveTimers.current.get(noteId);
      if (prev !== undefined) clearTimeout(prev);
      saveTimers.current.set(
        noteId,
        setTimeout(() => void flushSave(noteId), AUTOSAVE_MS),
      );
    },
    [flushSave],
  );

  // Best effort: leaving the studio flushes whatever pauses hadn't fired yet.
  useEffect(() => {
    const timers = saveTimers.current;
    return () => {
      for (const id of [...timers.keys()]) void flushSave(id);
    };
  }, [flushSave]);

  /** A card's stored body reached its editor: that text is the autosave baseline, so an
   *  untouched note never commits. */
  const onSeeded = useCallback(
    (noteId: string, body: string) => {
      if (lastSaved.current.has(noteId)) return;
      const el = notesElementsRef.current.find((e) => e.id === noteId);
      lastSaved.current.set(noteId, { title: titleOf(el), markdown: body });
    },
    [],
  );

  const openComposer = useCallback((afterId: string | null) => {
    setComposing({ afterId });
    setNoteDrafts((d) => (d[NEW_NOTE_KEY] !== undefined ? d : { ...d, [NEW_NOTE_KEY]: "" }));
    setTitleDrafts((t) => (t[NEW_NOTE_KEY] !== undefined ? t : { ...t, [NEW_NOTE_KEY]: "" }));
  }, []);

  const closeComposer = useCallback(() => {
    setComposing(null);
    setNoteDrafts((d) => omit(d, NEW_NOTE_KEY));
    setTitleDrafts((t) => omit(t, NEW_NOTE_KEY));
  }, []);

  const saveNewNote = useCallback(async () => {
    if (composing === null) return;
    const title = (titleDrafts[NEW_NOTE_KEY] ?? "").trim();
    if (title === "") return;
    const ok = await runMutation("captureNote", {
      title,
      markdown: noteDrafts[NEW_NOTE_KEY] ?? "",
      ...(composing.afterId !== null ? { afterId: composing.afterId } : {}),
    });
    if (ok) closeComposer();
  }, [composing, titleDrafts, noteDrafts, runMutation, closeComposer]);

  // ── term editing (inline, on the right; same autosave model as notes) ─────────

  const [termSaveStates, setTermSaveStates] = useState<Readonly<Record<string, SaveState>>>({});
  const termSaveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** The definition the wiki last accepted per term (trimmed) — only real changes commit. */
  const termLastSaved = useRef(new Map<string, string>());
  const termDraftsRef = useRef(termDrafts);
  const criticReadyRef = useRef(criticReady);
  useEffect(() => {
    termDraftsRef.current = termDrafts;
  }, [termDrafts]);
  useEffect(() => {
    criticReadyRef.current = criticReady;
  }, [criticReady]);

  /** Commit a term's pending definition now (if dirty), then AUTO-RE-EVALUATE it. */
  const flushTermSave = useCallback(
    async (termId: string): Promise<void> => {
      const timer = termSaveTimers.current.get(termId);
      if (timer !== undefined) {
        clearTimeout(timer);
        termSaveTimers.current.delete(termId);
      }
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

  const scheduleTermSave = useCallback(
    (termId: string) => {
      const prev = termSaveTimers.current.get(termId);
      if (prev !== undefined) clearTimeout(prev);
      termSaveTimers.current.set(
        termId,
        setTimeout(() => void flushTermSave(termId), AUTOSAVE_MS),
      );
    },
    [flushTermSave],
  );

  // Best effort: leaving the studio flushes definitions still waiting on their pause.
  useEffect(() => {
    const timers = termSaveTimers.current;
    return () => {
      for (const id of [...timers.keys()]) void flushTermSave(id);
    };
  }, [flushTermSave]);

  /** A term's stored definition reached its editor: the autosave baseline. */
  const onTermSeeded = useCallback((termId: string, text: string) => {
    if (!termLastSaved.current.has(termId)) termLastSaved.current.set(termId, text.trim());
    setTermDrafts((d) => (d[termId] !== undefined ? d : { ...d, [termId]: text }));
  }, []);

  // A deleted term's pending autosave must never fire against a gone element.
  useEffect(() => {
    if (glossary.loading || glossary.error !== null) return;
    for (const [termId, timer] of termSaveTimers.current) {
      if (!glossary.elements.some((e) => e.id === termId)) {
        clearTimeout(timer);
        termSaveTimers.current.delete(termId);
        termLastSaved.current.delete(termId);
      }
    }
    const kept = pruneBySection(termSaveStates, glossary.elements);
    if (Object.keys(kept).length !== Object.keys(termSaveStates).length) setTermSaveStates(kept);
  }, [glossary, termSaveStates]);

  const removeTerm = useCallback(
    async (termId: string) => {
      cancelEval(termId);
      const ok = await runMutation("unmarkTerm", { termId });
      if (ok) setExpandedTerm((prev) => (prev === termId ? null : prev));
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
  const total = glossary.elements.length;

  /** Reference counts for every term in ONE scan of the notes — the same longest-first
   *  overlap semantics as the highlighter, so counts match what is underlined. */
  const termCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (notesMarkdown === null) return counts;
    for (const m of findTermMatches(notesMarkdown, termRefs)) {
      counts.set(m.termId, (counts.get(m.termId) ?? 0) + 1);
    }
    return counts;
  }, [notesMarkdown, termRefs]);

  const mutationNotice =
    mutationError === null ? null : (
      <div className="notice error study-mutation-notice">
        {mutationError}{" "}
        <button type="button" className="restate-cancel" onClick={resetMutation}>
          Dismiss
        </button>
      </div>
    );

  const termRow = (el: SectionElementSummary): React.JSX.Element => {
    const running = evalRuns[el.id] !== undefined;
    const queued = evalQueue.some((e) => e.termId === el.id);
    const expanded = expandedTerm === el.id;
    const count = termCounts.get(el.id) ?? 0;
    return (
      <li key={el.id} data-term-id={el.id} className={`study-term-item${expanded ? " is-expanded" : ""}`}>
        <button
          type="button"
          className={`study-term-row${expanded ? " is-selected" : ""}`}
          aria-expanded={expanded}
          onClick={() => setExpandedTerm((prev) => (prev === el.id ? null : el.id))}
        >
          <span className="study-term-name">{titleOf(el)}</span>
          <span
            className={`study-term-count${count === 0 ? " is-zero" : ""}`}
            title={count === 0 ? "not found in your notes" : `${count} occurrence${count === 1 ? "" : "s"} in your notes`}
          >
            {count}×
          </span>
          {termBadge(el, running, queued)}
        </button>
        {expanded && (
          <TermRowBody
            workspaceId={workspaceId}
            pageId={pageId}
            el={el}
            draft={termDrafts[el.id]}
            onDraftChange={(text) => {
              setTermDrafts((d) => ({ ...d, [el.id]: text }));
              scheduleTermSave(el.id);
            }}
            onSeed={(text) => onTermSeeded(el.id, text)}
            capturing={capturing}
            mutating={mutating}
            saveState={termSaveStates[el.id]}
            evalState={evals[el.id]}
            running={running}
            queued={queued}
            startedAt={evalRuns[el.id]?.startedAt ?? null}
            onCancelEval={() => cancelEval(el.id)}
            onRemove={() => void removeTerm(el.id)}
          />
        )}
      </li>
    );
  };

  const composer = (afterId: string | null): React.JSX.Element => (
    <NoteComposer
      afterTitle={afterId === null ? null : titleOf(notes.elements.find((e) => e.id === afterId))}
      title={titleDrafts[NEW_NOTE_KEY] ?? ""}
      body={noteDrafts[NEW_NOTE_KEY] ?? ""}
      onTitleChange={(t) => setTitleDrafts((d) => ({ ...d, [NEW_NOTE_KEY]: t }))}
      onBodyChange={(t) => setNoteDrafts((d) => ({ ...d, [NEW_NOTE_KEY]: t }))}
      terms={termRefs}
      onTermClick={revealTerm}
      onMarkCandidate={(t) => void onMarkTerm(t)}
      onSave={() => void saveNewNote()}
      onCancel={closeComposer}
      busy={mutating}
    />
  );

  // ── render ────────────────────────────────────────────────────────────────────

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
        {capturing && composing === null && (
          <button
            type="button"
            className="restate-bar-btn"
            onClick={() => openComposer(notes.elements.length > 0 ? notes.elements[notes.elements.length - 1]!.id : null)}
          >
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
      {mutationNotice}
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
          {composing !== null && composing.afterId === null && composer(null)}
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
                  draft={noteDrafts[el.id]}
                  titleDraft={titleDrafts[el.id] ?? titleOf(el)}
                  saveState={saveStates[el.id]}
                  onSeeded={(body) => onSeeded(el.id, body)}
                  onDraftChange={(text) => {
                    setNoteDrafts((d) => ({ ...d, [el.id]: text }));
                    scheduleSave(el.id);
                  }}
                  onTitleChange={(text) => {
                    setTitleDrafts((t) => ({ ...t, [el.id]: text }));
                    scheduleSave(el.id);
                  }}
                  onTermClick={revealTerm}
                  onMarkCandidate={(t) => void onMarkTerm(t)}
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
                {composing !== null && composing.afterId === el.id && composer(el.id)}
                {capturing && (
                  <div className="restate-gap" data-depth={depth}>
                    <div className="restate-gap-actions">
                      <button
                        type="button"
                        className="restate-gap-btn"
                        disabled={mutating || composing !== null}
                        title={`Write a new note after "${titleOf(el)}"${kids > 0 ? " and its subnotes" : ""}`}
                        onClick={() => openComposer(el.id)}
                      >
                        + Add note
                      </button>
                    </div>
                  </div>
                )}
              </Fragment>
            );
          })}
          {notes.elements.length === 0 && !notes.loading && notes.error === null && composing === null && (
            <div className="notice">
              <strong>No notes yet</strong>
              <p className="muted">
                Capture your first note{capturing ? "" : " (after reopening the page)"} — write freely, bold the terms worth defining, and the
                glossary builds itself alongside.
              </p>
              {capturing && (
                <button type="button" className="tf-btn tf-btn-primary" onClick={() => openComposer(null)}>
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
        <aside ref={railRef} className="restate-workbench" aria-label="Glossary">
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
                No terms yet. Select text in a note, click a suggested <span className="study-chip study-chip-demo">+ term</span> chip, or type
                one above.
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
        </aside>
      </div>
    </>
  );
}
