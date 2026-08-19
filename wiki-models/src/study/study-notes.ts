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
import type { DeepReadonly, IField, IItem, PageState, SectionOp } from "wiki/authoring";
import { definePageType, InvariantViolationError, parseBlocks, t, z, zodSchema } from "wiki/authoring";
import {
  allTermsDefined,
  GLOSSARY_DESCRIPTION,
  glossaryCommands,
  glossaryRenderSection,
  glossarySection,
  glossaryTermElement,
} from "../shared/glossary";
import { listOf, scalarOf, titleOf } from "../shared/page-state";

const empty = z.object({});

const notesOf = (page: DeepReadonly<PageState>): readonly DeepReadonly<IItem>[] => listOf(page, "notes", "items");

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

export const StudyNotes = definePageType({
  type: "study-notes",
  label: "Study notes",
  description:
    "Reading notes plus a glossary the notes feed, for working through a book or course. The NOTES outline " +
    "is the human's own words — capture or revise notes only when the human asks, never draft study content " +
    "for them. `captureNote` appends (or inserts after `afterId`); `depth` nests a note under the one above " +
    "it (0 = top level, never skipping a level); subtrees travel together on move and delete.\n\n" +
    GLOSSARY_DESCRIPTION +
    "\n\n" +
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
    glossary: glossarySection({ mutableIn: ["capturing"] }),
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
    "glossary-term": glossaryTermElement,
  },
  sectionSet: { mode: "closed" },
  commands: {
    ...glossaryCommands,
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
      glossaryRenderSection(),
    ],
  },
});
