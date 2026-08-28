"use client";

/**
 * The `recipe` schema, as the Recipe Studio addresses it: section keys, command names, and
 * the readers that turn the engine's element summaries into rows the two panes can draw.
 * Mirrors lib/article-notes.ts and lib/study.ts — a studio is coupled to its page type by
 * these constants and nothing else in wiki-ui should name them.
 *
 * The shopping list is NOT read back out of the render: it is recomputed here from the same
 * ingredient rows, using the same `wiki-models/recipe` unit functions the model's derived
 * projection uses. Same inputs, same code, so the pane and the Markdown cannot disagree —
 * and the pane can then show a live total while a quantity is still being typed.
 */
import { combine, formatMeasure, type Measure } from "wiki-models/recipe";

import type { SectionElementSummary } from "./live";

export const RECIPE_PAGE_TYPE = "recipe";

export const INGREDIENTS_SECTION = "ingredients";
export const STEPS_SECTION = "steps";
export const NOTES_SECTION = "notes";
export const FILES_SECTION = "files";

/** One ingredient, as the left pane draws it. */
export interface Ingredient {
  readonly id: string;
  readonly name: string;
  readonly qty: string;
  readonly unit: string;
  readonly prep: string;
  readonly group: string;
  readonly shopAs: string;
  readonly note: string;
  readonly stepId: string;
}

function scalar(el: SectionElementSummary, key: string): string {
  const value = el.scalars?.[key];
  return value === undefined ? "" : String(value);
}

export function readIngredients(elements: readonly SectionElementSummary[]): readonly Ingredient[] {
  return elements.map((el) => ({
    id: el.id,
    name: el.title ?? "",
    qty: scalar(el, "qty"),
    unit: scalar(el, "unit"),
    prep: scalar(el, "prep"),
    group: scalar(el, "group"),
    shopAs: scalar(el, "shopAs"),
    note: scalar(el, "note"),
    stepId: scalar(el, "stepId"),
  }));
}

export interface Step {
  readonly id: string;
  readonly title: string;
  readonly group: string;
  /** The instruction body — the rendered element with its numbered heading stripped. */
  readonly body: string;
}

/**
 * `renderElement` presents a step exactly as the full render does, which for an
 * `as: "sections"` list means a `### 1. Title` heading above the body. The studio draws its
 * own numbering and its own title field, so the heading line comes back off here rather
 * than being re-parsed by every caller.
 */
export function stripHeading(markdown: string): string {
  return markdown.replace(/^#{1,6} .*\n*/, "").trim();
}

export function readSteps(
  elements: readonly SectionElementSummary[],
  rendered: readonly { readonly id: string; readonly markdown: string }[],
): readonly Step[] {
  const bodies = new Map(rendered.map((r) => [r.id, stripHeading(r.markdown)]));
  return elements.map((el) => ({
    id: el.id,
    title: el.title ?? "",
    group: scalar(el, "group"),
    body: bodies.get(el.id) ?? "",
  }));
}

/** An ingredient's quantity + unit as the units module understands it. */
export function measureOf(ingredient: Ingredient): Measure {
  const n = ingredient.qty.trim() === "" ? null : Number(ingredient.qty);
  return { qty: n !== null && Number.isFinite(n) ? n : null, unit: ingredient.unit };
}

/** Ingredients bucketed by `group`, buckets in first-appearance order — the same order the
 *  model's projection uses, so the pane and the Markdown agree. Ungrouped is a bucket too. */
export function groupIngredients(
  ingredients: readonly Ingredient[],
): readonly { readonly group: string; readonly items: readonly Ingredient[] }[] {
  const order: string[] = [];
  for (const item of ingredients) if (!order.includes(item.group)) order.push(item.group);
  return order.map((group) => ({ group, items: ingredients.filter((i) => i.group === group) }));
}

export interface ShoppingRow {
  readonly key: string;
  readonly label: string;
  readonly total: string;
  /** The ingredient rows this line adds up — the pane highlights them on hover. */
  readonly from: readonly string[];
}

/**
 * The shopping list: one row per distinct ingredient, quantities summed as far as they
 * honestly add. `label` is what the row reads as, but the density bridge is looked up by
 * the ingredient's own name — a row shopped as "salt" is still Diamond Crystal in the pan.
 */
export function shoppingList(ingredients: readonly Ingredient[]): readonly ShoppingRow[] {
  const order: string[] = [];
  const buckets = new Map<string, { label: string; subject: string; measures: Measure[]; from: string[] }>();
  for (const item of ingredients) {
    const override = item.shopAs.trim();
    const key = (override === "" ? item.name : override).trim().toLowerCase();
    if (key === "") continue;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { label: override === "" ? item.name : override, subject: item.name, measures: [], from: [] };
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.measures.push(measureOf(item));
    bucket.from.push(item.id);
  }
  return order.map((key) => {
    const bucket = buckets.get(key)!;
    return { key, label: bucket.label, total: totalOf(bucket.measures, bucket.subject), from: bucket.from };
  });
}

/** Measures that will not combine stay side by side rather than being forced into a single
 *  wrong number. */
function totalOf(measures: readonly Measure[], subject: string): string {
  const parts: Measure[] = [];
  for (const m of measures) {
    const at = parts.findIndex((p) => combine(p, m, subject) !== null);
    if (at === -1) parts.push(m);
    else parts[at] = combine(parts[at]!, m, subject)!;
  }
  return parts
    .map(formatMeasure)
    .filter((s) => s !== "")
    .join(" + ");
}

/**
 * Which ingredients pair with a step: the ones explicitly paired to it, else — when none
 * are — everything sharing its `group`. The precise pairing wins wherever it exists, so a
 * recipe can start with coarse groups and be sharpened one ingredient at a time.
 */
export function ingredientsForStep(ingredients: readonly Ingredient[], step: Step): readonly string[] {
  const paired = ingredients.filter((i) => i.stepId === step.id).map((i) => i.id);
  if (paired.length > 0) return paired;
  if (step.group.trim() === "") return [];
  return ingredients.filter((i) => i.group === step.group).map((i) => i.id);
}

/** A step's title when the author has not written one: the first clause of the instruction,
 *  so a prose recipe stays one field to author. */
export function titleFromBody(markdown: string): string {
  const first = markdown.trim().split("\n")[0] ?? "";
  const clause = first.split(/(?<=[.;:])\s/)[0] ?? first;
  const trimmed = clause.replace(/[.;:]$/, "").trim();
  if (trimmed === "") return "Step";
  return trimmed.length > 60 ? `${trimmed.slice(0, 57).trimEnd()}…` : trimmed;
}
