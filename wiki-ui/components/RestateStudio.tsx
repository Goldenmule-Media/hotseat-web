"use client";

/**
 * The Restatement Studio (feature: spec-restatement studio) — the browser UI for
 * `spec-restatement` pages. Two columns: the LEFT renders the spec per section
 * (renderElement → HTML) styled by provenance (ai-draft vs human-verified), with
 * multi-select of AI-drafted sections; the RIGHT is the workbench driven by page status —
 * restate selected sections in your own markdown, optionally stream an AI critique
 * (/api/restate/critique), Accept to atomically REPLACE them via `restateSections`
 * (born human-verified), then run the holistic review (/api/restate/review →
 * `recordHolisticReview`) and resolve notes. Page transitions (approve, reopen…) stay in
 * the existing Model view — the studio only points at them. Drafts persist per
 * workspace+page in localStorage and survive live re-renders; a selection is pruned when
 * a section vanishes or gets verified underneath it.
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
  clearRestateDraft,
  loadRestateDraft,
  fetchRestateHealth,
  pruneSelection,
  requestReview,
  resumableSession,
  saveRestateDraft,
  severityFromHeading,
  sliceH2Section,
  sourceKeyOf,
  splitDraft,
  splitRenderedElement,
  streamCritique,
  type CritiqueVerdict,
  type KeyValueStore,
  type RestateHealth,
} from "../lib/restate";
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

// ── left column: one spec section, rendered + selectable ────────────────────────

function SectionCard({
  workspaceId,
  pageId,
  el,
  selectable,
  selected,
  onToggle,
}: {
  workspaceId: WorkspaceId;
  pageId: PageId;
  el: SectionElementSummary;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
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
      onClick={(e) => {
        if (!selectable) return;
        // Links/controls inside the rendered body keep their own behaviour.
        if ((e.target as HTMLElement).closest("a, button, input, label") !== null) return;
        onToggle();
      }}
    >
      <div className="restate-section-head">
        {selectable ? (
          <label className="restate-select">
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggle}
              aria-label={`Select "${titleOf(el)}" for restatement`}
            />
            <span>Restate</span>
          </label>
        ) : (
          <span aria-hidden="true" />
        )}
        <span className={`restate-badge ${verified ? "restate-badge-verified" : "restate-badge-ai"}`}>
          {verified ? "Human-verified" : "AI draft"}
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

interface CritiqueState {
  readonly streaming: boolean;
  readonly text: string;
  readonly verdict: CritiqueVerdict | null;
  readonly error: string | null;
}

const CRITIQUE_IDLE: CritiqueState = { streaming: false, text: "", verdict: null, error: null };

/** A critique session pinned to the sources it was opened with (see sourceKeyOf). */
interface CritiqueSession {
  readonly id: string;
  readonly sourceKey: string;
}

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

  const [selected, setSelected] = useState<readonly string[]>([]);
  const [draft, setDraft] = useState("");
  const [session, setSession] = useState<CritiqueSession | undefined>(undefined);
  const [restored, setRestored] = useState(false);
  const [health, setHealth] = useState<RestateHealth | null>(null);
  const [critique, setCritique] = useState<CritiqueState>(CRITIQUE_IDLE);
  const critiqueAbort = useRef<AbortController | null>(null);
  /** Bumped whenever a critique run is superseded (new run, Accept, unmount) so a stale
   *  stream's deltas/continuation can't touch state after the fact. */
  const critiqueGen = useRef(0);
  const [reviewRun, setReviewRun] = useState<{ running: boolean; startedAt: number | null; error: string | null }>({
    running: false,
    startedAt: null,
    error: null,
  });
  const [elapsed, setElapsed] = useState(0);
  const reviewAbort = useRef<AbortController | null>(null);

  // Restore the persisted draft once per mount (the parent keys this component by page).
  useEffect(() => {
    const store = browserStore();
    const saved = store !== null ? loadRestateDraft(store, workspaceId, pageId) : null;
    if (saved !== null) {
      setSelected(saved.selectedIds);
      setDraft(saved.draft);
      if (saved.sessionId !== undefined && saved.sourceKey !== undefined) {
        setSession({ id: saved.sessionId, sourceKey: saved.sourceKey });
      }
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

  // Selections survive live re-renders only while their ids still exist as ai-draft.
  // Skipped while the element read is errored — stale elements must not prune a live
  // selection. An ACTUAL removal also drops the critique session: its sources changed.
  useEffect(() => {
    if (!restored || elementsLoading || elementsError !== null) return;
    const next = pruneSelection(selected, elements);
    if (next.length !== selected.length) {
      setSelected(next);
      setSession(undefined);
    }
  }, [restored, elementsLoading, elementsError, elements, selected]);

  // Persist {selectedIds, draft, sessionId+sourceKey}; an all-empty state clears the key.
  useEffect(() => {
    if (!restored) return;
    const store = browserStore();
    if (store === null) return;
    if (selected.length === 0 && draft === "" && session === undefined) {
      clearRestateDraft(store, workspaceId, pageId);
    } else {
      saveRestateDraft(store, workspaceId, pageId, {
        selectedIds: selected,
        draft,
        ...(session !== undefined ? { sessionId: session.id, sourceKey: session.sourceKey } : {}),
      });
    }
  }, [restored, selected, draft, session, workspaceId, pageId]);

  // Elapsed-seconds ticker for the long-running holistic review.
  useEffect(() => {
    if (!reviewRun.running || reviewRun.startedAt === null) return;
    const startedAt = reviewRun.startedAt;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [reviewRun.running, reviewRun.startedAt]);

  // Abandon in-flight critic/review calls when the studio unmounts.
  useEffect(
    () => () => {
      critiqueGen.current++;
      critiqueAbort.current?.abort();
      reviewAbort.current?.abort();
    },
    [],
  );

  const toggle = useCallback((id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const selectedElements = useMemo(() => elements.filter((e) => selected.includes(e.id)), [elements, selected]);
  const fallbackTitle = titleOf(selectedElements[0]);
  const verified = elements.filter((e) => e.status === "human-verified").length;
  const total = elements.length;
  const allVerified = total > 0 && verified === total;
  const workbenchActive = status === "restating" || status === "reviewing";
  const criticReady = health !== null && health.available;
  const openNotes = notes.elements.filter((n) => n.status === "open");
  const resolvedNotes = notes.elements.filter((n) => n.status !== "open");

  const overview = useMemo(() => {
    const body = specMarkdown === null ? null : sliceH2Section(specMarkdown, "Overview");
    return body === null || body === "" || body === "_None._" ? null : body;
  }, [specMarkdown]);
  const reviewSummary = useMemo(() => {
    // "last": section BODIES render before the real "## Review" heading and keep authored
    // H2s verbatim, so a section containing a literal "## Review" would shadow first-match.
    const body = specMarkdown === null ? null : sliceH2Section(specMarkdown, "Review", "last");
    return body === null || body === "" || body === "_Not reviewed._" ? null : body;
  }, [specMarkdown]);

  const conflict = mutationError !== null && mutationError.includes("removeIds not found");

  const onAccept = useCallback(async () => {
    const sections = splitDraft(draft, fallbackTitle);
    if (selected.length === 0 || sections.length === 0) return;
    const ok = await runMutation("restateSections", { removeIds: [...selected], sections });
    if (ok) {
      // Success clears everything — including any in-flight critique, whose late deltas /
      // terminal frame must not resurrect the panel or re-persist a session. On ANY
      // failure (incl. the OCC conflict) the draft, selection, critique and session stay.
      critiqueGen.current++;
      critiqueAbort.current?.abort();
      setSelected([]);
      setDraft("");
      setSession(undefined);
      setCritique(CRITIQUE_IDLE);
      const store = browserStore();
      if (store !== null) clearRestateDraft(store, workspaceId, pageId);
    }
  }, [draft, fallbackTitle, selected, runMutation, workspaceId, pageId]);

  const onCritique = useCallback(async () => {
    if (selectedElements.length === 0 || draft.trim() === "") return;
    const gen = ++critiqueGen.current;
    critiqueAbort.current?.abort();
    const ctrl = new AbortController();
    critiqueAbort.current = ctrl;
    // Resume only a session opened for THESE sources — the server ignores freshly-sent
    // sections when resuming, so a changed selection must start a fresh session.
    const key = sourceKeyOf(selectedElements.map((el) => el.id));
    const resume = resumableSession(session, key);
    setCritique({ streaming: true, text: "", verdict: null, error: null });
    let sources: { title: string; markdown: string }[];
    try {
      const h = await getHost();
      sources = await Promise.all(
        selectedElements.map(async (el) => ({
          title: titleOf(el),
          // The critic wants the source content; the rendered heading would duplicate the title.
          markdown: splitRenderedElement(await h.renderElement(workspaceId, pageId, SECTIONS_KEY, el.id)).body,
        })),
      );
    } catch (e) {
      if (critiqueGen.current !== gen) return;
      setCritique({ streaming: false, text: "", verdict: null, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    const out = await streamCritique({
      sections: sources,
      restatement: draft,
      sessionId: resume,
      signal: ctrl.signal,
      onDelta: (t) => {
        if (critiqueGen.current === gen) setCritique((c) => ({ ...c, text: c.text + t }));
      },
    });
    if (critiqueGen.current !== gen) return; // superseded by Accept / a newer run
    if (out.ok) {
      setCritique((c) => ({ ...c, streaming: false, verdict: out.verdict, error: null }));
      // Keep the session (pinned to these sources) so a follow-up round has context.
      if (out.sessionId !== undefined) setSession({ id: out.sessionId, sourceKey: key });
    } else if (ctrl.signal.aborted) {
      setCritique((c) => ({ ...c, streaming: false })); // user cancel — not a failure
    } else {
      setCritique((c) => ({ ...c, streaming: false, error: out.message }));
      // A failed resume usually means the claude session is gone — drop it so the next
      // attempt starts fresh (the sources travel in every request anyway).
      if (resume !== undefined) setSession(undefined);
    }
  }, [selectedElements, draft, session, workspaceId, pageId]);

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

        <section className="restate-block">
          <h2 className="restate-block-head">Restate</h2>
          {selectedElements.length === 0 ? (
            <p className="muted">Select one or more AI-draft sections on the left to restate them in your own words.</p>
          ) : (
            <>
              <p className="restate-sources">
                Restating {selectedElements.length === 1 ? "section" : `${selectedElements.length} sections`}:{" "}
                {selectedElements.map((el) => (
                  <span key={el.id} className="restate-source">
                    {titleOf(el)}
                  </span>
                ))}
              </p>
              <textarea
                className="restate-draft"
                value={draft}
                spellCheck
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Restate the selected sections in your own words…"
              />
              <p className="muted restate-hint">
                Start lines with <code>## Heading</code> to write multiple sections (each heading becomes a section
                title). With no headings, the whole draft becomes one section titled &ldquo;{fallbackTitle}&rdquo;.
              </p>
              <div className="restate-actions">
                <button
                  type="button"
                  className="tf-btn tf-btn-secondary"
                  disabled={!criticReady || critique.streaming || draft.trim() === "" || mutating}
                  title={criticGate ?? undefined}
                  onClick={() => void onCritique()}
                >
                  {critique.streaming ? "Critiquing…" : critique.verdict !== null ? "Get another critique" : "Get critique"}
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
                <strong>A selected section changed underneath you</strong>
                <p className="muted">
                  Someone else edited or replaced it since you selected it. Your draft is kept — re-select the current
                  sections and accept again.
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

          {(critique.streaming || critique.text !== "" || critique.verdict !== null || critique.error !== null) && (
            <div className="restate-critique">
              <div className="restate-critique-head">
                <span>Critique{critique.streaming ? " — streaming…" : ""}</span>
                {critique.streaming ? (
                  <button type="button" className="restate-cancel" onClick={() => critiqueAbort.current?.abort()}>
                    Cancel
                  </button>
                ) : (
                  <button type="button" className="restate-cancel" onClick={() => setCritique(CRITIQUE_IDLE)}>
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
    <div className="restate-studio">
      <section className="restate-spec" aria-label="Spec sections">
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
        {overview !== null && (
          /* eslint-disable-next-line react/no-danger */
          <div
            className="markdown restate-overview"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(overview, workspaceId) }}
          />
        )}
        {elements.map((el) => (
          <SectionCard
            key={el.id}
            workspaceId={workspaceId}
            pageId={pageId}
            el={el}
            selectable={workbenchActive && el.status === "ai-draft"}
            selected={selected.includes(el.id)}
            onToggle={() => toggle(el.id)}
          />
        ))}
        {total === 0 && !elementsLoading && elementsError === null && <p className="muted">No sections drafted yet.</p>}
      </section>
      <aside className="restate-workbench" aria-label="Restatement workbench">
        {workbench}
      </aside>
    </div>
  );
}
