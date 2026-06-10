/**
 * `document` page type — a general-purpose, free-form document whose ENTIRE content is
 * one ordered `blocks` field: paragraphs, headings, code, plus page-refs and link-marked
 * text for references. The first bundle to use blocks as the whole page; everything else
 * (the closed IBlock vocabulary, the block section-ops, the generic `as: "blocks"`
 * renderer) is engine-owned — this type only curates the authoring commands.
 *
 * Deliberately lifecycle-free (the `toc` precedent): a single `active` status with NO
 * transitions — always editable, no agency edges, no awaitsHuman elements; structural
 * `archivePage` handles removal. No image block kind exists in the engine vocabulary
 * (ADR-6): external images are representable as link-marked text until an `image` kind
 * lands under its own decision record.
 */
import type { BlockId, IBlock, IInline, PageId, RefTarget } from "wiki/authoring";
import { definePageType, z, zodSchema } from "wiki/authoring";

/** A paragraph block of a single plain text run. */
function paragraph(id: BlockId, text: string): IBlock {
  return { kind: "paragraph", id, inlines: [{ kind: "text", value: text, marks: [] }] };
}

export const Document = definePageType({
  type: "document",
  label: "Document",
  version: 1,
  initialStatus: "active",
  statusTransitions: [],
  sections: {
    body: {
      name: "Body",
      required: true,
      mutableIn: ["active"],
      fields: { body: { kind: "blocks" } },
    },
  },
  sectionSet: { mode: "closed" },
  commands: {
    addParagraph: {
      description: "Append a plain paragraph (pass `index` to insert at that position).",
      args: zodSchema(z.object({ text: z.string(), index: z.number().int().min(0).optional() })),
      result: zodSchema(z.object({ blockId: z.string() })),
      target: { section: "body", field: "body" },
      produces: (_page, args, ctx) => {
        const a = args as { text: string; index?: number };
        return [
          { op: "addBlock", section: "body", field: "body", block: paragraph(ctx.newId() as BlockId, a.text), index: a.index },
        ];
      },
    },
    addHeading: {
      description: "Append a heading at `level` 1–6 (pass `index` to insert at that position).",
      args: zodSchema(
        z.object({ level: z.number().int().min(1).max(6), text: z.string(), index: z.number().int().min(0).optional() }),
      ),
      result: zodSchema(z.object({ blockId: z.string() })),
      target: { section: "body", field: "body" },
      produces: (_page, args, ctx) => {
        const a = args as { level: 1 | 2 | 3 | 4 | 5 | 6; text: string; index?: number };
        const block: IBlock = {
          kind: "heading",
          id: ctx.newId() as BlockId,
          level: a.level,
          inlines: [{ kind: "text", value: a.text, marks: [] }],
        };
        return [{ op: "addBlock", section: "body", field: "body", block, index: a.index }];
      },
    },
    addCode: {
      description:
        "Append a fenced code block (pass `index` to insert at that position). The content hash is " +
        "recomputed at ingestion; later edits go through the generated applyBodyBodyBlockEdits under `expectedHash`.",
      args: zodSchema(
        z.object({ language: z.string(), source: z.string(), index: z.number().int().min(0).optional() }),
      ),
      result: zodSchema(z.object({ blockId: z.string() })),
      target: { section: "body", field: "body" },
      produces: (_page, args, ctx) => {
        const a = args as { language: string; source: string; index?: number };
        // hash is normalized/recomputed during ingestion (mirrors feature-spec addDesignCode).
        const block: IBlock = { kind: "code", id: ctx.newId() as BlockId, lang: a.language, source: a.source, hash: "" };
        return [{ op: "addBlock", section: "body", field: "body", block, index: a.index }];
      },
    },
    addPageRef: {
      description:
        "Append a reference to another wiki page: optional lead `text` followed by an integrity-checked " +
        "inline ref (label render-derived, so renames reflow). A `pageId` that resolves to no page aborts the commit.",
      args: zodSchema(
        z.object({ pageId: z.string(), text: z.string().optional(), index: z.number().int().min(0).optional() }),
      ),
      result: zodSchema(z.object({ blockId: z.string() })),
      target: { section: "body", field: "body" },
      produces: (_page, args, ctx) => {
        const a = args as { pageId: string; text?: string; index?: number };
        const target: RefTarget = { kind: "page", id: a.pageId as PageId };
        const inlines: IInline[] = [];
        if (a.text !== undefined) inlines.push({ kind: "text", value: `${a.text} `, marks: [] });
        inlines.push({ kind: "ref", target });
        const block: IBlock = { kind: "paragraph", id: ctx.newId() as BlockId, inlines };
        return [{ op: "addBlock", section: "body", field: "body", block, index: a.index }];
      },
    },
    addExternalLink: {
      description:
        "Append a paragraph whose `text` is link-marked with `href` — an external reference " +
        "(also the v1 representation of an external image).",
      args: zodSchema(
        z.object({ href: z.string(), text: z.string(), index: z.number().int().min(0).optional() }),
      ),
      result: zodSchema(z.object({ blockId: z.string() })),
      target: { section: "body", field: "body" },
      produces: (_page, args, ctx) => {
        const a = args as { href: string; text: string; index?: number };
        const block: IBlock = {
          kind: "paragraph",
          id: ctx.newId() as BlockId,
          inlines: [{ kind: "text", value: a.text, marks: [{ kind: "link", href: a.href }] }],
        };
        return [{ op: "addBlock", section: "body", field: "body", block, index: a.index }];
      },
    },
    setParagraph: {
      description: "Replace a paragraph's text in place (same block id, position unchanged).",
      args: zodSchema(z.object({ blockId: z.string(), text: z.string() })),
      target: { section: "body", field: "body" },
      produces: (_page, args) => {
        const a = args as { blockId: string; text: string };
        return [{ op: "setBlock", section: "body", field: "body", block: paragraph(a.blockId as BlockId, a.text) }];
      },
    },
    moveBlock: {
      description: "Move an existing block to `toIndex` within the document order.",
      args: zodSchema(z.object({ blockId: z.string(), toIndex: z.number().int().min(0) })),
      target: { section: "body", field: "body" },
      produces: (_page, args) => {
        const a = args as { blockId: string; toIndex: number };
        return [{ op: "moveBlock", section: "body", field: "body", block: a.blockId as BlockId, toIndex: a.toIndex }];
      },
    },
    removeBlock: {
      description: "Remove a block by id (an unknown id rejects the commit).",
      args: zodSchema(z.object({ blockId: z.string() })),
      target: { section: "body", field: "body" },
      produces: (_page, args) => [
        { op: "removeBlock", section: "body", field: "body", block: (args as { blockId: string }).blockId as BlockId },
      ],
    },
  },
  render: {
    title: "{title}",
    sections: [{ section: "body", field: "body", as: "blocks", placeholder: "_Empty document._" }],
  },
});
