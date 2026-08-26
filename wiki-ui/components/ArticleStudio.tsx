"use client";

/**
 * The Article Studio — the browser UI for `article-notes` pages.
 *
 * One column: the source (where the article lives and when it is from), the summary, and
 * then the notes it was drawn from — the same order the page renders in, because the
 * summary is what you come back to read and the notes are what you scroll through.
 *
 * The notes are ONE live-preview editor, not a card per note. The model stores them as a
 * list — that is what makes a note addressable — but reading and writing them is a single
 * flowing document; lib/article-notes.ts maps between the two, so an ordinary edit becomes
 * one `reviseNote` and the list never surfaces as chrome.
 *
 * Nothing here is ever read-only. Leaving the summary marks the article finished
 * (`summarize`), which is a SIGNAL — the sidebar and the header badge tick — not a seal:
 * every surface stays editable in `summarized`, and editing on is how you reopen nothing.
 *
 * Notes take pasted images. That is the whole reason the attachment store exists, and it
 * costs nothing here: <MarkdownEditor> owns the paste handling, so passing an uploader is
 * the entire integration.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PageId, WorkspaceId } from "wiki";

import { diffNotes, notesToDocument, NOTES_SECTION, READING, readSource, readSummary, splitNoteDocument } from "../lib/article-notes";
import { imageSrc, uploadAttachment } from "../lib/attachments";
import { usePageMutator, useSectionDocument } from "../lib/live";
import { useStagedText } from "../lib/staged-text";
import { useTypewriter } from "../lib/useTypewriter";
import { MarkdownEditor } from "./MarkdownEditor";

const AUTOSAVE_MS = 1000;

export function ArticleStudio({
  workspaceId,
  pageId,
  status,
  pageMarkdown,
}: {
  workspaceId: WorkspaceId;
  pageId: PageId;
  status: string;
  /** The whole page's rendered Markdown (usePage) — the source rows and summary read from it. */
  pageMarkdown: string | null;
}): React.JSX.Element {
  const notes = useSectionDocument(workspaceId, pageId, NOTES_SECTION);
  const typewriter = useTypewriter();
  /** Bumped by the typewriter switch to hand the cursor back to the notes. */
  const [focusNotes, setFocusNotes] = useState(0);
  const { run: runMutation, error: mutationError, reset: resetMutation } = usePageMutator(workspaceId, pageId);

  const reading = status === READING;
  const source = useMemo(() => readSource(pageMarkdown), [pageMarkdown]);
  const storedSummary = useMemo(() => readSummary(pageMarkdown), [pageMarkdown]);
  const storedNotes = useMemo(() => notesToDocument(notes.notes), [notes.notes]);

  // Every field is staged over the engine's text and retired only when the engine answers
  // back — see lib/staged-text.ts for why dropping a draft any earlier loses the edit.
  const linkField = useStagedText(source.link);
  const summaryField = useStagedText(storedSummary);
  const notesField = useStagedText(storedNotes);
  const [editingLink, setEditingLink] = useState(false);
  /** Opens the summary editor on a page that has none yet — see {@link summaryOpen}. */
  const [writingSummary, setWritingSummary] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const upload = useCallback((file: File) => uploadAttachment(workspaceId, file), [workspaceId]);
  const showImage = useCallback((ref: string) => imageSrc(workspaceId, ref), [workspaceId]);

  /** Blur out of the link: save it, and keep the typed text until the page re-renders with
   *  it (a rejected write falls back to the stored link, with the error banner saying why). */
  const commitLink = useCallback(async () => {
    const text = linkField.draft;
    if (text === null || text === source.link) linkField.drop();
    else if (await runMutation("setLink", { link: text })) linkField.saved(text);
    else linkField.drop();
  }, [linkField, source.link, runMutation]);

  /* An empty summary is not an empty field: an unwritten summary is the one thing this page
     is FOR, so it says so in a line you can read and scroll straight past, rather than an
     editor sitting open over the notes. Writing one opens the editor for good. */
  const summaryOpen = storedSummary.trim() !== "" || writingSummary;

  /**
   * Leaving the summary saves it AND marks the article finished — writing what you made of
   * it IS finishing it, so there is no separate button. `summarize` seals nothing (notes and
   * summary stay editable), and it is only attempted once its preconditions hold, so an
   * unlinked or empty draft just saves quietly instead of raising the engine's refusal.
   */
  const finishSummary = useCallback(async () => {
    const text = summaryField.draft;
    if (text !== null && text !== storedSummary) {
      // A rejected write keeps its draft: the words are still in the editor, unsaved.
      if (!(await runMutation("writeSummary", { markdown: text }))) return;
      summaryField.saved(text);
    } else {
      summaryField.drop(text ?? undefined);
    }
    const written = (text ?? storedSummary).trim();
    if (reading && written !== "" && source.link !== "") await runMutation("summarize", {});
  }, [summaryField, storedSummary, reading, source.link, runMutation]);

  /** Blur out of the summary: save (and finish), then fold an untouched editor back to the
   *  invitation — an empty field left open is exactly what the button replaced. */
  const leaveSummary = useCallback(async () => {
    const empty = summaryField.value.trim() === "";
    await finishSummary();
    if (empty) setWritingSummary(false);
  }, [summaryField, finishSummary]);

  // Read at save time, never captured: a debounced save must diff against the list as it
  // stands when it fires, not as it stood when the keystroke scheduled it.
  const storedRef = useRef(notes.notes);
  storedRef.current = notes.notes;

  // The list is the storage, the document is the edit: re-split and diff, then run the
  // commands in order (the host takes one at a time, so this is a short sequence).
  const saveNotes = useCallback(
    async (document: string): Promise<"committed" | "unchanged" | "failed"> => {
      const edits = diffNotes(storedRef.current, splitNoteDocument(document));
      if (edits.length === 0) return "unchanged";
      for (const edit of edits) {
        if (!(await runMutation(edit.command, edit.args))) return "failed";
      }
      return "committed";
    },
    [runMutation],
  );

  // Save, then hand the draft over to the engine's own render — but only once that render
  // has arrived (a failed write keeps the draft, so the words are never the casualty).
  const commitNotes = useCallback(
    (text: string) => {
      void saveNotes(text).then((outcome) => {
        if (outcome === "committed") notesField.saved(text);
        else if (outcome === "unchanged") notesField.drop(text);
      });
    },
    [saveNotes, notesField],
  );

  const scheduleNotes = useCallback(
    (text: string) => {
      notesField.edit(text);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => commitNotes(text), AUTOSAVE_MS);
    },
    [notesField, commitNotes],
  );

  const flushNotes = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    if (notesField.draft !== null) commitNotes(notesField.draft);
  }, [notesField, commitNotes]);

  // A pending autosave must not fire after the studio unmounts.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <>
      {notes.error !== null && (
        <p className="restate-bar restate-load-error" role="alert">
          Couldn&apos;t refresh: {notes.error}. Showing the last good read.
        </p>
      )}

      {mutationError !== null && (
        <div className="notice error study-mutation-notice">
          {mutationError}{" "}
          <button type="button" className="restate-cancel" onClick={resetMutation}>
            Dismiss
          </button>
        </div>
      )}

      <div className="restate-studio article-studio">
        <div className="restate-workbench">
          <section className="article-source">
            {editingLink || source.link === "" ? (
              <input
                type="url"
                className="article-link-input"
                value={linkField.value}
                autoFocus={editingLink}
                placeholder="https://… — where the article lives"
                aria-label="Article link"
                onChange={(e) => linkField.edit(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") {
                    linkField.drop();
                    setEditingLink(false);
                  }
                }}
                onBlur={() => {
                  void commitLink();
                  setEditingLink(false);
                }}
              />
            ) : (
              <p className="article-link-row">
                <a className="article-link" href={source.link} target="_blank" rel="noreferrer noopener">
                  {source.link}
                </a>
                <button type="button" className="article-link-edit" onClick={() => setEditingLink(true)}>
                  edit
                </button>
              </p>
            )}
            {/* Not a field: the engine stamps the day the page was created. */}
            {source.date !== "" && <p className="article-date">{source.date}</p>}
          </section>

          {summaryOpen ? (
            <section className="restate-block">
              <h2 className="restate-block-head">Summary</h2>
              <div className="article-doc article-doc-short">
                <MarkdownEditor
                  value={summaryField.value}
                  onChange={summaryField.edit}
                  onBlur={() => void leaveSummary()}
                  autoFocus={writingSummary}
                  terms={[]}
                  onTermClick={() => {}}
                  placeholder="What you made of it, in your own words."
                  onUploadImage={upload}
                  onResolveImage={showImage}
                />
              </div>
            </section>
          ) : (
            <section className="article-summarize">
              <button type="button" className="article-summarize-btn" onClick={() => setWritingSummary(true)}>
                Summarize
              </button>
              <span className="article-summarize-goal">
                You are done with this article when you can say what you made of it.
              </span>
            </section>
          )}

          <section className={`restate-block article-notes-block${typewriter.on ? " is-typewriter" : ""}`}>
            <div className="restate-block-head-row">
              <h2 className="restate-block-head">Notes</h2>
              <button
                type="button"
                className={`article-typewriter${typewriter.on ? " is-on" : ""}`}
                aria-pressed={typewriter.on}
                title="Typewriter: keep the line you are writing in the middle of the box"
                onClick={() => {
                  typewriter.toggle();
                  setFocusNotes((n) => n + 1);
                }}
              >
                Typewriter
              </button>
            </div>
            <div className="article-doc">
              <MarkdownEditor
                value={notesField.value}
                onChange={scheduleNotes}
                onBlur={flushNotes}
                typewriter={typewriter.on}
                focusSignal={focusNotes}
                terms={[]}
                onTermClick={() => {}}
                placeholder="Notes, in your own words. Paste an image to attach it."
                onUploadImage={upload}
                onResolveImage={showImage}
              />
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
