/**
 * `study-notes` page type. A reading-notes outline (the human's own words, captured while
 * working through a book or course) plus a GLOSSARY the notes feed: terms are MARKED as
 * needing a definition, the human defines each in their own words (a wiki-ui studio makes
 * marking and defining fluid), and an async AI critic evaluates the definition — the
 * verdict lands via `recordEvaluation` (grade + feedback, element moves to `checked`).
 * Editing a checked definition honestly downgrades it back to `defined` and clears the
 * stale grade. The rendered Markdown IS the glossary document: terms stay alphabetical by
 * construction.
 */
import type { DeepReadonly, IField, IItem, PageState, Precondition, SectionOp } from "wiki/authoring";
import { definePageType, InvariantViolationError, parseBlocks, t, z, zodSchema } from "wiki/authoring";

const empty = z.object({});

const GRADES = ["understood", "partial", "surface"] as const;
const gradeArg = z.enum(GRADES);

function listOf(page: DeepReadonly<PageState>, sectionKey: string, fieldKey: string): readonly DeepReadonly<IItem>[] {
  const f = page.sections.find((s) => s.key === sectionKey)?.fields[fieldKey];
  return f !== undefined && f.kind === "list" ? f.elements : [];
}

const notesOf = (page: DeepReadonly<PageState>): readonly DeepReadonly<IItem>[] => listOf(page, "notes", "items");
const termsOf = (page: DeepReadonly<PageState>): readonly DeepReadonly<IItem>[] => listOf(page, "glossary", "terms");

function titleOf(el: DeepReadonly<IItem>): string {
  const f = el.fields["title"];
  return f !== undefined && f.kind === "prose" && f.value.length > 0 ? f.value : el.id;
}

function scalarOf(el: DeepReadonly<IItem>, field: string): string {
  const f = el.fields[field];
  return f !== undefined && f.kind === "scalar" ? String(f.value) : "";
}

// ── notes outline (flat list + depth, subtree-aware — same shape as spec-restatement) ──

/** A note's 0-based nesting depth: top-level notes are 0, a subsection under one is 1. */
function depthOf(el: DeepReadonly<IItem>): number {
  const n = Number(scalarOf(el, "depth"));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** The half-open index range of a note's SUBTREE — itself plus the run of deeper notes
 *  after it. Structure ops move and delete whole subtrees, so a note that leaves its
 *  children behind can never silently reparent them. */
function subtreeRange(elements: readonly DeepReadonly<IItem>[], index: number): { start: number; end: number } {
  const base = depthOf(elements[index]!);
  let end = index + 1;
  while (end < elements.length && depthOf(elements[end]!) > base) end++;
  return { start: index, end };
}

const setDepth = (id: string, value: number): SectionOp => ({
  op: "setElementField",
  section: "notes",
  field: "items",
  id,
  elementField: "depth",
  value: { kind: "scalar", value },
});

/** The deepest legal depth at `index` — one deeper than its predecessor, or 0 at the top
 *  ("no skipped heading levels"). */
function maxDepthAt(elements: readonly DeepReadonly<IItem>[], index: number): number {
  const prev = index > 0 ? elements[index - 1] : undefined;
  return prev === undefined ? 0 : depthOf(prev) + 1;
}

function requireLegalDepth(elements: readonly DeepReadonly<IItem>[], index: number, depth: number): void {
  const max = maxDepthAt(elements, index);
  if (depth > max) {
    throw new InvariantViolationError(
      `depth ${depth} skips a level at this position — the deepest legal depth here is ${max}`,
    );
  }
}

/** `moveElement` ops relocating a whole subtree so its first member lands at `toIndex` of
 *  the list without the subtree; members move one at a time so the run stays contiguous. */
function moveSubtreeOps(ids: readonly string[], subtree: readonly string[], toIndex: number): SectionOp[] {
  const rest = ids.filter((id) => !subtree.includes(id));
  const at = Math.max(0, Math.min(toIndex, rest.length));
  const cur = [...ids];
  const ops: SectionOp[] = [];
  subtree.forEach((id, k) => {
    cur.splice(cur.indexOf(id), 1);
    const insert = k === 0 ? (at === 0 ? 0 : cur.indexOf(rest[at - 1]!) + 1) : cur.indexOf(subtree[k - 1]!) + 1;
    cur.splice(insert, 0, id);
    ops.push({ op: "moveElement", section: "notes", field: "items", id, toIndex: insert });
  });
  return ops;
}

function noteAt(page: DeepReadonly<PageState>, noteId: string): { index: number; el: DeepReadonly<IItem> } {
  const elements = notesOf(page);
  const index = elements.findIndex((e) => e.id === noteId);
  if (index === -1) throw new InvariantViolationError(`note "${noteId}" not found in notes.items`);
  return { index, el: elements[index]! };
}

function noteFields(title: string, markdown: string, newId: () => string, depth: number): Record<string, IField> {
  return {
    title: { kind: "prose", value: title },
    body: { kind: "blocks", blocks: parseBlocks(markdown, newId) },
    depth: { kind: "scalar", value: depth },
  };
}

// ── glossary (alphabetical by construction) ─────────────────────────────────────

/** The dedup/sort key: trimmed, lowercased, compared by codepoint (deterministic — no
 *  locale-dependent collation in a reducer). */
function termKey(term: string): string {
  return term.trim().toLowerCase();
}

function termAt(page: DeepReadonly<PageState>, termId: string): DeepReadonly<IItem> {
  const el = termsOf(page).find((e) => e.id === termId);
  if (el === undefined) throw new InvariantViolationError(`term "${termId}" not found in glossary.terms`);
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
  section: "glossary",
  field: "terms",
  element: termId,
  event,
});

/** Clear a stale verdict — every edit that changes what was evaluated emits these. */
function clearEvaluation(termId: string): SectionOp[] {
  return [
    { op: "setElementField", section: "glossary", field: "terms", id: termId, elementField: "grade", value: { kind: "scalar", value: "" } },
    { op: "setElementField", section: "glossary", field: "terms", id: termId, elementField: "feedback", value: { kind: "blocks", blocks: [] } },
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

const allTermsDefined: Precondition = (page) => {
  const open = termsOf(page).filter((e) => e.status === "marked");
  return open.length === 0
    ? true
    : { unmet: `define these glossary terms first: ${open.map(titleOf).join(", ")}` };
};

export const StudyNotes = definePageType({
  type: "study-notes",
  label: "Study notes",
  description:
    "Reading notes plus a glossary the notes feed, for working through a book or course. The NOTES outline " +
    "is the human's own words — capture or revise notes only when the human asks, never draft study content " +
    "for them. `captureNote` appends (or inserts after `afterId`); `depth` nests a note under the one above " +
    "it (0 = top level, never skipping a level); subtrees travel together on move and delete.\n\n" +
    "The GLOSSARY is the learning loop: `markTerm` flags a term as needing a definition (born `marked`, " +
    "listed under attention until defined; terms stay alphabetical by construction and duplicates are " +
    "refused). The human DEFINES each term in their own words in the Study studio — an agent never authors " +
    "definitions, that would defeat the point. `recordEvaluation` is the studio critic's verb: it records " +
    "an AI evaluation of the human's definition (grade + feedback) and moves the term to `checked`. NEVER " +
    "call it with a grade you did not actually produce by critiquing the definition. Redefining a settled " +
    "term honestly returns it to `defined` and clears the stale verdict.\n\n" +
    "A term is WORKING (`marked` | `defined` | `checked`) until the human accepts it: `acceptTerm` is their " +
    "\"I understand this\" and the only way to `accepted`, `reopenTerm` puts it back. Nothing an agent or " +
    "the critic does moves a term out of the working set.\n\n" +
    "`finish` is a human gate, refused while any term is still undefined; `reopen` resumes capturing.",
  version: 1,
  initialStatus: "capturing",
  statusTransitions: [
    t("capturing", "finish", "finished", { agency: "human" }),
    t("finished", "reopen", "capturing", { agency: "human" }),
  ],
  sections: {
    notes: {
      name: "Notes",
      required: true,
      mutableIn: ["capturing"],
      fields: { items: { kind: "list", element: "note-section", ordered: true } },
    },
    glossary: {
      name: "Glossary",
      required: true,
      mutableIn: ["capturing"],
      fields: { terms: { kind: "list", element: "glossary-term", ordered: true } },
    },
  },
  elements: {
    "note-section": {
      fields: {
        title: { kind: "prose", required: true },
        body: { kind: "blocks", required: true },
        /** 0-based outline depth: 0 renders `##`-level, 1 is a subsection of the one above. */
        depth: { kind: "scalar" },
      },
    },
    "glossary-term": {
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
    },
  },
  sectionSet: { mode: "closed" },
  commands: {
    captureNote: {
      description:
        "Add one note section. `markdown` is the body (full block Markdown). `depth` nests it under the " +
        "note above (0 = top level, never skipping a level). Appends unless `afterId` names a note to land " +
        "immediately after — after its whole subtree, so \"after X\" never lands inside X's children.",
      args: zodSchema(
        z.object({
          title: z.string().min(1),
          markdown: z.string(),
          afterId: z.string().optional(),
          depth: z.number().int().min(0).optional(),
        }),
      ),
      result: zodSchema(z.object({ noteId: z.string() })),
      target: { section: "notes", field: "items" },
      produces: (page, args, ctx) => {
        const a = args as { title: string; markdown: string; afterId?: string; depth?: number };
        const elements = notesOf(page);
        let index = elements.length;
        if (a.afterId !== undefined) {
          const at = elements.findIndex((e) => e.id === a.afterId);
          if (at === -1) throw new InvariantViolationError(`afterId "${a.afterId}" is not a note on this page`);
          index = subtreeRange(elements, at).end;
        }
        const depth = a.depth ?? 0;
        requireLegalDepth(elements, index, depth);
        return [
          {
            op: "addElement",
            section: "notes",
            field: "items",
            id: ctx.newId(),
            fields: noteFields(a.title, a.markdown, ctx.newId, depth),
            ...(index !== elements.length ? { index } : {}),
          },
        ];
      },
    },
    reviseNote: {
      description: "Rewrite a note's body (and optionally its title).",
      args: zodSchema(z.object({ noteId: z.string(), title: z.string().min(1).optional(), markdown: z.string() })),
      target: { section: "notes", field: "items" },
      produces: (page, args, ctx) => {
        const a = args as { noteId: string; title?: string; markdown: string };
        noteAt(page, a.noteId);
        const ops: SectionOp[] = [
          {
            op: "setElementField",
            section: "notes",
            field: "items",
            id: a.noteId,
            elementField: "body",
            value: { kind: "blocks", blocks: parseBlocks(a.markdown, ctx.newId) },
          },
        ];
        if (a.title !== undefined) {
          ops.push({ op: "setElementField", section: "notes", field: "items", id: a.noteId, elementField: "title", value: { kind: "prose", value: a.title } });
        }
        return ops;
      },
    },
    indentNote: {
      description:
        "Nest a note under the one above it — it and its own subtree shift one level deeper. Refused when " +
        "it would skip a heading level.",
      args: zodSchema(z.object({ noteId: z.string() })),
      target: { section: "notes", field: "items" },
      produces: (page, args) => {
        const a = args as { noteId: string };
        const elements = notesOf(page);
        const { index, el } = noteAt(page, a.noteId);
        requireLegalDepth(elements, index, depthOf(el) + 1);
        const { start, end } = subtreeRange(elements, index);
        return elements.slice(start, end).map((s) => setDepth(s.id, depthOf(s) + 1));
      },
    },
    outdentNote: {
      description:
        "Promote a nested note one level toward the top — it and its own subtree shift one level " +
        "shallower. Refused on a top-level note.",
      args: zodSchema(z.object({ noteId: z.string() })),
      target: { section: "notes", field: "items" },
      produces: (page, args) => {
        const a = args as { noteId: string };
        const elements = notesOf(page);
        const { index, el } = noteAt(page, a.noteId);
        if (depthOf(el) === 0) throw new InvariantViolationError(`"${titleOf(el)}" is already a top-level note`);
        const { start, end } = subtreeRange(elements, index);
        return elements.slice(start, end).map((s) => setDepth(s.id, depthOf(s) - 1));
      },
    },
    moveNote: {
      description:
        "Reorder: move a note — WITH its subtree, as one block — to 0-based `toIndex` among the notes " +
        "remaining once the block is lifted out. The block's depth is clamped to what the destination " +
        "allows, so a move can never leave a skipped heading level behind.",
      args: zodSchema(z.object({ noteId: z.string(), toIndex: z.number().int().min(0) })),
      target: { section: "notes", field: "items" },
      produces: (page, args) => {
        const a = args as { noteId: string; toIndex: number };
        const elements = notesOf(page);
        const { index, el } = noteAt(page, a.noteId);
        const { start, end } = subtreeRange(elements, index);
        const block = elements.slice(start, end);
        const rest = elements.filter((e) => !block.includes(e));
        if (a.toIndex > rest.length) {
          throw new InvariantViolationError(`toIndex ${a.toIndex} is past the last position (${rest.length})`);
        }
        const before = a.toIndex > 0 ? rest[a.toIndex - 1] : undefined;
        const ceiling = before === undefined ? 0 : depthOf(before) + 1;
        const shift = Math.min(0, ceiling - depthOf(el));
        const ops = moveSubtreeOps(
          elements.map((e) => e.id),
          block.map((e) => e.id),
          a.toIndex,
        );
        if (shift !== 0) for (const s of block) ops.push(setDepth(s.id, depthOf(s) + shift));
        return ops;
      },
    },
    removeNote: {
      description: "Delete a note outright — its subtree goes with it.",
      args: zodSchema(z.object({ noteId: z.string() })),
      target: { section: "notes", field: "items" },
      produces: (page, args) => {
        const a = args as { noteId: string };
        const elements = notesOf(page);
        const { index } = noteAt(page, a.noteId);
        const { start, end } = subtreeRange(elements, index);
        return elements.slice(start, end).map((s): SectionOp => ({ op: "removeElement", section: "notes", field: "items", id: s.id }));
      },
    },
    markTerm: {
      description:
        "Flag a term as needing a definition (born `marked`; the studio and the attention list surface it " +
        "until the human defines it). Inserted at its alphabetical position; a duplicate (case-insensitive) " +
        "is refused. `markdown`, when given, defines the term in the same commit (born `defined`) — the " +
        "human's own words only.",
      args: zodSchema(z.object({ term: z.string().min(1), markdown: z.string().optional() })),
      result: zodSchema(z.object({ termId: z.string() })),
      target: { section: "glossary", field: "terms" },
      produces: (page, args, ctx) => {
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
            section: "glossary",
            field: "terms",
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
        "Write a term's definition — the HUMAN's restatement of what the term means, authored in the Study " +
        "studio (an agent never writes these). A `marked` term becomes `defined`; redefining a `checked` " +
        "term returns it to `defined` and clears the stale evaluation.",
      args: zodSchema(z.object({ termId: z.string(), markdown: z.string().min(1) })),
      target: { section: "glossary", field: "terms" },
      produces: (page, args, ctx) => {
        const a = args as { termId: string; markdown: string };
        const el = termAt(page, a.termId);
        const ops: SectionOp[] = beforeContentEdit(el);
        ops.push({
          op: "setElementField",
          section: "glossary",
          field: "terms",
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
      target: { section: "glossary", field: "terms" },
      produces: (page, args) => {
        const a = args as { termId: string; term: string };
        const term = a.term.trim();
        if (term === "") throw new InvariantViolationError("term is empty");
        const el = termAt(page, a.termId);
        const terms = termsOf(page);
        requireFreshTerm(terms, term, a.termId);
        const ops: SectionOp[] = beforeContentEdit(el);
        ops.push(
          { op: "setElementField", section: "glossary", field: "terms", id: a.termId, elementField: "title", value: { kind: "prose", value: term } },
          { op: "moveElement", section: "glossary", field: "terms", id: a.termId, toIndex: alphabeticalIndex(terms, term, a.termId) },
        );
        return ops;
      },
    },
    unmarkTerm: {
      description: "Remove a term from the glossary — the human's call that it does not belong.",
      args: zodSchema(z.object({ termId: z.string() })),
      target: { section: "glossary", field: "terms" },
      produces: (page, args) => {
        const a = args as { termId: string };
        termAt(page, a.termId);
        return [{ op: "removeElement", section: "glossary", field: "terms", id: a.termId }];
      },
    },
    recordEvaluation: {
      description:
        "Record the studio critic's REAL evaluation of a term's definition: grade (understood | partial | " +
        "surface) plus feedback Markdown, moving the term to `checked` in one commit. Runs only on a " +
        "`defined` term. NEVER call this with a verdict you did not actually produce by critiquing the " +
        "human's definition against the term's meaning and the page's notes.",
      args: zodSchema(z.object({ termId: z.string(), grade: gradeArg, markdown: z.string().min(1) })),
      target: { section: "glossary", field: "terms" },
      produces: (page, args, ctx) => {
        const a = args as { termId: string; grade: (typeof GRADES)[number]; markdown: string };
        const el = termAt(page, a.termId);
        if (el.status !== "defined") {
          throw new InvariantViolationError(
            `"${titleOf(el)}" is ${el.status ?? "statusless"} — evaluations run on a defined term` +
              (el.status === "checked" ? " (redefine it first)" : ""),
          );
        }
        return [
          { op: "setElementField", section: "glossary", field: "terms", id: a.termId, elementField: "grade", value: { kind: "scalar", value: a.grade } },
          { op: "setElementField", section: "glossary", field: "terms", id: a.termId, elementField: "feedback", value: { kind: "blocks", blocks: parseBlocks(a.markdown, ctx.newId) } },
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
      target: { section: "glossary", field: "terms" },
      produces: (page, args) => {
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
      target: { section: "glossary", field: "terms" },
      produces: (page, args) => {
        const a = args as { termId: string };
        const el = termAt(page, a.termId);
        if (el.status !== "accepted") {
          throw new InvariantViolationError(`"${titleOf(el)}" is ${el.status ?? "statusless"} — only an accepted term reopens`);
        }
        return [termTransition(a.termId, "reopen")];
      },
    },
    finish: {
      description:
        "Human sign-off: the notes are complete and every glossary term is defined. Refused while any term " +
        "is still `marked`.",
      args: zodSchema(empty),
      transition: { level: "page", event: "finish" },
      preconditions: [allTermsDefined],
    },
    reopen: {
      description: "Reopen finished notes for more capturing.",
      args: zodSchema(empty),
      transition: { level: "page", event: "reopen" },
    },
  },
  render: {
    title: "Notes: {title}",
    sections: [
      {
        section: "notes",
        heading: "Notes",
        field: "items",
        as: "sections",
        numbered: false,
        depthField: "depth",
        placeholder: "_No notes yet._",
        element: { heading: "{title}", body: [{ field: "body" }] },
      },
      {
        section: "glossary",
        heading: "Glossary",
        field: "terms",
        as: "sections",
        numbered: false,
        placeholder: "_No terms marked._",
        element: {
          heading: "{title}",
          body: [{ field: "definition" }, { label: "Critique", field: "feedback" }],
        },
      },
    ],
  },
});
