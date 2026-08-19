/**
 * Glossary helpers shared by every studio with a glossary pane — the `study-notes` rail
 * and the standalone `restatement-glossary` page. Pure and React-free so the ordering,
 * the definition parsing and the labels are unit-tested in isolation.
 *
 * The two page types deliberately expose the SAME `glossary.terms` keys and the same
 * command names (pinned by `wiki/test/restatement-glossary.test.ts`), which is what lets
 * one <GlossaryPane> drive both without a per-type indirection.
 */
import type { SectionElementSummary } from "./live";
import { sliceH2Section, type CritiqueGrade } from "./restate";
import { glossaryEntries } from "./study";

/** The standalone glossary page type — the only place this tag is spelled outside models. */
export const GLOSSARY_PAGE_TYPE = "restatement-glossary";
/** The section both page types keep their terms in. */
export const GLOSSARY_SECTION_KEY = "glossary";

/** Per-row save feedback for an inline editor. */
export type SaveState = { readonly state: "saving" | "saved" } | { readonly state: "error"; readonly message: string };

export interface TermRef {
  readonly id: string;
  readonly term: string;
  readonly status: string;
  readonly grade: string;
}

export function titleOf(el: SectionElementSummary | undefined): string {
  return el?.title ?? el?.id ?? "Untitled";
}

export function gradeOf(el: SectionElementSummary): string {
  const g = el.scalars?.["grade"];
  return typeof g === "string" ? g : "";
}

/** The term list as the highlighter and the composer's duplicate check want it. */
export function termRefsOf(elements: readonly SectionElementSummary[]): TermRef[] {
  return elements.map((e) => ({ id: e.id, term: titleOf(e), status: e.status ?? "marked", grade: gradeOf(e) }));
}

/**
 * Every term's definition text from the page render's Glossary slice, keyed by lowercased
 * term — so the rail's filter searches definitions without a fetch per row.
 *
 * `occurrence` matters: on a `study-notes` page the note bodies keep authored `##`
 * headings verbatim BEFORE the glossary, so the real one is the LAST; on a standalone
 * glossary page `## Glossary` comes first and a definition may itself contain an `##`.
 */
export function glossaryDefinitions(pageMarkdown: string | null, occurrence: "first" | "last"): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  if (pageMarkdown === null) return map;
  const slice = sliceH2Section(pageMarkdown, "Glossary", occurrence);
  if (slice === null) return map;
  for (const e of glossaryEntries(slice)) map.set(e.term.trim().toLowerCase(), e.definition);
  return map;
}

export const GRADE_LABEL: Record<CritiqueGrade, string> = {
  understood: "Understood",
  partial: "Partial",
  surface: "Surface",
};

export const STATUS_LABEL: Record<string, string> = {
  marked: "Needs definition",
  defined: "Defined",
  checked: "Checked",
  accepted: "Accepted",
};
