"use client";

/**
 * The Article Studio — the browser UI for `article-notes` pages.
 *
 * One column, in the order the work actually happens: the source (where the article
 * lives and when it is from), the notes taken while reading, and the summary written
 * afterwards. The rendered page orders them Source / Summary / Notes, because that is how
 * the document reads back; this is how it is written.
 *
 * Notes take pasted images. That is the whole reason the attachment store exists, and it
 * costs nothing here: <MarkdownEditor> owns the paste handling, so passing an uploader is
 * the entire integration.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { PageId, WorkspaceId } from "wiki";

import { NOTES_SECTION, READING, readSource, readSummary } from "../lib/article-notes";
import { uploadAttachment } from "../lib/attachments";
import { usePageMutator, useSectionElements, useElementMarkdown } from "../lib/live";
import { renderMarkdown } from "../lib/markdown";
import { pageHref } from "../lib/routes";
import { resolveAttachmentsIn } from "../lib/attachments";
import type { SectionElementSummary } from "../lib/wiki-host-api";
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

function NoteCard({
  workspaceId,
  pageId,
  el,
  editable,
  index,
  count,
  onSave,
  onMove,
  onRemove,
  onUploadImage,
}: {
  workspaceId: WorkspaceId;
  pageId: PageId;
  el: SectionElementSummary;
  editable: boolean;
  index: number;
  count: number;
  onSave: (noteId: string, markdown: string) => void;
  onMove: (noteId: string, toIndex: number) => void;
  onRemove: (noteId: string) => void;
  onUploadImage: (file: File) => Promise<string>;
}): React.JSX.Element {
  // A note's body is a `blocks` field, which has no plain-text form on the element
  // summary — so the engine renders it and the editor seeds from that.
  const { markdown, loading } = useElementMarkdown(workspaceId, pageId, NOTES_SECTION, el.id);
  const [draft, setDraft] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const body = draft ?? markdown ?? "";

  const schedule = useCallback(
    (text: string) => {
      setDraft(text);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => onSave(el.id, text), AUTOSAVE_MS);
    },
    [el.id, onSave],
  );

  // A pending autosave must still land if the card unmounts (a reorder, a navigation).
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  if (loading && markdown === null) return <div className="restate-section article-note is-loading">Loading…</div>;

  return (
    <div className="restate-section article-note" data-el-id={el.id}>
      {editable ? (
        <MarkdownEditor
          value={body}
          onChange={schedule}
          onBlur={() => {
            if (timer.current !== null) clearTimeout(timer.current);
            if (draft !== null) onSave(el.id, draft);
          }}
          terms={[]}
          onTermClick={() => {}}
          placeholder="A note, in your own words. Paste an image to attach it."
          onUploadImage={onUploadImage}
        />
      ) : (
        <RenderedBody markdown={body} workspaceId={workspaceId} />
      )}
      {editable && (
        <div className="restate-actions article-note-actions">
          <button type="button" className="tf-btn tf-btn-secondary" disabled={index === 0} onClick={() => onMove(el.id, index - 1)}>
            ↑
          </button>
          <button
            type="button"
            className="tf-btn tf-btn-secondary"
            disabled={index === count - 1}
            onClick={() => onMove(el.id, index + 1)}
          >
            ↓
          </button>
          <button type="button" className="tf-btn tf-btn-danger" onClick={() => onRemove(el.id)}>
            Delete
          </button>
        </div>
      )}
    </div>
  );
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
  const notes = useSectionElements(workspaceId, pageId, NOTES_SECTION);
  const { run: runMutation, pending: mutating, error: mutationError, reset: resetMutation } = usePageMutator(workspaceId, pageId);

  const reading = status === READING;
  const source = useMemo(() => readSource(pageMarkdown), [pageMarkdown]);
  const storedSummary = useMemo(() => readSummary(pageMarkdown), [pageMarkdown]);

  const [link, setLink] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [composing, setComposing] = useState("");

  const upload = useCallback((file: File) => uploadAttachment(workspaceId, file), [workspaceId]);

  const saveNote = useCallback(
    (noteId: string, markdown: string) => {
      if (markdown.trim() === "") return; // an empty body would fail the element's `required`
      void runMutation("reviseNote", { noteId, markdown });
    },
    [runMutation],
  );

  const addNote = useCallback(async () => {
    const markdown = composing.trim();
    if (markdown === "") return;
    if (await runMutation("addNote", { markdown })) setComposing("");
  }, [composing, runMutation]);

  const elements = notes.elements;

  return (
    <>
      <div className="restate-bar">
        <p className="restate-progress">
          {elements.length} note{elements.length === 1 ? "" : "s"}
          {status !== READING && <span className="restate-bar-note"> · {status}</span>}
        </p>
        {notes.error !== null && (
          <p className="restate-load-error" role="alert">
            Couldn&apos;t refresh: {notes.error}. Showing the last good read.
          </p>
        )}
        <span className="restate-bar-note">
          {reading ? (
            <>
              summarize from the <Link href={pageHref(workspaceId, pageId, "model")}>Model view</Link> when you&apos;re done
            </>
          ) : (
            <>
              reopen from the <Link href={pageHref(workspaceId, pageId, "model")}>Model view</Link> to keep taking notes
            </>
          )}
        </span>
      </div>

      {mutationError !== null && (
        <div className="notice error study-mutation-notice">
          {mutationError}{" "}
          <button type="button" className="restate-cancel" onClick={resetMutation}>
            Dismiss
          </button>
        </div>
      )}

      <div className="restate-studio study-studio article-studio">
        <div className="restate-workbench">
          <section className="restate-block article-source">
            <h2>Source</h2>
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
          </section>

          <section className="restate-block">
            <h2>Notes</h2>
            {elements.length === 0 && !notes.loading && <p className="restate-preview-empty">No notes yet.</p>}
            {elements.map((el, i) => (
              <NoteCard
                key={el.id}
                workspaceId={workspaceId}
                pageId={pageId}
                el={el}
                editable={reading}
                index={i}
                count={elements.length}
                onSave={saveNote}
                onMove={(noteId, toIndex) => void runMutation("moveNote", { noteId, toIndex })}
                onRemove={(noteId) => void runMutation("removeNote", { noteId })}
                onUploadImage={upload}
              />
            ))}
            {reading && (
              <div className="restate-section article-compose">
                <MarkdownEditor
                  value={composing}
                  onChange={setComposing}
                  terms={[]}
                  onTermClick={() => {}}
                  placeholder="A new note. Paste a screenshot to attach it."
                  onUploadImage={upload}
                />
                <div className="restate-actions">
                  <button
                    type="button"
                    className="tf-btn tf-btn-primary"
                    disabled={composing.trim() === "" || mutating}
                    onClick={() => void addNote()}
                  >
                    Add note
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="restate-block">
            <h2>Summary</h2>
            <div className="restate-section">
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
        </div>
      </div>
    </>
  );
}
