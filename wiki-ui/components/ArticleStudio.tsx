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
import { uploadAttachment } from "../lib/attachments";
import { usePageMutator, useSectionDocument } from "../lib/live";
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
  const { run: runMutation, error: mutationError, reset: resetMutation } = usePageMutator(workspaceId, pageId);

  const reading = status === READING;
  const source = useMemo(() => readSource(pageMarkdown), [pageMarkdown]);
  const storedSummary = useMemo(() => readSummary(pageMarkdown), [pageMarkdown]);
  const storedNotes = useMemo(() => notesToDocument(notes.notes), [notes.notes]);

  const [link, setLink] = useState<string | null>(null);
  const [editingLink, setEditingLink] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  /** Opens the summary editor on a page that has none yet — see {@link summaryOpen}. */
  const [writingSummary, setWritingSummary] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const upload = useCallback((file: File) => uploadAttachment(workspaceId, file), [workspaceId]);

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
    const text = summary;
    setSummary(null);
    if (text !== null && text !== storedSummary && !(await runMutation("writeSummary", { markdown: text }))) return;
    const written = (text ?? storedSummary).trim();
    if (reading && written !== "" && source.link !== "") await runMutation("summarize", {});
  }, [summary, storedSummary, reading, source.link, runMutation]);

  /** Blur out of the summary: save (and finish), then fold an untouched editor back to the
   *  invitation — an empty field left open is exactly what the button replaced. */
  const leaveSummary = useCallback(async () => {
    const empty = (summary ?? storedSummary).trim() === "";
    await finishSummary();
    if (empty) setWritingSummary(false);
  }, [summary, storedSummary, finishSummary]);

  // Read at save time, never captured: a debounced save must diff against the list as it
  // stands when it fires, not as it stood when the keystroke scheduled it.
  const storedRef = useRef(notes.notes);
  storedRef.current = notes.notes;

  // The list is the storage, the document is the edit: re-split and diff, then run the
  // commands in order (the host takes one at a time, so this is a short sequence).
  const saveNotes = useCallback(
    async (document: string) => {
      for (const edit of diffNotes(storedRef.current, splitNoteDocument(document))) {
        if (!(await runMutation(edit.command, edit.args))) return;
      }
    },
    [runMutation],
  );

  const scheduleNotes = useCallback(
    (text: string) => {
      setDraft(text);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => void saveNotes(text), AUTOSAVE_MS);
    },
    [saveNotes],
  );

  const flushNotes = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    if (draft === null) return;
    const text = draft;
    setDraft(null); // re-seed from the engine's own render once the write lands
    void saveNotes(text);
  }, [draft, saveNotes]);

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
                value={link ?? source.link}
                autoFocus={editingLink}
                placeholder="https://… — where the article lives"
                aria-label="Article link"
                onChange={(e) => setLink(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") {
                    setLink(null);
                    setEditingLink(false);
                  }
                }}
                onBlur={() => {
                  if (link !== null && link !== source.link) void runMutation("setLink", { link });
                  setLink(null);
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
                  value={summary ?? storedSummary}
                  onChange={setSummary}
                  onBlur={() => void leaveSummary()}
                  autoFocus={writingSummary}
                  terms={[]}
                  onTermClick={() => {}}
                  placeholder="What you made of it, in your own words."
                  onUploadImage={upload}
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

          <section className="restate-block article-notes-block">
            <div className="restate-block-head-row">
              <h2 className="restate-block-head">Notes</h2>
              <button
                type="button"
                className={`article-typewriter${typewriter.on ? " is-on" : ""}`}
                aria-pressed={typewriter.on}
                title="Typewriter: keep the line you are writing in the middle of the box"
                onClick={typewriter.toggle}
              >
                Typewriter
              </button>
            </div>
            <div className="article-doc">
              <MarkdownEditor
                value={draft ?? storedNotes}
                onChange={scheduleNotes}
                onBlur={flushNotes}
                typewriter={typewriter.on}
                terms={[]}
                onTermClick={() => {}}
                placeholder="Notes, in your own words. Paste an image to attach it."
                onUploadImage={upload}
              />
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
