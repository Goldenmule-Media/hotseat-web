"use client";

/**
 * The Restatement Studio (feature: spec-restatement studio) — the browser UI for
 * `spec-restatement` pages. Two columns: the LEFT renders the spec per section
 * (renderElement → HTML) styled by provenance (ai-draft vs human-verified), where you
 * pick ONE section at a time — an AI draft to restate, or an accepted one to edit again,
 * since the human's words are the verification either way; the RIGHT is the workbench driven by page
 * status — restate that section in your own markdown (Edit/Preview tabs over one draft,
 * the editor filling the viewport's leftover height), optionally stream an AI critique
 * (/api/restate/critique), Accept to atomically REPLACE it via `restateSections` (born
 * human-verified), then run the holistic review (/api/restate/review →
 * `recordHolisticReview`) and resolve notes. Page transitions (approve, reopen…) stay in
 * the existing Model view — the studio only points at them.
 *
 * Everything the workbench holds is keyed BY SECTION and outlives the selection: drafts
 * (seeded from the section's current markdown on first select, then persisted per
 * workspace+page in localStorage) and critique verdicts — so a critique keeps running while
 * you move on to another section, its card badges "Critique ready" when it lands, and
 * selecting that section re-opens its panel. Per-section state is dropped only when the
 * section itself goes (replaced or deleted underneath you).
 *
 * ONE claude session serves the whole page (persisted alongside the drafts): every section
 * and every re-critique resumes it, so the critic accumulates the spec. That session is a
 * single mutable resource, so only ONE critique runs at a time.
 *
 * The left panel also RESTRUCTURES the spec — add/join/split/reorder/delete, each a curated
 * model command. Structural controls never read the restatement selection: they belong to a
 * card (its title row collapses it; ↑ ↓ ✂ ✕ sit opposite) or to the gap between two cards
 * (insert here, join this pair).
 * Ids survive by design — a join keeps the top section's id and a split keeps the top
 * half's — so a draft or critique in progress there outlives the edit. Delete is the one
 * that destroys an id, so it confirms in place and names what goes with it.
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
  assembleDraft,
  clearRestateDraft,
  isEditable,
  loadRestateDraft,
  fetchRestateHealth,
  pruneBySection,
  requestCritique,
  requestReview,
  saveRestateDraft,
  sectionSplitAt,
  severityFromHeading,
  sliceH2Section,
  splitDraft,
  splitRenderedElement,
  splitTopLevelBlocks,
  type CritiqueGrade,
  type CritiqueVerdict,
  type KeyValueStore,
  type RestateHealth,
  type SectionSplit,
} from "../lib/restate";
import { clampSplit, DEFAULT_SPLIT, loadSplit, saveSplit } from "../lib/restate-split";
import {
  ancestorIds,
  canIndent,
  canOutdent,
  depthOf,
  hasChildren,
  hiddenByCollapse,
  siblingMoveTarget,
  slotOf,
  subtreeIds,
} from "../lib/outline";
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
  readonly verdict: CritiqueVerdict | null;
  readonly error: string | null;
  /** Landed while you were elsewhere — the section's card says so until you open it. */
  readonly unread: boolean;
}

/** What a section's card shows about its critique; null = nothing worth saying. */
type CritiqueTag = "running" | "ready" | "seen" | "failed";

const CRITIQUE_TAG_LABEL: Record<CritiqueTag, string> = {
  running: "Critiquing…",
  ready: "Critique ready",
  seen: "Critiqued",
  failed: "Critique failed",
};

function critiqueTag(c: CritiqueState | undefined, running: boolean): CritiqueTag | null {
  if (running) return "running";
  if (c === undefined) return null;
  if (c.error !== null) return "failed";
  if (c.verdict === null) return null;
  return c.unread ? "ready" : "seen";
}

const GRADE_LABEL: Record<CritiqueGrade, string> = {
  understood: "Understood",
  partial: "Partial",
  surface: "Surface",
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

// ── left column: structure affordances ──────────────────────────────────────────

/**
 * The live gap between two cards (and at either end of the list): where a section is
 * INSERTED, and where two adjacent sections are JOINED. Structural actions never read the
 * restatement selection — they name the sections they touch.
 */
function GapStrip({
  onAdd,
  join,
  busy,
  depth = 0,
}: {
  onAdd: () => void;
  /** The pair this gap separates, top first; null at the ends of the list. */
  join: { topTitle: string; bottomTitle: string; onRun: () => void } | null;
  busy: boolean;
  /** Indents the strip to line up with the card below it. */
  depth?: number;
}): React.JSX.Element {
  return (
    <div className="restate-gap" data-depth={depth}>
      <div className="restate-gap-actions">
        <button type="button" className="restate-gap-btn" disabled={busy} title="Write a new section here" onClick={onAdd}>
          + Add section
        </button>
        {join !== null && (
          <button
            type="button"
            className="restate-gap-btn"
            disabled={busy}
            title={`Merge "${join.bottomTitle}" into "${join.topTitle}"`}
            onClick={join.onRun}
          >
            ⇕ Join
          </button>
        )}
      </div>
    </div>
  );
}

/** The section's body as its top-level blocks, with a cut point between each pair. */
function SplitPicker({
  chunks,
  title,
  workspaceId,
  busy,
  onSplit,
  onCancel,
}: {
  chunks: readonly string[];
  title: string;
  workspaceId: WorkspaceId;
  busy: boolean;
  onSplit: (split: SectionSplit) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [at, setAt] = useState<number | null>(null);
  const proposed = useMemo(() => (at === null ? null : sectionSplitAt(chunks, at, title)), [at, chunks, title]);
  const [newTitle, setNewTitle] = useState("");
  useEffect(() => {
    if (proposed !== null) setNewTitle(proposed.newTitle);
  }, [proposed]);

  if (chunks.length < 2) {
    return (
      <div className="restate-split">
        <p className="muted restate-split-hint">
          This section is a single block — there is no boundary to split at. Restate it into several sections instead
          (<code>## Heading</code> lines in the editor).
        </p>
        <button type="button" className="restate-cancel" onClick={onCancel}>
          Done
        </button>
      </div>
    );
  }
  return (
    <div className="restate-split">
      <p className="muted restate-split-hint">Pick where to cut — everything below the line becomes a new section.</p>
      {chunks.map((chunk, i) => (
        <div key={i}>
          {i > 0 &&
            (at === i ? (
              /* The cut IS the form: you name the section being born right where it starts. */
              <div className="restate-cut is-armed">
                <input
                  type="text"
                  autoFocus
                  value={newTitle}
                  aria-label="Title for the new section"
                  placeholder="Title for the new section"
                  disabled={busy}
                  onChange={(e) => setNewTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" || proposed === null || newTitle.trim() === "" || busy) return;
                    onSplit({ ...proposed, newTitle: newTitle.trim() });
                  }}
                />
                <button
                  type="button"
                  className="tf-btn tf-btn-primary restate-cut-go"
                  disabled={busy || proposed === null || newTitle.trim() === ""}
                  onClick={() => proposed !== null && onSplit({ ...proposed, newTitle: newTitle.trim() })}
                >
                  Split here
                </button>
                <button type="button" className="restate-cut-btn" disabled={busy} onClick={() => setAt(null)}>
                  ✕
                </button>
              </div>
            ) : (
              <div className="restate-cut">
                <button type="button" className="restate-cut-btn" disabled={busy} onClick={() => setAt(i)}>
                  Split here
                </button>
              </div>
            ))}
          {/* eslint-disable-next-line react/no-danger */}
          <div
            className={`markdown restate-section-body restate-chunk${at !== null && i >= at ? " is-below" : ""}`}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(chunk, workspaceId) }}
          />
        </div>
      ))}
      <div className="restate-split-confirm">
        <button type="button" className="restate-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Reorder / nest / split / delete / collapse for one card — structure, never selection. */
interface CardStructure {
  readonly canUp: boolean;
  readonly canDown: boolean;
  readonly onUp: () => void;
  readonly onDown: () => void;
  /** Nesting: ⇥ makes this a subsection of the one above, ⇤ promotes it back out. */
  readonly canIndent: boolean;
  readonly canOutdent: boolean;
  readonly onIndent: () => void;
  readonly onOutdent: () => void;
  readonly collapsed: boolean;
  readonly onToggleCollapse: () => void;
  readonly splitting: boolean;
  readonly onToggleSplit: () => void;
  readonly onSplit: (split: SectionSplit) => void;
  /** Delete is the one structural edit that destroys an id, so it asks first. */
  readonly canDelete: boolean;
  readonly deleting: boolean;
  readonly onToggleDelete: () => void;
  readonly onDelete: () => void;
  /** What the delete would take with it ("your restatement draft"), or null. */
  readonly loses: string | null;
  readonly busy: boolean;
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
  structure,
  outline,
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
  /** Structural controls; null outside the statuses that allow restructuring. */
  structure: CardStructure | null;
  /** Where this card sits in the outline — its depth, and how it relates to the card the
   *  pointer or the selection is on, which is what lights the hierarchy rails. */
  outline: {
    readonly depth: number;
    readonly slot: string;
    readonly childCount: number;
    /** "self" | "ancestor" | "descendant" of the focused card, else null. */
    readonly relation: "self" | "ancestor" | "descendant" | null;
    readonly onFocus: () => void;
    readonly onBlur: () => void;
  };
}): React.JSX.Element {
  const { markdown, loading, error } = useElementMarkdown(workspaceId, pageId, SECTIONS_KEY, el.id);
  // The head row carries the title, so the body drops the rendered heading.
  const body = markdown === null ? null : splitRenderedElement(markdown).body;
  const html = useMemo(() => (body === null ? "" : renderMarkdown(body, workspaceId)), [body, workspaceId]);
  const chunks = useMemo(
    () => (body === null || structure?.splitting !== true ? [] : splitTopLevelBlocks(body)),
    [body, structure?.splitting],
  );
  const verified = el.status === "human-verified";
  const collapsed = structure?.collapsed === true;
  const classes = [
    "restate-section",
    verified ? "restate-section-verified" : "restate-section-ai",
    selected ? "is-selected" : "",
    selectable ? "is-selectable" : "",
    collapsed ? "is-collapsed" : "",
    outline.depth > 0 ? "is-nested" : "",
    outline.slot !== "" ? "is-slot" : "",
    outline.relation !== null ? `is-${outline.relation}` : "",
  ]
    .filter((c) => c !== "")
    .join(" ");
  return (
    <div
      className={classes}
      data-el-id={el.id}
      data-depth={outline.depth}
      onMouseEnter={outline.onFocus}
      onMouseLeave={outline.onBlur}
      onClick={(e) => {
        if (!selectable) return;
        // Links/controls inside the rendered body keep their own behaviour.
        if ((e.target as HTMLElement).closest("a, button, input, label") !== null) return;
        onToggle();
      }}
    >
      {/* One guide rail per ancestor level: the hierarchy drawn down the left margin. */}
      {outline.depth > 0 && (
        <span className="restate-rails" aria-hidden="true">
          {Array.from({ length: outline.depth }, (_, i) => (
            <span key={i} className="restate-rail" />
          ))}
        </span>
      )}
      <div className="restate-section-head">
        {/* The title owns the head row, and the whole run of it up to the controls is the
            collapse toggle — the body below carries content only. */}
        {structure === null ? (
          <span className="restate-card-lead">
            <span className="restate-card-title">{titleOf(el)}</span>
            {outline.childCount > 0 && (
              <span className="restate-card-kids">
                {outline.childCount} subsection{outline.childCount === 1 ? "" : "s"}
              </span>
            )}
          </span>
        ) : (
          <button
            type="button"
            className="restate-card-lead"
            aria-expanded={!collapsed}
            title={
              outline.childCount > 0
                ? collapsed
                  ? "Expand this section and its subsections"
                  : "Collapse this section and its subsections"
                : collapsed
                  ? "Expand this section"
                  : "Collapse this section"
            }
            onClick={(e) => {
              e.stopPropagation();
              structure.onToggleCollapse();
            }}
          >
            <span className="restate-card-title">{titleOf(el)}</span>
            {outline.childCount > 0 && (
              <span className="restate-card-kids">
                {outline.childCount} subsection{outline.childCount === 1 ? "" : "s"}
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
              aria-label={`${verified ? "Edit" : "Restate"} "${titleOf(el)}"`}
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
            >
              {verified ? (selected ? "Editing" : "Edit") : selected ? "Restating" : "Restate"}
            </button>
          )}
          {structure !== null && (
            <span className="restate-card-tools">
              <button
                type="button"
                className="restate-tool"
                disabled={!structure.canUp || structure.busy}
                aria-label={`Move "${titleOf(el)}" up`}
                title="Move up"
                onClick={(e) => {
                  e.stopPropagation();
                  structure.onUp();
                }}
              >
                ↑
              </button>
              <button
                type="button"
                className="restate-tool"
                disabled={!structure.canDown || structure.busy}
                aria-label={`Move "${titleOf(el)}" down`}
                title="Move down"
                onClick={(e) => {
                  e.stopPropagation();
                  structure.onDown();
                }}
              >
                ↓
              </button>
              <button
                type="button"
                className="restate-tool"
                disabled={!structure.canOutdent || structure.busy}
                aria-label={`Promote "${titleOf(el)}" one level`}
                title="Promote out of its parent section"
                onClick={(e) => {
                  e.stopPropagation();
                  structure.onOutdent();
                }}
              >
                ⇤
              </button>
              <button
                type="button"
                className="restate-tool"
                disabled={!structure.canIndent || structure.busy}
                aria-label={`Nest "${titleOf(el)}" under the section above`}
                title="Make this a subsection of the section above"
                onClick={(e) => {
                  e.stopPropagation();
                  structure.onIndent();
                }}
              >
                ⇥
              </button>
              <button
                type="button"
                className={`restate-tool ${structure.splitting ? "is-armed" : ""}`}
                aria-pressed={structure.splitting}
                aria-label={`Split "${titleOf(el)}"`}
                title="Split into two sections"
                onClick={(e) => {
                  e.stopPropagation();
                  structure.onToggleSplit();
                }}
              >
                ✂
              </button>
              <button
                type="button"
                className={`restate-tool ${structure.deleting ? "is-danger" : ""}`}
                aria-pressed={structure.deleting}
                disabled={!structure.canDelete || structure.busy}
                aria-label={`Delete "${titleOf(el)}"`}
                title={
                  structure.canDelete
                    ? outline.childCount > 0
                      ? "Delete this section and its subsections"
                      : "Delete this section"
                    : "A required section can be reworded or emptied, never removed"
                }
                onClick={(e) => {
                  e.stopPropagation();
                  structure.onToggleDelete();
                }}
              >
                ✕
              </button>
            </span>
          )}
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
      {structure?.deleting === true && (
        <div className="restate-confirm" role="alert">
          <span>
            Delete &ldquo;{titleOf(el)}&rdquo;?
            {outline.childCount > 0 &&
              ` Its ${outline.childCount} subsection${outline.childCount === 1 ? "" : "s"} go with it.`}
            {structure.loses !== null && ` This also discards ${structure.loses}.`}
          </span>
          <button
            type="button"
            className="tf-btn tf-btn-danger"
            disabled={structure.busy}
            onClick={(e) => {
              e.stopPropagation();
              structure.onDelete();
            }}
          >
            Delete
          </button>
          <button
            type="button"
            className="restate-cancel"
            onClick={(e) => {
              e.stopPropagation();
              structure.onToggleDelete();
            }}
          >
            Cancel
          </button>
        </div>
      )}
      {error !== null ? (
        <p className="error">{error}</p>
      ) : markdown === null && loading ? (
        <p className="muted">Loading section…</p>
      ) : collapsed ? null : structure?.splitting === true ? (
        <SplitPicker
          chunks={chunks}
          title={titleOf(el)}
          workspaceId={workspaceId}
          busy={structure.busy}
          onSplit={structure.onSplit}
          onCancel={structure.onToggleSplit}
        />
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
  /** The last critique per section id — a run outlives the selection, so these are keyed. */
  const [critiques, setCritiques] = useState<Readonly<Record<string, CritiqueState>>>({});
  /** The page's ONE critique session; every section and round resumes it. */
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [restored, setRestored] = useState(false);
  const [health, setHealth] = useState<RestateHealth | null>(null);
  /** The single in-flight critique (the session admits one at a time), and a generation
   *  bumped whenever a run is superseded (new run, cancel, Accept, unmount). */
  const [critiqueRun, setCritiqueRun] = useState<{ id: string; startedAt: number } | null>(null);
  const critiqueAbort = useRef<AbortController | null>(null);
  const critiqueGen = useRef(0);
  const [reviewRun, setReviewRun] = useState<{ running: boolean; startedAt: number | null; error: string | null }>({
    running: false,
    startedAt: null,
    error: null,
  });
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
  /** Structure: collapsed card ids, the card in split mode, and the pending insert. */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [splitting, setSplitting] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [composing, setComposing] = useState<{ beforeId?: string } | null>(null);
  const [composeTitle, setComposeTitle] = useState("");
  const [composeBody, setComposeBody] = useState("");

  const draft = selectedId === null ? "" : (drafts[selectedId] ?? "");
  const setDraft = useCallback(
    (text: string) => {
      if (selectedId !== null) setDrafts((d) => ({ ...d, [selectedId]: text }));
    },
    [selectedId],
  );

  /** Supersede the in-flight critique, if any (its late result becomes a no-op). */
  const endCritique = useCallback(() => {
    critiqueGen.current += 1;
    critiqueAbort.current?.abort();
    critiqueAbort.current = null;
    setCritiqueRun(null);
  }, []);

  // Restore the persisted draft once per mount (the parent keys this component by page).
  useEffect(() => {
    const store = browserStore();
    const saved = store !== null ? loadRestateDraft(store, workspaceId, pageId) : null;
    if (saved !== null) {
      if (saved.selectedId !== undefined) setSelectedId(saved.selectedId);
      setDrafts(saved.drafts);
      setSessionId(saved.sessionId);
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
    if (selectedId !== null && !isEditable(selectedId, elements)) setSelectedId(null);
    const keptDrafts = pruneBySection(drafts, elements);
    if (Object.keys(keptDrafts).length !== Object.keys(drafts).length) setDrafts(keptDrafts);
    // A critique belongs to its section for as long as the section is reachable — which is
    // every status now that an accepted one reopens in the editor. Only a replaced or
    // deleted section drops its critique, and a run still pointed at one ends.
    const keptCritiques = pruneBySection(critiques, elements);
    if (Object.keys(keptCritiques).length !== Object.keys(critiques).length) setCritiques(keptCritiques);
    if (critiqueRun !== null && !elements.some((e) => e.id === critiqueRun.id)) endCritique();
    // Card modes are pure UI state — drop them when the card goes (a join, someone else's edit).
    if (splitting !== null && !elements.some((e) => e.id === splitting)) setSplitting(null);
    if (deleting !== null && !elements.some((e) => e.id === deleting)) setDeleting(null);
  }, [
    restored,
    elementsLoading,
    elementsError,
    elements,
    selectedId,
    drafts,
    critiques,
    critiqueRun,
    endCritique,
    splitting,
    deleting,
  ]);

  // Looking at a critique marks it read (whether it landed before or during the visit).
  useEffect(() => {
    if (selectedId === null || critiques[selectedId]?.unread !== true) return;
    setCritiques((c) => (c[selectedId] === undefined ? c : { ...c, [selectedId]: { ...c[selectedId], unread: false } }));
  }, [selectedId, critiques]);

  // Persist {selectedId, drafts, sessionId}; an all-empty state clears the key.
  useEffect(() => {
    if (!restored) return;
    const store = browserStore();
    if (store === null) return;
    if (selectedId === null && sessionId === undefined && Object.keys(drafts).length === 0) {
      clearRestateDraft(store, workspaceId, pageId);
    } else {
      saveRestateDraft(store, workspaceId, pageId, {
        ...(selectedId !== null ? { selectedId } : {}),
        drafts,
        ...(sessionId !== undefined ? { sessionId } : {}),
      });
    }
  }, [restored, selectedId, drafts, sessionId, workspaceId, pageId]);

  // Abandon in-flight critic/review calls when the studio unmounts.
  useEffect(() => {
    const critic = critiqueAbort;
    const review = reviewAbort;
    return () => {
      critic.current?.abort();
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
      setComposing(null); // the workbench shows the editor OR the composer, never both
      if (selectedId !== id) scrollToSection(id);
    },
    [selectedId, scrollToSection],
  );

  const selectedEl = useMemo(() => elements.find((e) => e.id === selectedId), [elements, selectedId]);
  /** An already-accepted selection: the editor reworks verified words rather than restating
   *  AI ones. Same commit either way (`restateSections`) — the words stay the human's. */
  const editingVerified = selectedEl?.status === "human-verified";
  const critique = selectedId === null ? undefined : critiques[selectedId];
  const critiqueVerdict = critique?.verdict ?? null;
  const critiqueError = critique?.error ?? null;
  const critiquing = critiqueRun !== null && critiqueRun.id === selectedId;
  const critiqueElapsed = useElapsedSeconds(critiquing ? critiqueRun.startedAt : null);
  const reviewElapsed = useElapsedSeconds(reviewRun.running ? reviewRun.startedAt : null);
  const fallbackTitle = titleOf(selectedEl);
  const verified = elements.filter((e) => e.status === "human-verified").length;
  const total = elements.length;
  const allVerified = total > 0 && verified === total;
  // `restated` is the derived "every section is in your words" status — the studio stays
  // fully live there: sections can still be edited, and the review is run from it.
  const workbenchActive = status === "restating" || status === "restated" || status === "reviewing";

  // ── outline projections: the hierarchy the flat list encodes ──────────────────
  const hidden = useMemo(() => hiddenByCollapse(elements, collapsed), [elements, collapsed]);
  /** The card the pointer is over — what the hierarchy rails light up against. */
  const [focusedId, setFocusedId] = useState<string | null>(null);
  /** Ancestors and descendants of the focused (else selected) card, by id. */
  const kin = useMemo(() => {
    const anchor = focusedId ?? selectedId;
    if (anchor === null) return null;
    const at = elements.findIndex((e) => e.id === anchor);
    if (at === -1) return null;
    return {
      self: anchor,
      ancestors: new Set(ancestorIds(elements, at)),
      descendants: new Set(subtreeIds(elements, at).slice(1)),
    };
  }, [elements, focusedId, selectedId]);
  const relationOf = useCallback(
    (id: string): "self" | "ancestor" | "descendant" | null => {
      if (kin === null) return null;
      if (kin.self === id) return "self";
      if (kin.ancestors.has(id)) return "ancestor";
      return kin.descendants.has(id) ? "descendant" : null;
    },
    [kin],
  );

  /** Rubric coverage: which required slots still carry no content. */
  const coverage = useMemo(() => {
    const slots = elements.filter((e) => slotOf(e) !== "");
    return { total: slots.length, verified: slots.filter((e) => e.status === "human-verified").length };
  }, [elements]);
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
  const composeHtml = useMemo(
    () => (preview && composeBody.trim() !== "" ? renderMarkdown(composeBody, workspaceId) : ""),
    [preview, composeBody, workspaceId],
  );

  const conflict = mutationError !== null && mutationError.includes("removeIds not found");

  const onAccept = useCallback(async () => {
    const id = selectedId;
    if (id === null) return;
    const sections = splitDraft(draft, fallbackTitle);
    if (sections.length === 0) return;
    const ok = await runMutation("restateSections", { removeIds: [id], sections });
    if (ok) {
      // Success clears this section's work — including a critique still running on it,
      // whose result must not resurrect the panel. On ANY failure (incl. the OCC conflict)
      // the draft, selection and critique stay.
      if (critiqueRun?.id === id) endCritique();
      setSelectedId(null);
      setDrafts((d) => omit(d, id));
      setCritiques((c) => omit(c, id));
    }
  }, [selectedId, draft, fallbackTitle, runMutation, critiqueRun, endCritique]);

  const onCritique = useCallback(async () => {
    const id = selectedId;
    const el = selectedEl;
    if (id === null || el === undefined) return;
    const restatement = drafts[id] ?? "";
    if (restatement.trim() === "") return;
    critiqueGen.current += 1;
    const gen = critiqueGen.current;
    critiqueAbort.current?.abort();
    const ctrl = new AbortController();
    critiqueAbort.current = ctrl;
    const live = (): boolean => critiqueGen.current === gen;
    setCritiqueRun({ id, startedAt: Date.now() });
    setCritiques((c) => omit(c, id)); // the previous verdict is about text that no longer exists
    const land = (state: CritiqueState): void => {
      setCritiques((c) => ({ ...c, [id]: state }));
      setCritiqueRun(null);
    };
    let source: string;
    try {
      const h = await getHost();
      // The critic wants the source content; the rendered heading would duplicate the title.
      source = splitRenderedElement(await h.renderElement(workspaceId, pageId, SECTIONS_KEY, id)).body;
    } catch (e) {
      if (live()) land({ verdict: null, error: errText(e), unread: true });
      return;
    }
    const out = await requestCritique({
      section: { title: titleOf(el), markdown: source },
      restatement,
      sessionId,
      signal: ctrl.signal,
    });
    if (!live()) return; // superseded by Accept / a newer run / a cancel
    if (out.ok) {
      // The reply names the session to keep: the one just opened, or the fresh one the
      // server fell back to when the stored id was dead.
      if (out.sessionId !== undefined) setSessionId(out.sessionId);
      // unread is cleared on sight; it badges the card when you've moved on.
      land({ verdict: out.verdict, error: null, unread: true });
    } else if (ctrl.signal.aborted) {
      setCritiqueRun(null); // user cancel — not a failure
    } else {
      land({ verdict: null, error: out.message, unread: true });
    }
  }, [selectedId, selectedEl, drafts, sessionId, workspaceId, pageId]);

  const onRunReview = useCallback(async () => {
    if (specMarkdown === null) return;
    reviewAbort.current?.abort();
    const ctrl = new AbortController();
    reviewAbort.current = ctrl;
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

  // ── structure (the left panel): move · join · split · add ─────────────────────
  // Ids survive on purpose. Join keeps the TOP section's id and split keeps the top
  // half's, so a draft or critique in progress there outlives the edit — only the
  // absorbed section's own state is pruned (its id is gone).

  const onMove = useCallback(
    (id: string, toIndex: number) => {
      void runMutation("moveSection", { sectionId: id, toIndex });
    },
    [runMutation],
  );

  const onIndent = useCallback(
    (id: string) => {
      void runMutation("indentSection", { sectionId: id });
    },
    [runMutation],
  );

  const onOutdent = useCallback(
    (id: string) => {
      void runMutation("outdentSection", { sectionId: id });
    },
    [runMutation],
  );

  const onJoin = useCallback(
    (topId: string, bottomId: string) => {
      void runMutation("joinSections", { sectionId: topId, absorbId: bottomId });
    },
    [runMutation],
  );

  const onSplit = useCallback(
    async (id: string, split: SectionSplit) => {
      const ok = await runMutation("splitSection", { sectionId: id, ...split });
      if (ok) setSplitting(null);
    },
    [runMutation],
  );

  const onRemove = useCallback(
    async (id: string) => {
      const ok = await runMutation("removeSection", { sectionId: id });
      // The id is gone; the prune effect drops its draft and critique with it.
      if (ok) setDeleting(null);
    },
    [runMutation],
  );

  const onCompose = useCallback((beforeId: string | undefined) => {
    setSplitting(null);
    setSelectedId(null);
    setComposeTitle("");
    setComposeBody("");
    setComposing(beforeId === undefined ? {} : { beforeId });
  }, []);

  const onAddSection = useCallback(async () => {
    if (composing === null) return;
    const title = composeTitle.trim();
    const markdown = composeBody.trim();
    if (title === "" || markdown === "") return;
    const ok = await runMutation("addSection", {
      title,
      markdown,
      ...(composing.beforeId !== undefined ? { beforeId: composing.beforeId } : {}),
    });
    if (ok) {
      setComposing(null);
      setComposeTitle("");
      setComposeBody("");
    }
  }, [composing, composeTitle, composeBody, runMutation]);

  /** What a delete of this section would take with it — named in the confirm. */
  const losesWith = useCallback(
    (id: string): string | null => {
      const hasDraft = (drafts[id] ?? "").trim() !== "";
      const hasCritique = critiques[id] !== undefined || critiqueRun?.id === id;
      if (hasDraft && hasCritique) return "your restatement draft and its critique";
      if (hasDraft) return "your restatement draft";
      return hasCritique ? "its critique" : null;
    },
    [drafts, critiques, critiqueRun],
  );

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

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

  const mutationNotice =
    mutationError === null ? null : conflict ? (
      <div className="notice error restate-conflict">
        <strong>This section changed underneath you</strong>
        <p className="muted">
          Someone else edited or replaced it since you selected it. Your draft is kept — re-select the current section
          and accept again.
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
    );

  const editorTabs = (
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
  );

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

        {reviewRun.running && (
          <p className="restate-review-status" role="status">
            Reviewing… {reviewElapsed}s — the page is untouched until the review returns (this can take minutes).{" "}
            <button type="button" className="restate-cancel" onClick={() => reviewAbort.current?.abort()}>
              Cancel
            </button>
          </p>
        )}
        {reviewRun.error !== null && <div className="notice error">Holistic review failed: {reviewRun.error}</div>}

        {composing !== null && (
          <section className="restate-block restate-block-editor">
            <div className="restate-block-head-row">
              <h2 className="restate-block-head">New section</h2>
              {editorTabs}
            </div>
            <p className="restate-sources">
              Inserting{" "}
              {composing.beforeId === undefined ? (
                <span className="restate-source">at the end</span>
              ) : (
                <>
                  before <span className="restate-source">{titleOf(elements.find((e) => e.id === composing.beforeId))}</span>
                </>
              )}
              . Your own words, so it is born human-verified.
            </p>
            <input
              type="text"
              className="restate-compose-title"
              value={composeTitle}
              placeholder="Section title"
              aria-label="Section title"
              onChange={(e) => setComposeTitle(e.target.value)}
            />
            {preview ? (
              composeHtml === "" ? (
                <p className="muted restate-preview restate-preview-empty">Nothing to preview yet.</p>
              ) : (
                /* eslint-disable-next-line react/no-danger */
                <div className="markdown restate-preview" dangerouslySetInnerHTML={{ __html: composeHtml }} />
              )
            ) : (
              <textarea
                className="restate-draft"
                value={composeBody}
                spellCheck
                placeholder="Write the section…"
                onChange={(e) => setComposeBody(e.target.value)}
              />
            )}
            <div className="restate-actions">
              <button type="button" className="tf-btn tf-btn-secondary" onClick={() => setComposing(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="tf-btn tf-btn-primary"
                disabled={mutating || composeTitle.trim() === "" || composeBody.trim() === ""}
                onClick={() => void onAddSection()}
              >
                {mutating ? "Committing…" : "Add section"}
              </button>
            </div>
            {mutationNotice}
          </section>
        )}

        <section
          className={`restate-block${
            selectedEl !== undefined && composing === null ? " restate-block-editor restate-block-selected" : ""
          }`}
        >
          <div className="restate-block-head-row">
            <h2 className="restate-block-head">{editingVerified ? "Edit" : "Restate"}</h2>
            {selectedEl !== undefined && composing === null && editorTabs}
          </div>
          {composing !== null ? (
            <p className="muted">Finish or cancel the new section above to get back to restating.</p>
          ) : selectedEl === undefined ? (
            <p className="muted">
              Select a section on the left: an AI draft to restate in your own words, or one you&apos;ve accepted to
              edit.
            </p>
          ) : (
            <>
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
                {/* Nothing to accept on a section that is already verified. */}
                {!editingVerified && (
                  <button
                    type="button"
                    className="tf-btn tf-btn-secondary"
                    disabled={mutating}
                    title="Verify this section exactly as written — no restatement"
                    onClick={() => onAcceptAsIs(selectedEl.id)}
                  >
                    Accept as-is
                  </button>
                )}
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
                  placeholder={
                    seedBusy
                      ? "Loading the section…"
                      : editingVerified
                        ? "Edit this section…"
                        : "Restate this section in your own words…"
                  }
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
                  disabled={!criticReady || critiqueRun !== null || draft.trim() === "" || mutating}
                  title={
                    criticGate ??
                    (critiqueRun !== null && !critiquing
                      ? "another section is being critiqued — one at a time"
                      : undefined)
                  }
                  onClick={() => void onCritique()}
                >
                  {critiquing ? "Critiquing…" : critiqueVerdict !== null ? "Re-critique" : "Get critique"}
                </button>
                <button
                  type="button"
                  className="tf-btn tf-btn-primary"
                  disabled={draft.trim() === "" || mutating}
                  onClick={() => void onAccept()}
                >
                  {mutating ? "Committing…" : editingVerified ? "Save edits" : "Accept restatement"}
                </button>
              </div>
              {criticGate !== null && health !== null && (
                <p className="muted restate-health">
                  Critique unavailable: {criticGate}. Restating and Accept still work — critique is optional.
                </p>
              )}
            </>
          )}

          {composing === null && mutationNotice}

          {composing === null && selectedId !== null && (critiquing || critique !== undefined) && (
            <div className="restate-critique">
              <div className="restate-critique-head">
                <span>
                  {critiquing ? (
                    `Critiquing… ${critiqueElapsed}s`
                  ) : critiqueVerdict !== null ? (
                    <>
                      Critique{" "}
                      <span className={`restate-badge restate-grade-${critiqueVerdict.grade}`}>
                        {GRADE_LABEL[critiqueVerdict.grade]}
                      </span>
                    </>
                  ) : (
                    "Critique"
                  )}
                </span>
                {critiquing ? (
                  <button type="button" className="restate-cancel" onClick={endCritique}>
                    Cancel
                  </button>
                ) : (
                  <button
                    type="button"
                    className="restate-cancel"
                    onClick={() => setCritiques((c) => omit(c, selectedId))}
                  >
                    Clear
                  </button>
                )}
              </div>
              {critiqueVerdict !== null && (
                <div className="restate-verdict">
                  <p className="restate-verdict-summary">{critiqueVerdict.summary}</p>
                  {critiqueVerdict.gaps.length > 0 && (
                    <div className="restate-verdict-group">
                      <span className="restate-verdict-label restate-verdict-gaps">Gaps</span>
                      <ul>
                        {critiqueVerdict.gaps.map((g, i) => (
                          <li key={i}>{g}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {critiqueVerdict.improvements.length > 0 && (
                    <div className="restate-verdict-group">
                      <span className="restate-verdict-label restate-verdict-improvements">Improvements</span>
                      <ul>
                        {critiqueVerdict.improvements.map((g, i) => (
                          <li key={i}>{g}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
              {critiqueError !== null && <p className="error">{critiqueError}</p>}
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
          {coverage.total > 0 && (
            <span className="restate-coverage" title="The required slots every spec must address">
              {" · "}
              {coverage.verified} of {coverage.total} required
            </span>
          )}
        </p>
        {elementsError !== null && (
          <p className="restate-load-error" role="alert">
            Couldn&apos;t refresh sections: {elementsError}. Showing the last good read; your selection is kept.
          </p>
        )}
        {/* A page that was already fully restated before the status derived itself: one
            command catches it up, and the review CTA below takes over. */}
        {status === "restating" && allVerified && (
          <span className="restate-bar-cta">
            <span className="restate-bar-note">All sections verified</span>
            <button
              type="button"
              className="tf-btn tf-btn-primary restate-bar-run"
              disabled={mutating}
              title="This spec is fully restated but predates the derived status — move it to `restated`"
              onClick={() => void runMutation("completeRestatement", {})}
            >
              Mark restated
            </button>
          </span>
        )}
        {/* The spec is fully restated: the one thing left to do rides in the bar, next to
            the other whole-spec control, rather than as a panel over the editor. */}
        {status === "restated" && (
          <span className="restate-bar-cta">
            <span className="restate-bar-note">All sections verified</span>
            <button
              type="button"
              className="tf-btn tf-btn-primary restate-bar-run"
              disabled={!criticReady || reviewRun.running || mutating || specMarkdown === null}
              title={
                criticGate ??
                "Send the whole spec to the local claude CLI; its summary + notes are recorded in one commit that moves the page to reviewing"
              }
              onClick={() => void onRunReview()}
            >
              Run holistic review
            </button>
          </span>
        )}
        {workbenchActive && total > 0 && (
          <button
            type="button"
            className="restate-bar-btn"
            title="Collapsed cards make reordering a long spec manageable"
            onClick={() =>
              setCollapsed((prev) => (prev.size === total ? new Set() : new Set(elements.map((e) => e.id))))
            }
          >
            {collapsed.size === total ? "Expand all" : "Collapse all"}
          </button>
        )}
      </div>
      <div ref={studioRef} className="restate-studio">
        <section ref={specColRef} className="restate-spec" aria-label="Spec sections">
          {elements.map((el, i) => {
            if (hidden.has(el.id)) return null;
            const depth = depthOf(el);
            const kids = subtreeIds(elements, i).length - 1;
            return (
            <Fragment key={el.id}>
              {workbenchActive && (
                <GapStrip
                  onAdd={() => onCompose(el.id)}
                  depth={depth}
                  join={
                    i === 0
                      ? null
                      : {
                          topTitle: titleOf(elements[i - 1]),
                          bottomTitle: titleOf(el),
                          onRun: () => onJoin(elements[i - 1]!.id, el.id),
                        }
                  }
                  busy={mutating}
                />
              )}
              <SectionCard
                workspaceId={workspaceId}
                pageId={pageId}
                el={el}
                selectable={workbenchActive}
                selected={selectedId === el.id}
                onToggle={() => toggle(el.id)}
                critique={critiqueTag(critiques[el.id], critiqueRun?.id === el.id)}
                action={
                  !workbenchActive
                    ? null
                    : el.status === "ai-draft"
                      ? { label: "Accept as-is", busy: mutating, onRun: () => onAcceptAsIs(el.id) }
                      : el.status === "human-verified"
                        ? { label: "Unaccept", busy: mutating, onRun: () => onUnaccept(el.id) }
                        : null
                }
                outline={{
                  depth,
                  slot: slotOf(el),
                  childCount: kids,
                  relation: relationOf(el.id),
                  onFocus: () => setFocusedId(el.id),
                  onBlur: () => setFocusedId((prev) => (prev === el.id ? null : prev)),
                }}
                structure={
                  !workbenchActive
                    ? null
                    : {
                        // Reordering walks the OUTLINE: a section moves past its previous or
                        // next sibling (subtree and all), never into someone else's children.
                        canUp: siblingMoveTarget(elements, i, "up") !== null,
                        canDown: siblingMoveTarget(elements, i, "down") !== null,
                        onUp: () => {
                          const to = siblingMoveTarget(elements, i, "up");
                          if (to !== null) onMove(el.id, to);
                        },
                        onDown: () => {
                          const to = siblingMoveTarget(elements, i, "down");
                          if (to !== null) onMove(el.id, to);
                        },
                        canIndent: canIndent(elements, i),
                        canOutdent: canOutdent(elements, i),
                        onIndent: () => onIndent(el.id),
                        onOutdent: () => onOutdent(el.id),
                        collapsed: collapsed.has(el.id),
                        onToggleCollapse: () => toggleCollapse(el.id),
                        splitting: splitting === el.id,
                        onToggleSplit: () => {
                          setDeleting(null); // one card mode at a time
                          setSplitting((prev) => (prev === el.id ? null : el.id));
                        },
                        onSplit: (split) => void onSplit(el.id, split),
                        // A required slot is an obligation: it may be reworded or emptied,
                        // never removed, so the engine would refuse the command anyway.
                        canDelete: slotOf(el) === "",
                        deleting: deleting === el.id,
                        onToggleDelete: () => {
                          setSplitting(null);
                          setDeleting((prev) => (prev === el.id ? null : el.id));
                        },
                        onDelete: () => void onRemove(el.id),
                        loses: losesWith(el.id),
                        busy: mutating,
                      }
                }
              />
            </Fragment>
            );
          })}
          {workbenchActive && total > 0 && (
            <GapStrip onAdd={() => onCompose(undefined)} join={null} busy={mutating} />
          )}
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
