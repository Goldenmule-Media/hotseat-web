/**
 * `recipe` page type. A recipe you cook from: ingredients, steps, the notes you accumulate
 * across attempts, and the PDF it came from.
 *
 * THE INGREDIENT LIST IS AUTHORED ONCE AND PROJECTED TWICE. A recipe's own structure keeps
 * a divided ingredient divided — 3 eggs for the bread and 2 for the egg wash are separate
 * rows, because the steps need them separately — while the shopping list has to say "5
 * eggs". Both are `derived` projections over the same list, so the two views can never
 * drift and neither is authored by hand. Quantities fold through `shared/units`, which is
 * also what lets `1 stick` of butter and `3 T` of butter add up.
 *
 * Grouping ("For the dough" / "Egg wash") is a free-text scalar on each ingredient, not an
 * element status: the engine's `groupBy` filters on element STATUS against a fixed,
 * model-declared `groups` list, which cannot express names a cook invents per recipe. The
 * ingredient projection groups them instead, in first-appearance order so the render stays
 * deterministic and the authored order survives ("combine the first four ingredients" is a
 * real instruction).
 *
 * PAIRING A STEP TO ITS INGREDIENTS is a `stepId` SCALAR, not a `ref`. Two reasons, both
 * structural: a ref's target must always resolve, so a pairing could never be cleared once
 * set; and the browser's `listSectionElements` surfaces only `title` plus scalars, so a
 * ref would be invisible to the studio that has to draw the pairing. A stale id degrades
 * to "unpaired", which is the honest failure.
 *
 * Nothing is `requiredIn` anything and every section is mutable in both statuses. A
 * half-transcribed recipe is still worth having, and `made` is a signal — I have actually
 * cooked this — not a seal.
 */
import type { DeepReadonly, DerivedItem, DerivedList, IBlock, IField, IItem, PageState, SectionOp } from "wiki/authoring";
import { definePageType, InvariantViolationError, parseBlocks, t, z, zodSchema } from "wiki/authoring";

import { listOf, scalarOf, titleOf } from "../shared/page-state";
import { canonicalUnit, combine, formatMeasure, parseQuantity, type Measure, UNIT_TOKENS } from "../shared/units";

const empty = z.object({});

/** Every section stays editable after `made`: cooking a recipe is when you learn what to
 *  change about it. */
const editable = ["untried", "made"] as const;

const INGREDIENTS = { section: "ingredients", field: "items" } as const;
const STEPS = { section: "steps", field: "items" } as const;
const NOTES = { section: "notes", field: "items" } as const;
const FILES = { section: "files", field: "attachments" } as const;

const ingredientsOf = (page: DeepReadonly<PageState>): readonly DeepReadonly<IItem>[] =>
  listOf(page, INGREDIENTS.section, INGREDIENTS.field);
const stepsOf = (page: DeepReadonly<PageState>): readonly DeepReadonly<IItem>[] => listOf(page, STEPS.section, STEPS.field);
const notesOf = (page: DeepReadonly<PageState>): readonly DeepReadonly<IItem>[] => listOf(page, NOTES.section, NOTES.field);

function elementAt(
  elements: readonly DeepReadonly<IItem>[],
  id: string,
  what: string,
): { index: number; el: DeepReadonly<IItem> } {
  const index = elements.findIndex((e) => e.id === id);
  if (index === -1) throw new InvariantViolationError(`${what} "${id}" not found on this page`);
  return { index, el: elements[index]! };
}

// ── measures ─────────────────────────────────────────────────────────────────

/** A quantity as authored — a number, or a written form like `1 1/4` that an agent may
 *  send — normalized to a number. Empty means unmeasured ("a dash"), which is not zero. */
function normalizeQty(raw: number | string | undefined): number | "" {
  if (raw === undefined) return "";
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : "";
  return parseQuantity(raw) ?? "";
}

/** A unit folded to its canonical token, or kept verbatim when the vocabulary does not
 *  know it — dropping a word the author chose would be worse than failing to convert it. */
function normalizeUnit(raw: string | undefined): string {
  if (raw === undefined) return "";
  const unit = canonicalUnit(raw);
  return unit === null ? raw.trim() : unit.token;
}

function measureOf(el: DeepReadonly<IItem>): Measure {
  const qty = scalarOf(el, "qty");
  const n = qty === "" ? null : Number(qty);
  return { qty: n !== null && Number.isFinite(n) ? n : null, unit: scalarOf(el, "unit") };
}

/** The shopping list's merge key: an explicit `shopAs` when the author set one (so "3 T
 *  butter, melted" and "1 stick butter" land together), else the name itself. */
function shopKey(el: DeepReadonly<IItem>): string {
  const override = scalarOf(el, "shopAs").trim();
  return (override === "" ? titleOf(el) : override).trim().toLowerCase();
}

// ── render projections ───────────────────────────────────────────────────────

/** One ingredient as a line: the measure, the name, then the prep and any note the author
 *  kept from the source. */
function ingredientText(el: DeepReadonly<IItem>): string {
  const measure = formatMeasure(measureOf(el));
  const prep = scalarOf(el, "prep").trim();
  const note = scalarOf(el, "note").trim();
  const head = measure === "" ? titleOf(el) : `${measure} ${titleOf(el)}`;
  return `${head}${prep === "" ? "" : `, ${prep}`}${note === "" ? "" : ` (${note})`}`;
}

const sourceRows: DerivedList = (page) => {
  const fields = page.sections.find((s) => s.key === "source")?.fields ?? {};
  const read = (key: string): string => {
    const f = fields[key];
    if (f === undefined) return "";
    if (f.kind === "scalar") return String(f.value).trim();
    return f.kind === "prose" ? f.value.trim() : "";
  };
  const rows: DerivedItem[] = [];
  const url = read("url");
  const attribution = read("attribution");
  const yields = read("yield");
  const time = read("time");
  if (url !== "") rows.push({ id: "url", text: `**Source:** ${url}` });
  if (attribution !== "") rows.push({ id: "attribution", text: `**From:** ${attribution}` });
  if (yields !== "") rows.push({ id: "yield", text: `**Makes:** ${yields}` });
  if (time !== "") rows.push({ id: "time", text: `**Time:** ${time}` });
  return rows;
};

/**
 * The ingredients as the recipe organizes them: a header per group in FIRST-APPEARANCE
 * order (never sorted — the authored order is load-bearing), then its ingredients indented
 * under it. Ungrouped ingredients render flat, with no header at all.
 */
const ingredientRows: DerivedList = (page) => {
  const elements = ingredientsOf(page);
  const groupOf = (el: DeepReadonly<IItem>): string => scalarOf(el, "group").trim();
  // Ungrouped ingredients are a bucket like any other, so a trailing garnish stays at the
  // end and a preamble stays at the front. Buckets appear in the order they first do.
  const groups: string[] = [];
  for (const el of elements) {
    const group = groupOf(el);
    if (!groups.includes(group)) groups.push(group);
  }
  const rows: DerivedItem[] = [];
  for (const group of groups) {
    if (group !== "") rows.push({ id: `group:${group}`, text: `**${group}**`, level: 0 });
    for (const el of elements) {
      if (groupOf(el) === group) rows.push({ id: el.id, text: ingredientText(el), level: group === "" ? 0 : 1 });
    }
  }
  return rows;
};

/**
 * Every measure of one ingredient added up, as far as they honestly add. Measures that do
 * not combine (a cup of something with no density, next to three of it) stay side by side
 * rather than being forced into a single wrong number.
 */
function totalText(measures: readonly Measure[], ingredient: string): string {
  const parts: Measure[] = [];
  for (const m of measures) {
    const at = parts.findIndex((p) => combine(p, m, ingredient) !== null);
    if (at === -1) parts.push(m);
    else parts[at] = combine(parts[at]!, m, ingredient)!;
  }
  return parts
    .map(formatMeasure)
    .filter((s) => s !== "")
    .join(" + ");
}

/**
 * The shopping list: one row per distinct ingredient, quantities summed across every row
 * that mentions it. This is the view that turns "3 eggs" for the bread and "2 eggs" for
 * the wash back into the five eggs you have to buy.
 */
const shoppingRows: DerivedList = (page) => {
  const order: string[] = [];
  // `label` is what the row reads as; `subject` is what the density bridge is looked up
  // by, and they are NOT the same thing. A row shopped as "salt" is still Diamond Crystal
  // in the pan, and weighing it as generic salt would more than double it.
  const buckets = new Map<string, { label: string; subject: string; measures: Measure[] }>();
  for (const el of ingredientsOf(page)) {
    const key = shopKey(el);
    if (key === "") continue;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      const override = scalarOf(el, "shopAs").trim();
      bucket = { label: override === "" ? titleOf(el) : override, subject: titleOf(el), measures: [] };
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.measures.push(measureOf(el));
  }
  return order.map((key): DerivedItem => {
    const bucket = buckets.get(key)!;
    const total = totalText(bucket.measures, bucket.subject);
    return { id: key, text: total === "" ? bucket.label : `${total} ${bucket.label}`, checked: false };
  });
};

// ── field builders ───────────────────────────────────────────────────────────

interface IngredientArgs {
  title?: string;
  qty?: number | string;
  unit?: string;
  prep?: string;
  group?: string;
  shopAs?: string;
  note?: string;
}

function ingredientFields(a: IngredientArgs & { title: string }): Record<string, IField> {
  return {
    title: { kind: "prose", value: a.title },
    qty: { kind: "scalar", value: normalizeQty(a.qty) },
    unit: { kind: "scalar", value: normalizeUnit(a.unit) },
    prep: { kind: "scalar", value: a.prep ?? "" },
    group: { kind: "scalar", value: a.group ?? "" },
    shopAs: { kind: "scalar", value: a.shopAs ?? "" },
    note: { kind: "scalar", value: a.note ?? "" },
    stepId: { kind: "scalar", value: "" },
  };
}

const setIngredientField = (id: string, elementField: string, value: string | number): SectionOp => ({
  op: "setElementField",
  ...INGREDIENTS,
  id,
  elementField,
  value: { kind: "scalar", value },
});

const ingredientArgs = {
  qty: z.union([z.number(), z.string()]).optional(),
  unit: z.string().optional(),
  prep: z.string().optional(),
  group: z.string().optional(),
  shopAs: z.string().optional(),
  note: z.string().optional(),
};

const UNIT_HELP = `Units are folded to a canonical token (${UNIT_TOKENS.join(", ")}); anything else is kept as written and simply will not convert.`;

// ── the type ─────────────────────────────────────────────────────────────────

export const Recipe = definePageType({
  type: "recipe",
  label: "Recipe",
  description:
    "A recipe you cook from: ingredients, steps, the notes you accumulate across attempts, and the file " +
    "it came from. Ingredients are authored ONCE, as structured rows, and projected twice — the ingredients " +
    "list keeps the recipe's own structure (3 eggs for the bread and 2 for the egg wash stay separate rows, " +
    "because the steps need them separately) while the shopping list sums them back into the five eggs you " +
    "have to buy. Never author a shopping list by hand; it is derived.\n\n" +
    "`group` is free text naming an ingredient's part of the recipe (\"Dough\", \"Egg wash\", \"Filling\"), and " +
    "grouping a step the same way pairs the two. `stepId` pairs one ingredient to one step precisely. " +
    "Ingredient ORDER is load-bearing — steps say things like \"combine the first four ingredients\" — so " +
    "reorder deliberately, never as a side effect.\n\n" +
    `${UNIT_HELP}\n\n` +
    "`made` records that you have actually cooked it. It is a signal, not a seal: everything stays editable, " +
    "and that is the point — a recipe is worth changing after you make it.",
  version: 1,
  initialStatus: "untried",
  statusTransitions: [
    t("untried", "made", "made", { agency: "human" }),
    t("made", "reopen", "untried", { agency: "human" }),
  ],
  sections: {
    source: {
      name: "Source",
      required: true,
      mutableIn: editable,
      fields: {
        url: { kind: "scalar" },
        attribution: { kind: "prose" },
        yield: { kind: "scalar" },
        time: { kind: "scalar" },
      },
    },
    files: {
      name: "Files",
      required: true,
      mutableIn: editable,
      fields: { attachments: { kind: "blocks" } },
    },
    ingredients: {
      name: "Ingredients",
      required: true,
      mutableIn: editable,
      fields: { items: { kind: "list", element: "ingredient", ordered: true } },
    },
    steps: {
      name: "Instructions",
      required: true,
      mutableIn: editable,
      fields: { items: { kind: "list", element: "step", ordered: true } },
    },
    notes: {
      name: "Notes",
      required: true,
      mutableIn: editable,
      fields: { items: { kind: "list", element: "note", ordered: true } },
    },
  },
  elements: {
    ingredient: {
      fields: {
        title: { kind: "prose", required: true },
        qty: { kind: "scalar" },
        unit: { kind: "scalar" },
        prep: { kind: "scalar" },
        group: { kind: "scalar" },
        shopAs: { kind: "scalar" },
        note: { kind: "scalar" },
        /** The `steps` element this ingredient belongs to — a scalar, not a ref; see the
         *  file header for why. `""` is unpaired. */
        stepId: { kind: "scalar" },
      },
    },
    step: {
      // A non-empty title is structural, not cosmetic: `as: "sections"` renders
      // `### {ordinal}. {heading}`, and an empty heading emits a bare `### 1. ` with
      // trailing whitespace, which the canonical Markdown contract forbids.
      fields: {
        title: { kind: "prose", required: true },
        body: { kind: "blocks", required: true },
        group: { kind: "scalar" },
      },
    },
    note: {
      fields: {
        title: { kind: "prose", required: true },
        body: { kind: "blocks", required: true },
      },
    },
  },
  sectionSet: { mode: "closed" },
  derived: {
    "source-rows": sourceRows,
    "ingredient-rows": ingredientRows,
    "shopping-rows": shoppingRows,
  },
  commands: {
    addIngredient: {
      description:
        "Add one ingredient. A DIVIDED ingredient is several rows, not one — \"5 eggs, divided\" is 3 eggs " +
        "in the dough and 2 in the wash, which is what lets the steps reference them separately; the " +
        "shopping list adds them back up. `group` names its part of the recipe. Appends unless `afterId` " +
        `names the ingredient to land after. ${UNIT_HELP}`,
      args: zodSchema(z.object({ title: z.string().min(1), ...ingredientArgs, afterId: z.string().optional() })),
      result: zodSchema(z.object({ ingredientId: z.string() })),
      target: INGREDIENTS,
      produces: (page, args, ctx) => {
        const a = args as IngredientArgs & { title: string; afterId?: string };
        const elements = ingredientsOf(page);
        const index = a.afterId === undefined ? elements.length : elementAt(elements, a.afterId, "ingredient").index + 1;
        return [
          {
            op: "addElement",
            ...INGREDIENTS,
            id: ctx.newId(),
            fields: ingredientFields({ ...a, title: a.title }),
            ...(index !== elements.length ? { index } : {}),
          },
        ];
      },
    },
    reviseIngredient: {
      description:
        "Change an ingredient. Only the fields you pass are written, so correcting a quantity leaves the " +
        `prep note alone. Pass an empty string to clear one. ${UNIT_HELP}`,
      args: zodSchema(z.object({ ingredientId: z.string(), title: z.string().min(1).optional(), ...ingredientArgs })),
      target: INGREDIENTS,
      produces: (page, args) => {
        const a = args as IngredientArgs & { ingredientId: string };
        elementAt(ingredientsOf(page), a.ingredientId, "ingredient");
        const ops: SectionOp[] = [];
        if (a.title !== undefined) {
          ops.push({
            op: "setElementField",
            ...INGREDIENTS,
            id: a.ingredientId,
            elementField: "title",
            value: { kind: "prose", value: a.title },
          });
        }
        if (a.qty !== undefined) ops.push(setIngredientField(a.ingredientId, "qty", normalizeQty(a.qty)));
        if (a.unit !== undefined) ops.push(setIngredientField(a.ingredientId, "unit", normalizeUnit(a.unit)));
        for (const key of ["prep", "group", "shopAs", "note"] as const) {
          const value = a[key];
          if (value !== undefined) ops.push(setIngredientField(a.ingredientId, key, value));
        }
        if (ops.length === 0) throw new InvariantViolationError("reviseIngredient needs at least one field to change");
        return ops;
      },
    },
    pairIngredient: {
      description:
        "Pair an ingredient with the step that uses it, so the two highlight together. Omit `stepId` to " +
        "clear the pairing. Coarse pairing — a whole group of ingredients to a phase of the method — is " +
        "better done by giving both the same `group`.",
      args: zodSchema(z.object({ ingredientId: z.string(), stepId: z.string().optional() })),
      target: INGREDIENTS,
      produces: (page, args) => {
        const a = args as { ingredientId: string; stepId?: string };
        elementAt(ingredientsOf(page), a.ingredientId, "ingredient");
        if (a.stepId !== undefined && a.stepId !== "") elementAt(stepsOf(page), a.stepId, "step");
        return [setIngredientField(a.ingredientId, "stepId", a.stepId ?? "")];
      },
    },
    moveIngredient: {
      description:
        "Reorder: move an ingredient to 0-based `toIndex`. Order is load-bearing — a step may say \"combine " +
        "the first four ingredients\" — so move deliberately.",
      args: zodSchema(z.object({ ingredientId: z.string(), toIndex: z.number().int().min(0) })),
      target: INGREDIENTS,
      produces: (page, args) => {
        const a = args as { ingredientId: string; toIndex: number };
        const elements = ingredientsOf(page);
        elementAt(elements, a.ingredientId, "ingredient");
        if (a.toIndex >= elements.length) {
          throw new InvariantViolationError(`toIndex ${a.toIndex} is past the last position (${elements.length - 1})`);
        }
        return [{ op: "moveElement", ...INGREDIENTS, id: a.ingredientId, toIndex: a.toIndex }];
      },
    },
    removeIngredient: {
      description: "Delete an ingredient outright.",
      args: zodSchema(z.object({ ingredientId: z.string() })),
      target: INGREDIENTS,
      produces: (page, args) => {
        const a = args as { ingredientId: string };
        elementAt(ingredientsOf(page), a.ingredientId, "ingredient");
        return [{ op: "removeElement", ...INGREDIENTS, id: a.ingredientId }];
      },
    },
    addStep: {
      description:
        "Add one step. `title` is its short imperative label (\"Knead and rest\") — it becomes the numbered " +
        "heading, so it must not be empty. `markdown` is the instruction itself, with amounts inline the " +
        "way a recipe reads. `group` names the phase, pairing it with the ingredients of the same group.",
      args: zodSchema(
        z.object({
          title: z.string().min(1),
          markdown: z.string(),
          group: z.string().optional(),
          afterId: z.string().optional(),
        }),
      ),
      result: zodSchema(z.object({ stepId: z.string() })),
      target: STEPS,
      produces: (page, args, ctx) => {
        const a = args as { title: string; markdown: string; group?: string; afterId?: string };
        const elements = stepsOf(page);
        const index = a.afterId === undefined ? elements.length : elementAt(elements, a.afterId, "step").index + 1;
        return [
          {
            op: "addElement",
            ...STEPS,
            id: ctx.newId(),
            fields: {
              title: { kind: "prose", value: a.title },
              body: { kind: "blocks", blocks: parseBlocks(a.markdown, ctx.newId) },
              group: { kind: "scalar", value: a.group ?? "" },
            },
            ...(index !== elements.length ? { index } : {}),
          },
        ];
      },
    },
    reviseStep: {
      description: "Rewrite a step's instruction, and optionally its label or phase.",
      args: zodSchema(
        z.object({
          stepId: z.string(),
          title: z.string().min(1).optional(),
          markdown: z.string(),
          group: z.string().optional(),
        }),
      ),
      target: STEPS,
      produces: (page, args, ctx) => {
        const a = args as { stepId: string; title?: string; markdown: string; group?: string };
        elementAt(stepsOf(page), a.stepId, "step");
        const ops: SectionOp[] = [
          {
            op: "setElementField",
            ...STEPS,
            id: a.stepId,
            elementField: "body",
            value: { kind: "blocks", blocks: parseBlocks(a.markdown, ctx.newId) },
          },
        ];
        if (a.title !== undefined) {
          ops.push({ op: "setElementField", ...STEPS, id: a.stepId, elementField: "title", value: { kind: "prose", value: a.title } });
        }
        if (a.group !== undefined) {
          ops.push({ op: "setElementField", ...STEPS, id: a.stepId, elementField: "group", value: { kind: "scalar", value: a.group } });
        }
        return ops;
      },
    },
    moveStep: {
      description: "Reorder: move a step to 0-based `toIndex`. The numbering follows.",
      args: zodSchema(z.object({ stepId: z.string(), toIndex: z.number().int().min(0) })),
      target: STEPS,
      produces: (page, args) => {
        const a = args as { stepId: string; toIndex: number };
        const elements = stepsOf(page);
        elementAt(elements, a.stepId, "step");
        if (a.toIndex >= elements.length) {
          throw new InvariantViolationError(`toIndex ${a.toIndex} is past the last position (${elements.length - 1})`);
        }
        return [{ op: "moveElement", ...STEPS, id: a.stepId, toIndex: a.toIndex }];
      },
    },
    removeStep: {
      description:
        "Delete a step. Every ingredient paired to it is unpaired in the same commit, so no ingredient is " +
        "left pointing at a step that is gone.",
      args: zodSchema(z.object({ stepId: z.string() })),
      target: STEPS,
      produces: (page, args) => {
        const a = args as { stepId: string };
        elementAt(stepsOf(page), a.stepId, "step");
        const ops: SectionOp[] = ingredientsOf(page)
          .filter((el) => scalarOf(el, "stepId") === a.stepId)
          .map((el) => setIngredientField(el.id, "stepId", ""));
        ops.push({ op: "removeElement", ...STEPS, id: a.stepId });
        return ops;
      },
    },
    addNote: {
      description:
        "Add a note to the stack — what you changed and how it turned out. `title` is its label, usually " +
        "the date you made it (\"12/29/24\") or which attempt it was. Newest notes go at the end unless " +
        "`afterId` says otherwise.",
      args: zodSchema(z.object({ title: z.string().min(1), markdown: z.string(), afterId: z.string().optional() })),
      result: zodSchema(z.object({ noteId: z.string() })),
      target: NOTES,
      produces: (page, args, ctx) => {
        const a = args as { title: string; markdown: string; afterId?: string };
        const elements = notesOf(page);
        const index = a.afterId === undefined ? elements.length : elementAt(elements, a.afterId, "note").index + 1;
        return [
          {
            op: "addElement",
            ...NOTES,
            id: ctx.newId(),
            fields: {
              title: { kind: "prose", value: a.title },
              body: { kind: "blocks", blocks: parseBlocks(a.markdown, ctx.newId) },
            },
            ...(index !== elements.length ? { index } : {}),
          },
        ];
      },
    },
    reviseNote: {
      description: "Rewrite a note, and optionally its label.",
      args: zodSchema(z.object({ noteId: z.string(), title: z.string().min(1).optional(), markdown: z.string() })),
      target: NOTES,
      produces: (page, args, ctx) => {
        const a = args as { noteId: string; title?: string; markdown: string };
        elementAt(notesOf(page), a.noteId, "note");
        const ops: SectionOp[] = [
          {
            op: "setElementField",
            ...NOTES,
            id: a.noteId,
            elementField: "body",
            value: { kind: "blocks", blocks: parseBlocks(a.markdown, ctx.newId) },
          },
        ];
        if (a.title !== undefined) {
          ops.push({ op: "setElementField", ...NOTES, id: a.noteId, elementField: "title", value: { kind: "prose", value: a.title } });
        }
        return ops;
      },
    },
    removeNote: {
      description: "Delete a note from the stack.",
      args: zodSchema(z.object({ noteId: z.string() })),
      target: NOTES,
      produces: (page, args) => {
        const a = args as { noteId: string };
        elementAt(notesOf(page), a.noteId, "note");
        return [{ op: "removeElement", ...NOTES, id: a.noteId }];
      },
    },
    attachFile: {
      description:
        "Attach the recipe's own file — the PDF it was printed from, or a photo of the page. `ref` is " +
        "`attachment:<sha256>` for bytes uploaded to this wiki's attachment store, or an ordinary URL. " +
        "Set `isImage` for a picture, which then renders inline; anything else becomes a link.",
      args: zodSchema(z.object({ ref: z.string().min(1), label: z.string().min(1), isImage: z.boolean().optional() })),
      target: FILES,
      produces: (_page, args, ctx) => {
        const a = args as { ref: string; label: string; isImage?: boolean };
        const markdown = a.isImage === true ? `![${a.label}](${a.ref})` : `[${a.label}](${a.ref})`;
        const blocks = parseBlocks(markdown, ctx.newId);
        return blocks.map((block: IBlock): SectionOp => ({ op: "addBlock", ...FILES, block }));
      },
    },
    made: {
      description: "Record that you have actually cooked this. A signal, not a seal — everything stays editable.",
      args: zodSchema(empty),
      transition: { level: "page", event: "made" },
    },
    reopen: {
      description: "Mark the recipe untried again.",
      args: zodSchema(empty),
      transition: { level: "page", event: "reopen" },
    },
  },
  render: {
    title: "{title}",
    sections: [
      { derived: "source-rows", heading: "Source", placeholder: "_No source recorded._" },
      { derived: "ingredient-rows", heading: "Ingredients", placeholder: "_No ingredients yet._" },
      { derived: "shopping-rows", heading: "Shopping list", placeholder: "_Nothing to buy._" },
      {
        section: STEPS.section,
        heading: "Instructions",
        field: STEPS.field,
        as: "sections",
        numbered: true,
        placeholder: "_No steps yet._",
        element: { heading: "{title}", body: [{ field: "body" }] },
      },
      { section: FILES.section, heading: "Files", field: FILES.field, as: "blocks", placeholder: "_No files._" },
      {
        section: NOTES.section,
        heading: "Notes",
        field: NOTES.field,
        as: "sections",
        numbered: false,
        placeholder: "_No notes yet._",
        element: { heading: "{title}", body: [{ field: "body" }] },
      },
    ],
  },
});
