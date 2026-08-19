/**
 * `article-notes` page type. Notes taken while reading ONE article, plus the summary
 * written afterwards: the source (its date and link), a list of notes that are
 * arbitrary Markdown or images, and a rich-text summary.
 *
 * The PAGE TITLE is the article's title — there is no second field for it, so the
 * tree, the mirrored filename and the rendered heading can never disagree.
 *
 * Deliberately not `study-notes`. That type is for working through a book or course:
 * a titled, nestable outline coupled to a glossary with an AI critic. An article is
 * one sitting, so a note here is just a chunk of Markdown with no title and no depth.
 * Sharing a shape between the two would distort both.
 *
 * Completeness is declarative: `requiredIn: ["summarized"]` on the link, the date and
 * the summary is the whole gate. The engine refuses `summarize` until they are
 * authored and names the missing `section.field` paths itself, so there are no
 * hand-rolled preconditions here.
 */
import type { DeepReadonly, IItem, PageState, SectionOp } from "wiki/authoring";
import { arg, definePageType, InvariantViolationError, parseBlocks, t, z, zodSchema } from "wiki/authoring";
import { listOf } from "../shared/page-state";

const empty = z.object({});

/** Editable while reading AND after summarizing: a bad link is worth fixing later. */
const editable = ["reading", "summarized"] as const;

const notesOf = (page: DeepReadonly<PageState>): readonly DeepReadonly<IItem>[] => listOf(page, "notes", "items");

function noteAt(page: DeepReadonly<PageState>, noteId: string): number {
  const index = notesOf(page).findIndex((e) => e.id === noteId);
  if (index === -1) throw new InvariantViolationError(`note "${noteId}" not found in notes.items`);
  return index;
}

/** The Source section as rendered rows — one section rather than two near-empty ones. */
function sourceRows(page: DeepReadonly<PageState>): readonly { id: string; text: string }[] {
  const fields = page.sections.find((s) => s.key === "source")?.fields ?? {};
  const value = (key: string): string => {
    const f = fields[key];
    return f !== undefined && f.kind === "scalar" ? String(f.value) : "";
  };
  const rows: { id: string; text: string }[] = [];
  const link = value("link");
  const date = value("date");
  if (link.length > 0) rows.push({ id: "link", text: `**Link:** ${link}` });
  if (date.length > 0) rows.push({ id: "date", text: `**Date:** ${date}` });
  return rows;
}

export const ArticleNotes = definePageType({
  type: "article-notes",
  label: "Article notes",
  description:
    "Notes on ONE article, and the summary written after reading it. The page title is the article's " +
    "title. Reach for it when reading a single piece and wanting to keep what it said plus what you made " +
    "of it. Use `study-notes` instead for a book or a course, where the notes form a nested outline and " +
    "feed a glossary.\n\n" +
    "The NOTES and the SUMMARY are the human's own words. Capture or revise them only when the human " +
    "asks, and NEVER draft study content on their behalf. A note is arbitrary Markdown, so it may be an " +
    "image: pass `![alt](attachment:<id>)` for an uploaded file, or an ordinary image URL.\n\n" +
    "`summarize` is a human gate. The engine refuses it until the link, the date and the summary are " +
    "authored, and names whichever is missing. `reopen` returns the page to `reading`.",
  version: 1,
  initialStatus: "reading",
  statusTransitions: [
    t("reading", "summarize", "summarized", { agency: "human" }),
    t("summarized", "reopen", "reading", { agency: "human" }),
  ],
  sections: {
    source: {
      name: "Source",
      required: true,
      mutableIn: [...editable],
      fields: {
        // An ISO date STRING, supplied by the caller. Never new Date(): a renderer and
        // a reducer must be pure, and a stored date is what makes the render stable.
        // `requiredIn` — not `required` — is the gate. The two are orthogonal: `required`
        // means "present in the materialized set", and a required section already
        // materializes its scalars as "". Marking these `required` as well would make the
        // engine validate that empty placeholder against the schema below and reject it
        // on the page's very first write.
        date: {
          kind: "scalar",
          requiredIn: ["summarized"],
          schema: zodSchema(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected an ISO date, e.g. 2026-08-19")),
        },
        link: {
          kind: "scalar",
          requiredIn: ["summarized"],
          schema: zodSchema(z.string().url("expected an absolute URL")),
        },
      },
    },
    notes: {
      name: "Notes",
      required: true,
      mutableIn: ["reading"],
      fields: { items: { kind: "list", element: "note", ordered: true } },
    },
    summary: {
      name: "Summary",
      required: true,
      mutableIn: [...editable],
      fields: { body: { kind: "blocks", requiredIn: ["summarized"] } },
    },
  },
  elements: {
    /** One note: a chunk of arbitrary Markdown. No title, no depth — see the header. */
    note: { fields: { body: { kind: "blocks", required: true } } },
  },
  sectionSet: { mode: "closed" },
  derived: { "source-rows": sourceRows },
  commands: {
    setDate: {
      description: "Record the article's date as an ISO `YYYY-MM-DD` string.",
      args: zodSchema(z.object({ date: z.string() })),
      target: { section: "source", field: "date" },
      set: { date: arg("date") },
    },
    setLink: {
      description: "Record the article's URL.",
      args: zodSchema(z.object({ link: z.string() })),
      target: { section: "source", field: "link" },
      set: { link: arg("link") },
    },
    addNote: {
      description:
        "Append one note (or insert it after `afterId`). `markdown` is the whole note as block Markdown, " +
        "so it may be prose, a list, a quote, a code block, or an image. Write only what the human dictates.",
      args: zodSchema(z.object({ markdown: z.string().min(1), afterId: z.string().optional() })),
      result: zodSchema(z.object({ noteId: z.string() })),
      target: { section: "notes", field: "items" },
      produces: (page, args, ctx) => {
        const a = args as { markdown: string; afterId?: string };
        const elements = notesOf(page);
        const index = a.afterId === undefined ? elements.length : noteAt(page, a.afterId) + 1;
        return [
          {
            op: "addElement",
            section: "notes",
            field: "items",
            id: ctx.newId(),
            fields: { body: { kind: "blocks", blocks: parseBlocks(a.markdown, ctx.newId) } },
            ...(index !== elements.length ? { index } : {}),
          },
        ];
      },
    },
    reviseNote: {
      description: "Rewrite one note's body in place.",
      args: zodSchema(z.object({ noteId: z.string(), markdown: z.string().min(1) })),
      target: { section: "notes", field: "items" },
      produces: (page, args, ctx) => {
        const a = args as { noteId: string; markdown: string };
        noteAt(page, a.noteId);
        return [
          {
            op: "setElementField",
            section: "notes",
            field: "items",
            id: a.noteId,
            elementField: "body",
            value: { kind: "blocks", blocks: parseBlocks(a.markdown, ctx.newId) },
          },
        ];
      },
    },
    moveNote: {
      description: "Reorder: move a note to 0-based `toIndex` among the notes.",
      args: zodSchema(z.object({ noteId: z.string(), toIndex: z.number().int().min(0) })),
      target: { section: "notes", field: "items" },
      produces: (page, args) => {
        const a = args as { noteId: string; toIndex: number };
        const elements = notesOf(page);
        noteAt(page, a.noteId);
        if (a.toIndex >= elements.length) {
          throw new InvariantViolationError(`toIndex ${a.toIndex} is past the last note (${elements.length - 1})`);
        }
        return [{ op: "moveElement", section: "notes", field: "items", id: a.noteId, toIndex: a.toIndex }];
      },
    },
    removeNote: {
      description: "Delete one note outright.",
      args: zodSchema(z.object({ noteId: z.string() })),
      target: { section: "notes", field: "items" },
      produces: (page, args) => {
        const a = args as { noteId: string };
        noteAt(page, a.noteId);
        return [{ op: "removeElement", section: "notes", field: "items", id: a.noteId }];
      },
    },
    writeSummary: {
      description:
        "Set the summary — what the human made of the article, in their own words, as block Markdown. " +
        "NEVER write this for them.",
      args: zodSchema(z.object({ markdown: z.string() })),
      target: { section: "summary", field: "body" },
      produces: (_page, args, ctx): SectionOp[] => [
        {
          op: "setField",
          section: "summary",
          field: "body",
          value: { kind: "blocks", blocks: parseBlocks((args as { markdown: string }).markdown, ctx.newId) },
        },
      ],
    },
    summarize: {
      description:
        "Human sign-off: the article is read and summarized. Refused until the link, the date and the " +
        "summary are all authored.",
      args: zodSchema(empty),
      transition: { level: "page", event: "summarize" },
    },
    reopen: {
      description: "Return a summarized page to `reading` to capture more notes.",
      args: zodSchema(empty),
      transition: { level: "page", event: "reopen" },
    },
  },
  render: {
    title: "Article notes: {title}",
    sections: [
      { derived: "source-rows", heading: "Source", placeholder: "_No source recorded._" },
      { section: "summary", heading: "Summary", field: "body", as: "blocks", placeholder: "_Not summarized yet._" },
      {
        section: "notes",
        heading: "Notes",
        field: "items",
        as: "stack",
        placeholder: "_No notes yet._",
        element: { body: [{ field: "body" }] },
      },
    ],
  },
});
