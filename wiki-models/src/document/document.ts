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
import type { BlockId, DeepReadonly, IBlock, IInline, PageId, PageState, RefTarget, SectionOp } from "wiki/authoring";
import { definePageType, InvariantViolationError, z, zodSchema } from "wiki/authoring";

/** The one content address every command targets. */
const BODY = { section: "body", field: "body" } as const;

/** A paragraph block of a single plain text run. */
function paragraph(id: BlockId, text: string): IBlock {
  return { kind: "paragraph", id, inlines: [{ kind: "text", value: text, marks: [] }] };
}

/** The one-op envelope for inserting a block (at `index`, or appended). */
function addBody(block: IBlock, index?: number): SectionOp[] {
  return [{ op: "addBlock", ...BODY, block, index }];
}

/** The body's current block of the given id, or undefined. */
function bodyBlock(page: DeepReadonly<PageState>, blockId: string): DeepReadonly<IBlock> | undefined {
  const f = page.sections.find((s) => s.key === BODY.section)?.fields[BODY.field];
  return f !== undefined && f.kind === "blocks" ? f.blocks.find((b) => String(b.id) === blockId) : undefined;
}

const optionalIndex = z.number().int().min(0).optional();

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
      args: zodSchema(z.object({ text: z.string().min(1), index: optionalIndex })),
      result: zodSchema(z.object({ blockId: z.string() })),
      target: BODY,
      produces: (_page, args, ctx) => {
        const a = args as { text: string; index?: number };
        return addBody(paragraph(ctx.newId() as BlockId, a.text), a.index);
      },
    },
    addHeading: {
      description: "Append a heading at `level` 1–6 (pass `index` to insert at that position).",
      args: zodSchema(z.object({ level: z.number().int().min(1).max(6), text: z.string().min(1), index: optionalIndex })),
      result: zodSchema(z.object({ blockId: z.string() })),
      target: BODY,
      produces: (_page, args, ctx) => {
        const a = args as { level: 1 | 2 | 3 | 4 | 5 | 6; text: string; index?: number };
        const block: IBlock = {
          kind: "heading",
          id: ctx.newId() as BlockId,
          level: a.level,
          inlines: [{ kind: "text", value: a.text, marks: [] }],
        };
        return addBody(block, a.index);
      },
    },
    addCode: {
      description:
        "Append a fenced code block (pass `index` to insert at that position). The content hash is " +
        "recomputed at ingestion; later edits go through the generated applyBodyBodyBlockEdits under `expectedHash`.",
      args: zodSchema(
        z.object({
          // A fence info token: the renderer emits "```" + language verbatim, so whitespace
          // or backticks would corrupt the fence line.
          language: z.string().min(1).regex(/^[^\s`]+$/, "a language tag is a single token with no whitespace or backticks"),
          source: z.string(),
          index: optionalIndex,
        }),
      ),
      result: zodSchema(z.object({ blockId: z.string() })),
      target: BODY,
      produces: (_page, args, ctx) => {
        const a = args as { language: string; source: string; index?: number };
        // hash is normalized/recomputed during ingestion (mirrors feature-spec addDesignCode).
        const block: IBlock = { kind: "code", id: ctx.newId() as BlockId, lang: a.language, source: a.source, hash: "" };
        return addBody(block, a.index);
      },
    },
    addPageRef: {
      description:
        "Append a reference to another wiki page: optional lead `text` followed by an integrity-checked " +
        "inline ref (label render-derived, so renames reflow). A `pageId` that resolves to no page aborts the commit.",
      args: zodSchema(z.object({ pageId: z.string(), text: z.string().min(1).optional(), index: optionalIndex })),
      result: zodSchema(z.object({ blockId: z.string() })),
      target: BODY,
      produces: (_page, args, ctx) => {
        const a = args as { pageId: string; text?: string; index?: number };
        const target: RefTarget = { kind: "page", id: a.pageId as PageId };
        const inlines: IInline[] = [];
        const lead = a.text?.replace(/\s+$/, "");
        if (lead !== undefined && lead.length > 0) inlines.push({ kind: "text", value: `${lead} `, marks: [] });
        inlines.push({ kind: "ref", target });
        return addBody({ kind: "paragraph", id: ctx.newId() as BlockId, inlines }, a.index);
      },
    },
    addExternalLink: {
      description:
        "Append a paragraph whose `text` is link-marked with `href` — an external reference " +
        "(also the v1 representation of an external image).",
      args: zodSchema(z.object({ href: z.string().min(1), text: z.string().min(1), index: optionalIndex })),
      result: zodSchema(z.object({ blockId: z.string() })),
      target: BODY,
      produces: (_page, args, ctx) => {
        const a = args as { href: string; text: string; index?: number };
        const block: IBlock = {
          kind: "paragraph",
          id: ctx.newId() as BlockId,
          inlines: [{ kind: "text", value: a.text, marks: [{ kind: "link", href: a.href }] }],
        };
        return addBody(block, a.index);
      },
    },
    setParagraph: {
      description: "Replace a PARAGRAPH's text in place (same block id, position unchanged); rejects any other block kind.",
      args: zodSchema(z.object({ blockId: z.string(), text: z.string().min(1) })),
      target: BODY,
      produces: (page, args) => {
        const a = args as { blockId: string; text: string };
        // The engine's setBlock is kind-blind (it only asserts the id exists), so guard here:
        // silently turning a heading/code block into a paragraph would destroy content.
        const existing = bodyBlock(page, a.blockId);
        if (existing !== undefined && existing.kind !== "paragraph") {
          throw new InvariantViolationError(
            `setParagraph targets a ${existing.kind} block ("${a.blockId}") — it only edits paragraphs; use removeBlock + an add command (or applyBodyBodyBlockEdits for code).`,
          );
        }
        return [{ op: "setBlock", ...BODY, block: paragraph(a.blockId as BlockId, a.text) }];
      },
    },
    moveBlock: {
      description: "Move an existing block to `toIndex` within the document order.",
      args: zodSchema(z.object({ blockId: z.string(), toIndex: z.number().int().min(0) })),
      target: BODY,
      produces: (_page, args) => {
        const a = args as { blockId: string; toIndex: number };
        return [{ op: "moveBlock", ...BODY, block: a.blockId as BlockId, toIndex: a.toIndex }];
      },
    },
    removeBlock: {
      description: "Remove a block by id (an unknown id rejects the commit).",
      args: zodSchema(z.object({ blockId: z.string() })),
      target: BODY,
      produces: (_page, args) => [{ op: "removeBlock", ...BODY, block: (args as { blockId: string }).blockId as BlockId }],
    },
  },
  render: {
    title: "{title}",
    sections: [{ section: "body", field: "body", as: "blocks", placeholder: "_Empty document._" }],
  },
});
