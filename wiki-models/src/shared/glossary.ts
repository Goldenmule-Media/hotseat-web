/**
 * The GLOSSARY: a term/definition learning loop shared by every page type that wants one.
 * Terms are MARKED as needing a definition, the human defines each in their own words, and
 * an async AI critic evaluates the definition — the verdict lands via `recordEvaluation`
 * (grade + feedback, the term moves to `checked`). Editing a settled definition honestly
 * returns it to `defined` and clears the stale grade. Terms stay alphabetical by
 * construction, so the rendered Markdown IS a glossary document.
 *
 * Everything here is page-FSM-agnostic except a section's write-gate, which names PAGE
 * statuses — hence {@link glossarySection} taking `mutableIn` and everything else being a
 * constant. Deliberately NOT a bundle (no `index.ts` in this directory): the server's
 * `--models-dir` discovery would try to load one as a page-type array.
 */
import type { DeepReadonly, ElementDecl, IItem, PageState, Precondition, SectionDecl, SectionOp, SectionRender } from "wiki/authoring";
import { InvariantViolationError, parseBlocks, t, z, zodSchema } from "wiki/authoring";
import { listOf, scalarOf, titleOf } from "./page-state";

export const GLOSSARY_SECTION = "glossary";
export const TERMS_FIELD = "terms";

/** The critic's verdict vocabulary, advertised through the command args schema. */
export const GRADES = ["understood", "partial", "surface"] as const;
const gradeArg = z.enum(GRADES);

export const termsOf = (page: DeepReadonly<PageState>): readonly DeepReadonly<IItem>[] =>
  listOf(page, GLOSSARY_SECTION, TERMS_FIELD);

/** The dedup/sort key: trimmed, lowercased, compared by codepoint (deterministic — no
 *  locale-dependent collation in a reducer). */
function termKey(term: string): string {
  return term.trim().toLowerCase();
}

function termAt(page: DeepReadonly<PageState>, termId: string): DeepReadonly<IItem> {
  const el = termsOf(page).find((e) => e.id === termId);
  if (el === undefined) throw new InvariantViolationError(`term "${termId}" not found in ${GLOSSARY_SECTION}.${TERMS_FIELD}`);
  return el;
}

function requireFreshTerm(terms: readonly DeepReadonly<IItem>[], term: string, excludeId?: string): void {
  const key = termKey(term);
  const dup = terms.find((e) => e.id !== excludeId && termKey(titleOf(e)) === key);
  if (dup !== undefined) {
    throw new InvariantViolationError(`"${titleOf(dup)}" is already in the glossary`);
  }
}

/** Where `term` belongs in the alphabetical order, counted over `terms` minus `excludeId`. */
function alphabeticalIndex(terms: readonly DeepReadonly<IItem>[], term: string, excludeId?: string): number {
  const key = termKey(term);
  return terms.filter((e) => e.id !== excludeId && termKey(titleOf(e)) < key).length;
}

const termTransition = (termId: string, event: string): SectionOp => ({
  op: "transition",
  level: "element",
  section: GLOSSARY_SECTION,
  field: TERMS_FIELD,
  element: termId,
  event,
});

/** Clear a stale verdict — every edit that changes what was evaluated emits these. */
function clearEvaluation(termId: string): SectionOp[] {
  return [
    { op: "setElementField", section: GLOSSARY_SECTION, field: TERMS_FIELD, id: termId, elementField: "grade", value: { kind: "scalar", value: "" } },
    { op: "setElementField", section: GLOSSARY_SECTION, field: TERMS_FIELD, id: termId, elementField: "feedback", value: { kind: "blocks", blocks: [] } },
  ];
}

/** What a term must do BEFORE its content changes: a settled term (checked or accepted)
 *  steps back to `defined`, and a verdict about the old text goes with it. */
function beforeContentEdit(el: DeepReadonly<IItem>): SectionOp[] {
  const ops: SectionOp[] = [];
  if (el.status === "checked" || el.status === "accepted") ops.push(termTransition(el.id, "redefine"));
  if (scalarOf(el, "grade") !== "") ops.push(...clearEvaluation(el.id));
  return ops;
}

/** The sign-off gate: refused while any term is still waiting for its definition. */
export const allTermsDefined: Precondition = (page) => {
  const open = termsOf(page).filter((e) => e.status === "marked");
  return open.length === 0
    ? true
    : { unmet: `define these glossary terms first: ${open.map(titleOf).join(", ")}` };
};

/** The `glossary-term` element type. Its `mutableIn` names ELEMENT statuses, so it is the
 *  same for every host page type. */
export const glossaryTermElement: ElementDecl = {
  fields: {
    /** The term itself (the element's display title). */
    title: { kind: "prose", required: true },
    /** The human's definition, in their own words. */
    definition: { kind: "blocks", required: true },
    /** The critic's verdict: understood | partial | surface; "" until evaluated. */
    grade: { kind: "scalar" },
    /** The critic's feedback (what the definition misses or distorts). */
    feedback: { kind: "blocks" },
  },
  status: {
    initial: "marked",
    transitions: [
      t("marked", "define", "defined"),
      t("defined", "evaluate", "checked"),
      t("checked", "redefine", "defined"),
      // `accept` is the human's own "I understand this" — the only way out of the
      // working set. Available with or without a critic verdict.
      t("defined", "accept", "accepted"),
      t("checked", "accept", "accepted"),
      t("accepted", "reopen", "defined"),
      t("accepted", "redefine", "defined"),
    ],
  },
  // Content edits stop at `checked`: editing an evaluated term must `redefine` first,
  // so a grade can never silently attest to text it did not judge.
  mutableIn: ["marked", "defined"],
  awaitsHuman: (el) => el.status !== "accepted",
};

/**
 * The glossary section. `mutableIn` is the one thing a host page type must supply: it
 * names that page's OWN statuses, the statuses during which the glossary may be edited.
 */
export function glossarySection(opts: { mutableIn: readonly string[]; name?: string }): SectionDecl {
  return {
    name: opts.name ?? "Glossary",
    required: true,
    mutableIn: opts.mutableIn,
    fields: { [TERMS_FIELD]: { kind: "list", element: "glossary-term", ordered: true } },
  };
}

/** How the glossary renders: alphabetical `### {term}`, the definition, then the critique. */
export function glossaryRenderSection(opts?: { heading?: string; placeholder?: string }): SectionRender {
  return {
    section: GLOSSARY_SECTION,
    heading: opts?.heading ?? "Glossary",
    field: TERMS_FIELD,
    as: "sections",
    numbered: false,
    placeholder: opts?.placeholder ?? "_No terms marked._",
    element: {
      heading: "{title}",
      body: [{ field: "definition" }, { label: "Critique", field: "feedback" }],
    },
  };
}

/** The prose every host page type wants in its own `description` — the glossary half of it. */
export const GLOSSARY_DESCRIPTION =
  "The GLOSSARY is the learning loop: `markTerm` flags a term as needing a definition (born `marked`, " +
  "listed under attention until defined; terms stay alphabetical by construction and duplicates are " +
  "refused). The human DEFINES each term in their own words in the studio — an agent never authors " +
  "definitions, that would defeat the point. `recordEvaluation` is the studio critic's verb: it records " +
  "an AI evaluation of the human's definition (grade + feedback) and moves the term to `checked`. NEVER " +
  "call it with a grade you did not actually produce by critiquing the definition. Redefining a settled " +
  "term honestly returns it to `defined` and clears the stale verdict.\n\n" +
  "A term is WORKING (`marked` | `defined` | `checked`) until the human accepts it: `acceptTerm` is their " +
  '"I understand this" and the only way to `accepted`, `reopenTerm` puts it back. Nothing an agent or ' +
  "the critic does moves a term out of the working set.";

/** The seven glossary commands, spread into a host page type's `commands`. */
export const glossaryCommands = {
  markTerm: {
    description:
      "Flag a term as needing a definition (born `marked`; the studio and the attention list surface it " +
      "until the human defines it). Inserted at its alphabetical position; a duplicate (case-insensitive) " +
      "is refused. `markdown`, when given, defines the term in the same commit (born `defined`) — the " +
      "human's own words only.",
    args: zodSchema(z.object({ term: z.string().min(1), markdown: z.string().optional() })),
    result: zodSchema(z.object({ termId: z.string() })),
    target: { section: GLOSSARY_SECTION, field: TERMS_FIELD },
    produces: (page: DeepReadonly<PageState>, args: unknown, ctx: { newId: () => string }): SectionOp[] => {
      const a = args as { term: string; markdown?: string };
      const term = a.term.trim();
      if (term === "") throw new InvariantViolationError("term is empty");
      const terms = termsOf(page);
      requireFreshTerm(terms, term);
      const index = alphabeticalIndex(terms, term);
      const id = ctx.newId();
      const markdown = a.markdown?.trim() ?? "";
      const ops: SectionOp[] = [
        {
          op: "addElement",
          section: GLOSSARY_SECTION,
          field: TERMS_FIELD,
          id,
          fields: {
            title: { kind: "prose", value: term },
            definition: { kind: "blocks", blocks: parseBlocks(markdown, ctx.newId) },
            grade: { kind: "scalar", value: "" },
            feedback: { kind: "blocks", blocks: [] },
          },
          ...(index !== terms.length ? { index } : {}),
        },
      ];
      if (markdown !== "") ops.push(termTransition(id, "define"));
      return ops;
    },
  },
  defineTerm: {
    description:
      "Write a term's definition — the HUMAN's restatement of what the term means, authored in the studio " +
      "(an agent never writes these). A `marked` term becomes `defined`; redefining a `checked` " +
      "term returns it to `defined` and clears the stale evaluation.",
    args: zodSchema(z.object({ termId: z.string(), markdown: z.string().min(1) })),
    target: { section: GLOSSARY_SECTION, field: TERMS_FIELD },
    produces: (page: DeepReadonly<PageState>, args: unknown, ctx: { newId: () => string }): SectionOp[] => {
      const a = args as { termId: string; markdown: string };
      const el = termAt(page, a.termId);
      const ops: SectionOp[] = beforeContentEdit(el);
      ops.push({
        op: "setElementField",
        section: GLOSSARY_SECTION,
        field: TERMS_FIELD,
        id: a.termId,
        elementField: "definition",
        value: { kind: "blocks", blocks: parseBlocks(a.markdown, ctx.newId) },
      });
      if (el.status === "marked") ops.push(termTransition(a.termId, "define"));
      return ops;
    },
  },
  renameTerm: {
    description:
      "Rename a term. It moves to its new alphabetical position; a duplicate is refused. Renaming a " +
      "`checked` term changes what was evaluated, so it returns to `defined` and the verdict clears.",
    args: zodSchema(z.object({ termId: z.string(), term: z.string().min(1) })),
    target: { section: GLOSSARY_SECTION, field: TERMS_FIELD },
    produces: (page: DeepReadonly<PageState>, args: unknown): SectionOp[] => {
      const a = args as { termId: string; term: string };
      const term = a.term.trim();
      if (term === "") throw new InvariantViolationError("term is empty");
      const el = termAt(page, a.termId);
      const terms = termsOf(page);
      requireFreshTerm(terms, term, a.termId);
      const ops: SectionOp[] = beforeContentEdit(el);
      ops.push(
        { op: "setElementField", section: GLOSSARY_SECTION, field: TERMS_FIELD, id: a.termId, elementField: "title", value: { kind: "prose", value: term } },
        { op: "moveElement", section: GLOSSARY_SECTION, field: TERMS_FIELD, id: a.termId, toIndex: alphabeticalIndex(terms, term, a.termId) },
      );
      return ops;
    },
  },
  unmarkTerm: {
    description: "Remove a term from the glossary — the human's call that it does not belong.",
    args: zodSchema(z.object({ termId: z.string() })),
    target: { section: GLOSSARY_SECTION, field: TERMS_FIELD },
    produces: (page: DeepReadonly<PageState>, args: unknown): SectionOp[] => {
      const a = args as { termId: string };
      termAt(page, a.termId);
      return [{ op: "removeElement", section: GLOSSARY_SECTION, field: TERMS_FIELD, id: a.termId }];
    },
  },
  recordEvaluation: {
    description:
      "Record the studio critic's REAL evaluation of a term's definition: grade (understood | partial | " +
      "surface) plus feedback Markdown, moving the term to `checked` in one commit. Runs only on a " +
      "`defined` term. NEVER call this with a verdict you did not actually produce by critiquing the " +
      "human's definition against the term's meaning and the page's context.",
    args: zodSchema(z.object({ termId: z.string(), grade: gradeArg, markdown: z.string().min(1) })),
    target: { section: GLOSSARY_SECTION, field: TERMS_FIELD },
    produces: (page: DeepReadonly<PageState>, args: unknown, ctx: { newId: () => string }): SectionOp[] => {
      const a = args as { termId: string; grade: (typeof GRADES)[number]; markdown: string };
      const el = termAt(page, a.termId);
      if (el.status !== "defined") {
        throw new InvariantViolationError(
          `"${titleOf(el)}" is ${el.status ?? "statusless"} — evaluations run on a defined term` +
            (el.status === "checked" ? " (redefine it first)" : ""),
        );
      }
      return [
        { op: "setElementField", section: GLOSSARY_SECTION, field: TERMS_FIELD, id: a.termId, elementField: "grade", value: { kind: "scalar", value: a.grade } },
        { op: "setElementField", section: GLOSSARY_SECTION, field: TERMS_FIELD, id: a.termId, elementField: "feedback", value: { kind: "blocks", blocks: parseBlocks(a.markdown, ctx.newId) } },
        termTransition(a.termId, "evaluate"),
      ];
    },
  },
  acceptTerm: {
    description:
      "The HUMAN's own call that they understand a term: it leaves the working set for the accepted " +
      "glossary. Runs on a `defined` or `checked` term (a critic verdict is welcome but not required). " +
      "NEVER call this on the human's behalf — only they can say they understand something.",
    args: zodSchema(z.object({ termId: z.string() })),
    target: { section: GLOSSARY_SECTION, field: TERMS_FIELD },
    produces: (page: DeepReadonly<PageState>, args: unknown): SectionOp[] => {
      const a = args as { termId: string };
      const el = termAt(page, a.termId);
      if (el.status === "marked") {
        throw new InvariantViolationError(`"${titleOf(el)}" has no definition yet — define it before accepting it`);
      }
      return [termTransition(a.termId, "accept")];
    },
  },
  reopenTerm: {
    description:
      "Take an accepted term back into the working set — the human decided it is not settled after all. " +
      "The definition and the last verdict are kept, since neither changed.",
    args: zodSchema(z.object({ termId: z.string() })),
    target: { section: GLOSSARY_SECTION, field: TERMS_FIELD },
    produces: (page: DeepReadonly<PageState>, args: unknown): SectionOp[] => {
      const a = args as { termId: string };
      const el = termAt(page, a.termId);
      if (el.status !== "accepted") {
        throw new InvariantViolationError(`"${titleOf(el)}" is ${el.status ?? "statusless"} — only an accepted term reopens`);
      }
      return [termTransition(a.termId, "reopen")];
    },
  },
};
