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
 * Notes take pasted images. That is the whole reason the attachment store exists, and it
 * costs nothing here: <MarkdownEditor> owns the paste handling, so passing an uploader is
 * the entire integration.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PageId, WorkspaceId } from "wiki";

import { diffNotes, notesToDocument, NOTES_SECTION, READING, readSource, readSummary, splitNoteDocument } from "../lib/article-notes";
import { uploadAttachment } from "../lib/attachments";
import { usePageMutator, useSectionDocument } from "../lib/live";
import { renderMarkdown } from "../lib/markdown";
import { resolveAttachmentsIn } from "../lib/attachments";
import { MarkdownEditor } from "./MarkdownEditor";

const AUTOSAVE_MS = 1000;

/** Rendered Markdown with its attachment URLs resolved — a note's images, in read mode. */
function RenderedBody({ markdown, workspaceId }: { markdown: string; workspaceId: WorkspaceId }): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const html = useMemo(() => renderMarkdown(markdown, workspaceId), [markdown, workspaceId]);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    return resolveAttachmentsIn(el, workspaceId);
  }, [html, workspaceId]);
  return <div ref={ref} className="markdown restate-preview" dangerouslySetInnerHTML={{ __html: html }} />;
}

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
  const { run: runMutation, error: mutationError, reset: resetMutation } = usePageMutator(workspaceId, pageId);

  const reading = status === READING;
  const source = useMemo(() => readSource(pageMarkdown), [pageMarkdown]);
  const storedSummary = useMemo(() => readSummary(pageMarkdown), [pageMarkdown]);
  const storedNotes = useMemo(() => notesToDocument(notes.notes), [notes.notes]);

  const [link, setLink] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const upload = useCallback((file: File) => uploadAttachment(workspaceId, file), [workspaceId]);

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
          <section className="restate-block">
            <h2 className="restate-block-head">Source</h2>
            <div className="article-source-fields">
              <label className="article-field">
                <span>Link</span>
                <input
                  type="url"
                  value={link ?? source.link}
                  placeholder="https://…"
                  onChange={(e) => setLink(e.target.value)}
                  onBlur={() => {
                    if (link !== null && link !== source.link) void runMutation("setLink", { link });
                    setLink(null);
                  }}
                />
              </label>
              <label className="article-field">
                <span>Date</span>
                <input
                  type="date"
                  value={date ?? source.date}
                  onChange={(e) => setDate(e.target.value)}
                  onBlur={() => {
                    if (date !== null && date !== source.date) void runMutation("setDate", { date });
                    setDate(null);
                  }}
                />
              </label>
            </div>
          </section>

          <section className="restate-block">
            <h2 className="restate-block-head">Summary</h2>
            <div className="article-doc article-doc-short">
              <MarkdownEditor
                value={summary ?? storedSummary}
                onChange={setSummary}
                onBlur={() => {
                  if (summary !== null && summary !== storedSummary) void runMutation("writeSummary", { markdown: summary });
                  setSummary(null);
                }}
                terms={[]}
                onTermClick={() => {}}
                placeholder="What you made of it, in your own words."
                onUploadImage={upload}
              />
            </div>
          </section>

          <section className="restate-block">
            <h2 className="restate-block-head">Notes</h2>
            {reading ? (
              <div className="article-doc">
                <MarkdownEditor
                  value={draft ?? storedNotes}
                  onChange={scheduleNotes}
                  onBlur={flushNotes}
                  terms={[]}
                  onTermClick={() => {}}
                  placeholder="Notes, in your own words. Paste an image to attach it."
                  onUploadImage={upload}
                />
              </div>
            ) : storedNotes === "" ? (
              <p className="restate-preview-empty">No notes.</p>
            ) : (
              <RenderedBody markdown={storedNotes} workspaceId={workspaceId} />
            )}
          </section>
        </div>
      </div>
    </>
  );
}
