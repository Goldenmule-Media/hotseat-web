/**
 * `feature-spec` page type — the question-free DECIDED
 * source of truth, authored FROM the brief's resolved questions. The brief stays the
 * deliberation record (its Q&A is the trail); the spec is the clean, current design:
 * flowing prose + data-model code blocks + inline `ref`s back to the decisions they
 * settle. It is a required child of `feature-brief`, materialized empty at creation.
 *
 * Lifecycle: `drafting → seal → sealed` (reopen back to drafting). Sealing is an
 * explicit ceremony gated by REFERENCE-COMPLETENESS: the spec must contain an inline
 * `ref` to EVERY resolved question on the brief. The engine checks this structurally
 * (walk the spec's blocks, collect element-ref targets pointing at the brief's
 * questions, diff against the brief's resolved-question set), so "no decision was
 * silently dropped" is enforced over structure — not asserted. It cannot verify the
 * prose is correct, only that every decision is threaded in.
 */
import type {
  BlockId,
  DeepReadonly,
  IBlock,
  IInline,
  PageId,
  PageState,
  Precondition,
  RefTarget,
  SectionId,
} from "wiki/authoring";
import { arg, definePageType, parseInline, t } from "wiki/authoring";
import { z, zodSchema } from "wiki/authoring";

const empty = z.object({});

// ────────────────────────────────────────────────────────────────────────────
// Reference-completeness gate (reads the parent brief via `related`)
// ────────────────────────────────────────────────────────────────────────────

/** The brief's RESOLVED question ids (the decisions that must be threaded in). */
function resolvedQuestionIds(brief: DeepReadonly<PageState> | undefined): Set<string> {
  const out = new Set<string>();
  const f = brief?.sections.find((s) => s.key === "questions")?.fields["items"];
  if (f !== undefined && f.kind === "list") {
    for (const el of f.elements) if (el.status === "resolved") out.add(el.id);
  }
  return out;
}

/** Every brief-question id referenced by an inline element-`ref` anywhere in the spec. */
function referencedQuestionIds(page: DeepReadonly<PageState>, briefId: string | null): Set<string> {
  const out = new Set<string>();
  const visitInlines = (inlines: readonly DeepReadonly<IInline>[]): void => {
    for (const run of inlines) {
      if (
        run.kind === "ref" &&
        run.target.kind === "element" &&
        (run.target.page as unknown as string | undefined) === (briefId ?? undefined)
      ) {
        out.add(run.target.element);
      }
    }
  };
  const visitBlocks = (blocks: readonly DeepReadonly<IBlock>[]): void => {
    for (const b of blocks) {
      if (b.kind === "paragraph" || b.kind === "heading") visitInlines(b.inlines);
      else if (b.kind === "quote") visitBlocks(b.blocks);
      else if (b.kind === "list") for (const item of b.items) visitBlocks(item);
      else if (b.kind === "table") {
        for (const cell of b.header) visitInlines(cell);
        for (const row of b.rows) for (const cell of row) visitInlines(cell);
      }
    }
  };
  for (const sec of page.sections) {
    for (const f of Object.values(sec.fields)) if (f.kind === "blocks") visitBlocks(f.blocks);
  }
  return out;
}

/** The seal gate: every resolved decision on the brief must be referenced by the spec. */
const everyDecisionReferenced: Precondition = (page, related) => {
  const briefId = page.parentId as unknown as PageId | null;
  const brief = briefId !== null ? related.page(briefId) : undefined;
  const resolved = resolvedQuestionIds(brief);
  const referenced = referencedQuestionIds(page, briefId as unknown as string | null);
  const missing = [...resolved].filter((id) => !referenced.has(id));
  if (missing.length === 0) return true;
  return {
    unmet: `the spec must reference every resolved decision; ${missing.length} unreferenced (e.g. "${missing[0]}")`,
  };
};

// ────────────────────────────────────────────────────────────────────────────

export const FeatureSpec = definePageType({
  type: "feature-spec",
  label: "Spec",
  description:
    "The detailed product/UX specification for a feature. Auto-created as a child of a `feature-brief` — you " +
    "do not create one directly; author into the one the brief materializes.",
  version: 1,
  initialStatus: "drafting",
  // seal carries no `agency` — driven by the brief's `ship` cascade, not the agent (its
  // everyDecisionReferenced gate passes vacuously on an empty spec, so surfacing it would
  // invite sealing a spec with no design content).
  statusTransitions: [t("drafting", "seal", "sealed"), t("sealed", "reopen", "drafting")],
  finalize: "seal",
  sections: {
    overview: {
      name: "Overview",
      required: true,
      mutableIn: ["drafting"],
      fields: { body: { kind: "prose" } },
    },
    design: {
      name: "Design",
      required: true,
      mutableIn: ["drafting"],
      fields: { body: { kind: "blocks" } },
    },
    decisions: {
      name: "Decisions",
      required: true,
      mutableIn: ["drafting"],
      fields: { body: { kind: "blocks" } },
    },
  },
  sectionSet: { mode: "closed" },
  commands: {
    setOverview: {
      args: zodSchema(z.object({ text: z.string() })),
      target: { section: "overview", field: "body" },
      set: { body: arg("text") },
    },
    // ── narrative authoring on `design` (the first model to author prose blocks) ──
    addParagraph: {
      args: zodSchema(z.object({ text: z.string() })),
      result: zodSchema(z.object({ blockId: z.string() })),
      target: { section: "design", field: "body" },
      produces: (_page, args, ctx) => {
        const a = args as { text: string };
        const id = ctx.newId() as BlockId;
        const block: IBlock = { kind: "paragraph", id, inlines: parseInline(a.text) };
        return [{ op: "addBlock", section: "design", field: "body", block }];
      },
    },
    addHeading: {
      args: zodSchema(z.object({ level: z.number().int().min(1).max(6), text: z.string() })),
      result: zodSchema(z.object({ blockId: z.string() })),
      target: { section: "design", field: "body" },
      produces: (_page, args, ctx) => {
        const a = args as { level: 1 | 2 | 3 | 4 | 5 | 6; text: string };
        const id = ctx.newId() as BlockId;
        const block: IBlock = { kind: "heading", id, level: a.level, inlines: parseInline(a.text) };
        return [{ op: "addBlock", section: "design", field: "body", block }];
      },
    },
    addDesignCode: {
      args: zodSchema(z.object({ language: z.string(), source: z.string() })),
      result: zodSchema(z.object({ blockId: z.string() })),
      target: { section: "design", field: "body" },
      produces: (_page, args, ctx) => {
        const a = args as { language: string; source: string };
        const id = ctx.newId() as BlockId;
        // hash is normalized/recomputed during ingestion (mirrors implementation-plan addDataModel).
        const block: IBlock = { kind: "code", id, lang: a.language, source: a.source, hash: "" };
        return [{ op: "addBlock", section: "design", field: "body", block }];
      },
    },
    removeDesignBlock: {
      args: zodSchema(z.object({ blockId: z.string() })),
      target: { section: "design", field: "body" },
      produces: (_page, args) => [
        { op: "removeBlock", section: "design", field: "body", block: (args as { blockId: string }).blockId as BlockId },
      ],
    },
    // ── the load-bearing command: thread a decision in with an inline ref to its question ──
    addDecision: {
      description:
        "Record a design decision and link it to the brief question it addresses. `questionId` MUST be the " +
        "ELEMENT ID of an existing question on the parent feature-brief (mint it via the brief's askQuestion, " +
        "or read it from the brief's questions list) — NOT a slug, title, or free text. The id need only " +
        "EXIST (it may still be open; this does not change the question's status); an id that resolves to no " +
        "question element aborts the whole batch with a ref-integrity error.",
      args: zodSchema(z.object({ questionId: z.string(), text: z.string() })),
      result: zodSchema(z.object({ blockId: z.string() })),
      target: { section: "decisions", field: "body" },
      produces: (page, args, ctx) => {
        const a = args as { questionId: string; text: string };
        const briefId = page.parentId as unknown as PageId | null;
        const brief = briefId !== null ? ctx.related.page(briefId) : undefined;
        const questionsSec = brief?.sections.find((s) => s.key === "questions");
        const id = ctx.newId() as BlockId;
        const inlines: IInline[] = parseInline(`${a.text} `);
        // Thread in a live, integrity-checked ref to the decided question. (If the brief
        // or its questions section is somehow absent, fall back to a plain paragraph
        // rather than emit a dangling ref the engine would reject.)
        if (briefId !== null && questionsSec !== undefined) {
          const target: RefTarget = {
            kind: "element",
            page: briefId,
            section: questionsSec.id as unknown as SectionId,
            field: "items",
            element: a.questionId,
            labelField: "text",
          };
          inlines.push({ kind: "ref", target });
        }
        const block: IBlock = { kind: "paragraph", id, inlines };
        return [{ op: "addBlock", section: "decisions", field: "body", block }];
      },
    },
    removeDecision: {
      args: zodSchema(z.object({ blockId: z.string() })),
      target: { section: "decisions", field: "body" },
      produces: (_page, args) => [
        { op: "removeBlock", section: "decisions", field: "body", block: (args as { blockId: string }).blockId as BlockId },
      ],
    },
    // ── lifecycle ──
    seal: {
      args: zodSchema(empty),
      transition: { level: "page", event: "seal" },
      preconditions: [everyDecisionReferenced],
    },
    reopen: { args: zodSchema(empty), transition: { level: "page", event: "reopen" } },
  },
  render: {
    title: "{title}",
    sections: [
      { section: "overview", heading: "Overview", field: "body", as: "block", placeholder: "_No overview yet._" },
      { section: "design", heading: "Design", field: "body", as: "blocks", placeholder: "_No design yet._" },
      { section: "decisions", heading: "Decisions", field: "body", as: "blocks", placeholder: "_No decisions recorded yet._" },
    ],
  },
});
