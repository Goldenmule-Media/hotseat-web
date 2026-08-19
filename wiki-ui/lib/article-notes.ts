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
