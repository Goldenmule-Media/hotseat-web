"use client";

/**
 * The `article-notes` schema, as the Article Studio addresses it. Keys, command names and
 * the readers that pull the source fields back out of the rendered page live here,
 * mirroring lib/study.ts and lib/glossary.ts — a studio is coupled to its page type by
 * these constants, and nothing else in wiki-ui should name them.
 */
import { sliceH2Section } from "./restate";

export const ARTICLE_PAGE_TYPE = "article-notes";

export const NOTES_SECTION = "notes";
export const SUMMARY_SECTION = "summary";

/** The page status in which notes may still be captured (notes.mutableIn). */
export const READING = "reading";

/** The Source section renders as derived rows, so the values come back out of the render. */
export interface ArticleSource {
  readonly link: string;
  readonly date: string;
}

export function readSource(pageMarkdown: string | null): ArticleSource {
  const body = pageMarkdown === null ? null : sliceH2Section(pageMarkdown, "Source");
  const row = (label: string): string => {
    if (body === null) return "";
    const m = new RegExp(`^- \\*\\*${label}:\\*\\* (.*)$`, "m").exec(body);
    return m?.[1]?.trim() ?? "";
  };
  return { link: row("Link"), date: row("Date") };
}

/** The summary body, as rendered — the studio's editor seeds from this. */
export function readSummary(pageMarkdown: string | null): string {
  if (pageMarkdown === null) return "";
  const body = sliceH2Section(pageMarkdown, "Summary");
  if (body === null) return "";
  return body === "_Not summarized yet._" ? "" : body;
}

/**
 * The notes list as ONE Markdown document. The studio edits this document, not the
 * elements: a note is a paragraph, so a stack of them IS the page's prose.
 */
export function notesToDocument(notes: readonly { readonly markdown: string }[]): string {
  return notes
    .map((n) => n.markdown.trim())
    .filter((md) => md !== "")
    .join("\n\n");
}

/**
 * The document back into notes: one note per blank-line-separated block, except that an
 * indented block — a list, a quote, a nested item — stays with the paragraph it hangs
 * off. "In order:" and its four bullets is ONE note, the way it was written.
 */
export function splitNoteDocument(doc: string): readonly string[] {
  const chunks: string[] = [];
  for (const raw of doc.split(/\n[ \t]*\n/)) {
    const block = raw.trim();
    if (block === "") continue;
    const last = chunks.length - 1;
    if (last >= 0 && continuesPrevious(block, chunks[last]!)) chunks[last] = `${chunks[last]!}\n\n${block}`;
    else chunks.push(block);
  }
  return chunks;
}

/** A block that hangs off the one above rather than standing on its own. */
function continuesPrevious(block: string, previous: string): boolean {
  const marker = /^([-*+] |\d+[.)] |> )/;
  // A list/quote continues a plain paragraph; two lists in a row are still one note.
  if (marker.test(block)) return !/^\s/.test(previous);
  return false;
}

/** One command in the sequence that turns the stored notes into the edited document. */
export interface NoteEdit {
  readonly command: "reviseNote" | "addNote" | "removeNote";
  readonly args: Record<string, unknown>;
}

/**
 * The smallest command sequence that makes the notes list read as `next`. Untouched
 * blocks at the head and tail of the document are matched first, so the everyday edit —
 * typing inside one note — is a single `reviseNote`, and a note typed between two others
 * is a single `addNote` anchored to the one above it.
 *
 * Notes are positional: where a middle insertion can't be anchored (more than one new
 * block before an untouched tail), the tail is rewritten in place instead. The document
 * always comes out right; only which element id holds which text moves.
 */
export function diffNotes(stored: readonly { readonly id: string; readonly markdown: string }[], next: readonly string[]): readonly NoteEdit[] {
  const old = stored.map((n) => ({ id: n.id, markdown: n.markdown.trim() }));

  let head = 0;
  while (head < old.length && head < next.length && old[head]!.markdown === next[head]) head++;

  let tail = 0;
  while (tail < old.length - head && tail < next.length - head && old[old.length - 1 - tail]!.markdown === next[next.length - 1 - tail]) {
    tail++;
  }

  // More than one new block before an untouched tail can't be anchored — each addNote's
  // id is only known once it commits — so give up the tail match and rewrite positionally.
  if (next.length - old.length > 1) tail = 0;

  const oldMiddle = old.slice(head, old.length - tail);
  const newMiddle = next.slice(head, next.length - tail);

  const edits: NoteEdit[] = [];
  const paired = Math.min(oldMiddle.length, newMiddle.length);
  for (let i = 0; i < paired; i++) {
    if (oldMiddle[i]!.markdown !== newMiddle[i]) {
      edits.push({ command: "reviseNote", args: { noteId: oldMiddle[i]!.id, markdown: newMiddle[i]! } });
    }
  }
  for (let i = paired; i < newMiddle.length; i++) {
    const anchor = i === 0 ? old[head - 1] : (oldMiddle[i - 1] ?? old[head - 1]);
    edits.push({
      command: "addNote",
      args: { markdown: newMiddle[i]!, ...(tail > 0 && anchor !== undefined ? { afterId: anchor.id } : {}) },
    });
  }
  for (let i = paired; i < oldMiddle.length; i++) {
    edits.push({ command: "removeNote", args: { noteId: oldMiddle[i]!.id } });
  }
  return edits;
}
