"use client";

/**
 * The Glossary Studio — the browser UI for `restatement-glossary` pages, and the
 * standalone sibling of the Study Studio. One column: <GlossaryPane>, the same rail
 * StudyStudio hangs on its right, at a readable measure.
 *
 * The page has no notes and no source text, so the pane gets neither `termCounts` nor
 * `contextNotes`: there are no occurrences to count and no excerpts to ground the critic,
 * which judges the term, the definition and the page title alone. Terms come in through
 * the rail's own composer and its filter.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PageId, WorkspaceId } from "wiki";
import { GLOSSARY_SECTION_KEY, glossaryDefinitions, titleOf } from "../lib/glossary";
import { usePageMutator, useSectionElements } from "../lib/live";
import { isEditable, pruneBySection, type KeyValueStore } from "../lib/restate";
import { pageHref } from "../lib/routes";
import { clearStudyDraft, loadStudyDraft, saveStudyDraft } from "../lib/study";
import { GlossaryPane } from "./GlossaryPane";

function browserStore(): KeyValueStore | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null; // storage blocked — drafts just won't persist
  }
}

export function GlossaryStudio({
  workspaceId,
  pageId,
  status,
  pageTitle,
  pageMarkdown,
}: {
  workspaceId: WorkspaceId;
  pageId: PageId;
  status: string;
  /** What is being defined — travels to the evaluator as SUBJECT. */
  pageTitle: string | null;
  /** The whole page's rendered markdown (usePage) — the rail's filter reads definitions from it. */
  pageMarkdown: string | null;
}): React.JSX.Element {
  const glossary = useSectionElements(workspaceId, pageId, GLOSSARY_SECTION_KEY);
  const { run: runMutation, pending: mutating, error: mutationError, reset: resetMutation } = usePageMutator(workspaceId, pageId);

  const [expandedTerm, setExpandedTerm] = useState<string | null>(null);
  const [termDrafts, setTermDrafts] = useState<Readonly<Record<string, string>>>({});
  const [restored, setRestored] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  /** After markTerm commits, expand the term once its element appears. */
  const [pendingTermKey, setPendingTermKey] = useState<string | null>(null);

  const collecting = status === "collecting";

  /** "first": the page's only real H2 is its Glossary, and a DEFINITION may carry its own. */
  const definitions = useMemo(() => glossaryDefinitions(pageMarkdown, "first"), [pageMarkdown]);

  // Restore the persisted drafts once per mount (the parent keys this component by page).
  useEffect(() => {
    const store = browserStore();
    const saved = store !== null ? loadStudyDraft(store, workspaceId, pageId) : null;
    if (saved !== null) {
      if (saved.selected?.kind === "term") setExpandedTerm(saved.selected.id);
      setTermDrafts(saved.termDrafts);
    }
    setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist {expanded term, drafts}; an all-empty state clears the key.
  useEffect(() => {
    if (!restored) return;
    const store = browserStore();
    if (store === null) return;
    if (expandedTerm === null && Object.keys(termDrafts).length === 0) {
      clearStudyDraft(store, workspaceId, pageId);
    } else {
      saveStudyDraft(store, workspaceId, pageId, {
        ...(expandedTerm !== null ? { selected: { kind: "term", id: expandedTerm } } : {}),
        noteDrafts: {},
        termDrafts,
      });
    }
  }, [restored, expandedTerm, termDrafts, workspaceId, pageId]);

  // Per-element state survives live re-renders only while its element still exists.
  useEffect(() => {
    if (!restored || glossary.loading || glossary.error !== null) return;
    if (expandedTerm !== null && !isEditable(expandedTerm, glossary.elements)) setExpandedTerm(null);
    const kept = pruneBySection(termDrafts, glossary.elements);
    if (Object.keys(kept).length !== Object.keys(termDrafts).length) setTermDrafts(kept);
  }, [restored, glossary, expandedTerm, termDrafts]);

  /** Expand a term and bring its row into view (the rail scrolls, not the window). */
  const revealTerm = useCallback((termId: string) => {
    setExpandedTerm(termId);
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`[data-term-id="${CSS.escape(termId)}"]`);
      row?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, []);

  const onMarkTerm = useCallback(
    async (term: string) => {
      const clean = term.trim().replace(/\s+/g, " ");
      if (clean === "") return;
      const ok = await runMutation("markTerm", { term: clean });
      if (ok) setPendingTermKey(clean.toLowerCase());
    },
    [runMutation],
  );

  // A freshly-marked term expands for definition on arrival.
  useEffect(() => {
    if (pendingTermKey === null) return;
    const hit = glossary.elements.find((e) => titleOf(e).trim().toLowerCase() === pendingTermKey);
    if (hit !== undefined) {
      revealTerm(hit.id);
      setPendingTermKey(null);
    }
  }, [pendingTermKey, glossary.elements, revealTerm]);

  const marked = glossary.elements.filter((e) => e.status === "marked");
  const accepted = glossary.elements.filter((e) => e.status === "accepted");
  const total = glossary.elements.length;

  return (
    <>
      <div className="restate-bar">
        <p className="restate-progress">
          {total} term{total === 1 ? "" : "s"}
          {marked.length > 0 && (
            <span className="study-bar-marked">
              {" "}
              · {marked.length} need{marked.length === 1 ? "s" : ""} a definition
            </span>
          )}
          {accepted.length > 0 && ` · ${accepted.length} accepted`}
          {evaluating && <span className="study-bar-evaluating"> · evaluating…</span>}
        </p>
        {glossary.error !== null && (
          <p className="restate-load-error" role="alert">
            Couldn&apos;t refresh: {glossary.error}. Showing the last good read.
          </p>
        )}
        {!collecting && (
          <span className="restate-bar-note">
            {status} — reopen from the <Link href={pageHref(workspaceId, pageId, "model")}>Model view</Link> to keep collecting
          </span>
        )}
        {collecting && marked.length === 0 && total > 0 && (
          <span className="restate-bar-note" title="finish is a human gate on the Model view">
            every term defined — <Link href={pageHref(workspaceId, pageId, "model")}>finish from the Model view</Link>
          </span>
        )}
      </div>
      {mutationError !== null && (
        <div className="notice error study-mutation-notice">
          {mutationError}{" "}
          <button type="button" className="restate-cancel" onClick={resetMutation}>
            Dismiss
          </button>
        </div>
      )}
      {/* `study-studio` carries the rail's sticky-header + inner-scroll rules. */}
      <div className="restate-studio study-studio glossary-studio">
        <aside className="restate-workbench" aria-label="Glossary">
          <GlossaryPane
            workspaceId={workspaceId}
            pageId={pageId}
            glossary={glossary}
            editable={collecting}
            subject={pageTitle}
            definitions={definitions}
            expandedTerm={expandedTerm}
            onExpandedTermChange={setExpandedTerm}
            termDrafts={termDrafts}
            onTermDraftsChange={setTermDrafts}
            onMarkTerm={(t) => void onMarkTerm(t)}
            onRevealTerm={revealTerm}
            runMutation={runMutation}
            mutating={mutating}
            onEvaluatingChange={setEvaluating}
          />
        </aside>
      </div>
    </>
  );
}
