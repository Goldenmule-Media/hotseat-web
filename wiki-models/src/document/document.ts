/**
 * `document` page type — a general-purpose, free-form document whose ENTIRE content is
 * one ordered `blocks` field, curating the full engine block vocabulary: paragraphs,
 * headings, fenced code, lists, block quotes, tables, and dividers. Wherever inline
 * text appears it is authored as RUNS — plain strings, marked text (bold/italic/link),
 * inline code spans, and integrity-checked page refs — mapped onto the closed IInline
 * vocabulary. Everything else (IBlock, the block section-ops, normalization, the
 * generic `as: "blocks"` renderer) is engine-owned — this type only curates the
 * authoring commands.
 *
 * Deliberately lifecycle-free (the `toc` precedent): a single `active` status with NO
 * transitions — always editable, no agency edges, no awaitsHuman elements; structural
 * `archivePage` handles removal. No image block kind exists in the engine vocabulary
 * (ADR-6): external images are representable as link-marked text until an `image` kind
 * lands under its own decision record. No underline mark either — underline is not in
 * the closed Mark vocabulary and has no native Markdown rendering; growing that
 * vocabulary takes a decision record.
 */
import type { BlockId, DeepReadonly, IBlock, IInline, Mark, PageId, PageState, SectionOp } from "wiki/authoring";
import { definePageType, InvariantViolationError, z, zodSchema } from "wiki/authoring";

/** The one content address every command targets. */
const BODY = { section: "body", field: "body" } as const;

// ────────────────────────────────────────────────────────────────────────────
// Inline runs — the authoring surface for everything inline
// ────────────────────────────────────────────────────────────────────────────

/** One authored inline run (the parsed shape of `runSchema`). */
type RunArg =
  | string
  | { text: string; bold?: boolean; italic?: boolean; href?: string }
  | { code: string }
  | { ref: string };

/** Strict object shapes so a mixed run (e.g. `{text, code}`) fails the union instead of
 *  silently dropping keys. */
const runSchema = z
  .union([
    z.string().min(1),
    z
      .object({
        text: z.string().min(1),
        bold: z.boolean().optional(),
        italic: z.boolean().optional(),
        href: z.string().min(1).optional(),
      })
      .strict(),
    z.object({ code: z.string().min(1) }).strict(),
    z.object({ ref: z.string().min(1) }).strict(),
  ])
  .describe(
    'An inline run: a plain string; {"text","bold"?,"italic"?,"href"?} for marked text; ' +
      '{"code"} for an inline code span; {"ref":"<pageId>"} for a page reference.',
  );

/** A non-empty inline sequence — one paragraph's (or heading's, or list item's) worth of runs. */
const inlinesSchema = z.array(runSchema).min(1);

/** A table cell: zero or more runs (an empty array is an empty cell). */
const cellSchema = z.array(runSchema);

/** Map authored runs onto the closed engine inline vocabulary. Marks are emitted in
 *  canonical order (emphasis < strong < link); the reducer re-normalizes regardless. */
function toInlines(runs: readonly RunArg[]): IInline[] {
  return runs.map((r): IInline => {
    if (typeof r === "string") return { kind: "text", value: r, marks: [] };
    if ("code" in r) return { kind: "code-span", value: r.code };
    if ("ref" in r) return { kind: "ref", target: { kind: "page", id: r.ref as PageId } };
    const marks: Mark[] = [];
    if (r.italic === true) marks.push("emphasis");
    if (r.bold === true) marks.push("strong");
    if (r.href !== undefined) marks.push({ kind: "link", href: r.href });
    return { kind: "text", value: r.text, marks };
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Block builders — shared by the add*/set* command pairs
// ────────────────────────────────────────────────────────────────────────────

function paragraph(id: BlockId, runs: readonly RunArg[]): IBlock {
  return { kind: "paragraph", id, inlines: toInlines(runs) };
}

function heading(id: BlockId, level: 1 | 2 | 3 | 4 | 5 | 6, runs: readonly RunArg[]): IBlock {
  return { kind: "heading", id, level, inlines: toInlines(runs) };
}

/** Each item is ONE paragraph of runs — the engine's nested-block items stay uncurated. */
function list(id: BlockId, ordered: boolean, items: readonly (readonly RunArg[])[], newId: () => string): IBlock {
  return { kind: "list", id, ordered, items: items.map((runs) => [paragraph(newId() as BlockId, runs)]) };
}

function quote(id: BlockId, paragraphs: readonly (readonly RunArg[])[], newId: () => string): IBlock {
  return { kind: "quote", id, blocks: paragraphs.map((runs) => paragraph(newId() as BlockId, runs)) };
}

type TableAlign = ("left" | "center" | "right" | null)[];

/** `align` defaults to no alignment per header column; widths/rectangularity are engine-validated. */
function table(
  id: BlockId,
  header: readonly (readonly RunArg[])[],
  rows: readonly (readonly (readonly RunArg[])[])[],
  align: TableAlign | undefined,
): IBlock {
  return {
    kind: "table",
    id,
    align: align ?? header.map(() => null),
    header: header.map(toInlines),
    rows: rows.map((row) => row.map(toInlines)),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Op envelopes + the kind guard
// ────────────────────────────────────────────────────────────────────────────

/** The one-op envelope for inserting a block (at `index`, or appended). */
function addBody(block: IBlock, index?: number): SectionOp[] {
  return [{ op: "addBlock", ...BODY, block, index }];
}

/** The body's current block of the given id, or undefined. */
function bodyBlock(page: DeepReadonly<PageState>, blockId: string): DeepReadonly<IBlock> | undefined {
  const f = page.sections.find((s) => s.key === BODY.section)?.fields[BODY.field];
  return f !== undefined && f.kind === "blocks" ? f.blocks.find((b) => String(b.id) === blockId) : undefined;
}

/**
 * Kind-guarded in-place replace (same block id, position unchanged). The engine's
 * setBlock is kind-blind (it only asserts the id exists), so guard here: silently
 * turning one block kind into another would destroy content.
 */
function replaceBody(
  page: DeepReadonly<PageState>,
  command: string,
  blockId: string,
  kind: IBlock["kind"],
  build: (id: BlockId) => IBlock,
): SectionOp[] {
  const existing = bodyBlock(page, blockId);
  if (existing !== undefined && existing.kind !== kind) {
    throw new InvariantViolationError(
      `${command} targets a ${existing.kind} block ("${blockId}") — it only edits ${kind} blocks; ` +
        `use removeBlock + an add command (or applyBodyBodyBlockEdits for code).`,
    );
  }
  return [{ op: "setBlock", ...BODY, block: build(blockId as BlockId) }];
}

const optionalIndex = z.number().int().min(0).optional();
const levelArg = z.number().int().min(1).max(6);
const addedBlockId = zodSchema(z.object({ blockId: z.string() }));

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
      description:
        "Append a paragraph of inline runs (pass `index` to insert at that position). A run is a plain string; " +
        "{text, bold?, italic?, href?} for bold/italic/link-marked text; {code} for an inline code span; or " +
        "{ref: pageId} for an integrity-checked page reference whose label is render-derived (a dangling pageId " +
        "aborts the commit). Markdown syntax inside a text run is rejected — express it as runs instead.",
      args: zodSchema(z.object({ inlines: inlinesSchema, index: optionalIndex })),
      result: addedBlockId,
      target: BODY,
      produces: (_page, args, ctx) => {
        const a = args as { inlines: RunArg[]; index?: number };
        return addBody(paragraph(ctx.newId() as BlockId, a.inlines), a.index);
      },
    },
    addHeading: {
      description: "Append a heading at `level` 1–6 of inline runs (pass `index` to insert at that position).",
      args: zodSchema(z.object({ level: levelArg, inlines: inlinesSchema, index: optionalIndex })),
      result: addedBlockId,
      target: BODY,
      produces: (_page, args, ctx) => {
        const a = args as { level: 1 | 2 | 3 | 4 | 5 | 6; inlines: RunArg[]; index?: number };
        return addBody(heading(ctx.newId() as BlockId, a.level, a.inlines), a.index);
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
      result: addedBlockId,
      target: BODY,
      produces: (_page, args, ctx) => {
        const a = args as { language: string; source: string; index?: number };
        // hash is normalized/recomputed during ingestion (mirrors feature-spec addDesignCode).
        const block: IBlock = { kind: "code", id: ctx.newId() as BlockId, lang: a.language, source: a.source, hash: "" };
        return addBody(block, a.index);
      },
    },
    addList: {
      description:
        "Append a list — `ordered` true renders 1./2./3., false renders bullets; each item is one paragraph " +
        "of inline runs (pass `index` to insert at that position).",
      args: zodSchema(z.object({ ordered: z.boolean(), items: z.array(inlinesSchema).min(1), index: optionalIndex })),
      result: addedBlockId,
      target: BODY,
      produces: (_page, args, ctx) => {
        const a = args as { ordered: boolean; items: RunArg[][]; index?: number };
        return addBody(list(ctx.newId() as BlockId, a.ordered, a.items, ctx.newId), a.index);
      },
    },
    addQuote: {
      description:
        "Append a block quote of one or more paragraphs, each an array of inline runs (pass `index` to insert " +
        "at that position).",
      args: zodSchema(z.object({ paragraphs: z.array(inlinesSchema).min(1), index: optionalIndex })),
      result: addedBlockId,
      target: BODY,
      produces: (_page, args, ctx) => {
        const a = args as { paragraphs: RunArg[][]; index?: number };
        return addBody(quote(ctx.newId() as BlockId, a.paragraphs, ctx.newId), a.index);
      },
    },
    addTable: {
      description:
        "Append a table: `header` is one cell (an inline-run array; [] for an empty cell) per column, `rows` " +
        "matching the header width, optional `align` per column (left/center/right/null; defaults to null). " +
        "A width mismatch rejects the commit (pass `index` to insert at that position).",
      args: zodSchema(
        z.object({
          header: z.array(cellSchema).min(1),
          rows: z.array(z.array(cellSchema)),
          align: z.array(z.enum(["left", "center", "right"]).nullable()).optional(),
          index: optionalIndex,
        }),
      ),
      result: addedBlockId,
      target: BODY,
      produces: (_page, args, ctx) => {
        const a = args as { header: RunArg[][]; rows: RunArg[][][]; align?: TableAlign; index?: number };
        return addBody(table(ctx.newId() as BlockId, a.header, a.rows, a.align), a.index);
      },
    },
    addDivider: {
      description: "Append a horizontal divider (pass `index` to insert at that position).",
      args: zodSchema(z.object({ index: optionalIndex })),
      result: addedBlockId,
      target: BODY,
      produces: (_page, args, ctx) => {
        const a = args as { index?: number };
        return addBody({ kind: "divider", id: ctx.newId() as BlockId }, a.index);
      },
    },
    setParagraph: {
      description:
        "Replace a PARAGRAPH's inline runs in place (same block id, position unchanged); rejects any other block kind.",
      args: zodSchema(z.object({ blockId: z.string(), inlines: inlinesSchema })),
      target: BODY,
      produces: (page, args) => {
        const a = args as { blockId: string; inlines: RunArg[] };
        return replaceBody(page, "setParagraph", a.blockId, "paragraph", (id) => paragraph(id, a.inlines));
      },
    },
    setHeading: {
      description:
        "Replace a HEADING's level and inline runs in place (same block id, position unchanged); rejects any " +
        "other block kind.",
      args: zodSchema(z.object({ blockId: z.string(), level: levelArg, inlines: inlinesSchema })),
      target: BODY,
      produces: (page, args) => {
        const a = args as { blockId: string; level: 1 | 2 | 3 | 4 | 5 | 6; inlines: RunArg[] };
        return replaceBody(page, "setHeading", a.blockId, "heading", (id) => heading(id, a.level, a.inlines));
      },
    },
    setList: {
      description:
        "Replace a LIST's `ordered` flag and items in place (same block id, position unchanged); rejects any " +
        "other block kind.",
      args: zodSchema(z.object({ blockId: z.string(), ordered: z.boolean(), items: z.array(inlinesSchema).min(1) })),
      target: BODY,
      produces: (page, args, ctx) => {
        const a = args as { blockId: string; ordered: boolean; items: RunArg[][] };
        return replaceBody(page, "setList", a.blockId, "list", (id) => list(id, a.ordered, a.items, ctx.newId));
      },
    },
    setQuote: {
      description:
        "Replace a QUOTE's paragraphs in place (same block id, position unchanged); rejects any other block kind.",
      args: zodSchema(z.object({ blockId: z.string(), paragraphs: z.array(inlinesSchema).min(1) })),
      target: BODY,
      produces: (page, args, ctx) => {
        const a = args as { blockId: string; paragraphs: RunArg[][] };
        return replaceBody(page, "setQuote", a.blockId, "quote", (id) => quote(id, a.paragraphs, ctx.newId));
      },
    },
    setTable: {
      description:
        "Replace a TABLE's header/rows/align in place (same block id, position unchanged); rejects any other " +
        "block kind.",
      args: zodSchema(
        z.object({
          blockId: z.string(),
          header: z.array(cellSchema).min(1),
          rows: z.array(z.array(cellSchema)),
          align: z.array(z.enum(["left", "center", "right"]).nullable()).optional(),
        }),
      ),
      target: BODY,
      produces: (page, args) => {
        const a = args as { blockId: string; header: RunArg[][]; rows: RunArg[][][]; align?: TableAlign };
        return replaceBody(page, "setTable", a.blockId, "table", (id) => table(id, a.header, a.rows, a.align));
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
