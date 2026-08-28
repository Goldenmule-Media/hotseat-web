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

import { getToken, notifyUnauthorized } from "./auth";
import type { SectionElementSummary } from "./live";
import { sliceH2Section } from "./restate";

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
export function groupIngredients<T extends { readonly group: string }>(
  ingredients: readonly T[],
): readonly { readonly group: string; readonly items: readonly T[] }[] {
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

// ── notes ────────────────────────────────────────────────────────────────────

export interface Note {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

export function readNotes(
  elements: readonly SectionElementSummary[],
  rendered: readonly { readonly id: string; readonly markdown: string }[],
): readonly Note[] {
  const bodies = new Map(rendered.map((r) => [r.id, stripHeading(r.markdown)]));
  return elements.map((el) => ({ id: el.id, title: el.title ?? "", body: bodies.get(el.id) ?? "" }));
}

// ── files ────────────────────────────────────────────────────────────────────

export interface RecipeFile {
  readonly ref: string;
  readonly label: string;
  /** A picture renders inline; anything else — the PDF the recipe was printed from — is a
   *  link, and that syntactic difference is the only signal the render carries. */
  readonly isImage: boolean;
}

/**
 * The attached files, read back out of the rendered page. `files` is a `blocks` field, not
 * a list, so there are no elements to summarize — the render is the only place the refs
 * exist in one piece.
 */
export function readFiles(pageMarkdown: string | null): readonly RecipeFile[] {
  const body = pageMarkdown === null ? null : sliceH2Section(pageMarkdown, "Files");
  if (body === null) return [];
  const out: RecipeFile[] = [];
  for (const m of body.matchAll(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g)) {
    out.push({ ref: m[3]!, label: m[2]! === "" ? m[3]! : m[2]!, isImage: m[1] === "!" });
  }
  return out;
}

// ── the chat's proposal, applied in memory ───────────────────────────────────

/** One edit the chat has proposed. The command name and args are the model's own, so
 *  applying is a mechanical translation and never a re-interpretation. */
export interface ProposedOp {
  readonly command: string;
  readonly args: Record<string, unknown>;
}

export type RowChange = "added" | "changed" | "removed";

export interface OverlayIngredient extends Ingredient {
  readonly change?: RowChange;
}

export interface OverlayStep extends Step {
  readonly change?: RowChange;
}

export interface Overlay {
  readonly ingredients: readonly OverlayIngredient[];
  readonly steps: readonly OverlayStep[];
  /** Ops that name a row this recipe no longer has — shown, never silently dropped. */
  readonly unapplied: readonly ProposedOp[];
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;

/**
 * The proposal applied to a COPY of the recipe — what the panes draw while a change is
 * being considered. Nothing here touches the engine; `applyProposal` is the same list of
 * ops replayed as real mutations once the human says so.
 *
 * A proposed row gets a synthetic `proposed:<n>` id. That id never reaches the engine: an
 * `addIngredient` op carries no id at all, and applying it mints a real one.
 */
export function applyOverlay(
  ingredients: readonly Ingredient[],
  steps: readonly Step[],
  ops: readonly ProposedOp[],
): Overlay {
  const nextIngredients: OverlayIngredient[] = [...ingredients];
  const nextSteps: OverlayStep[] = [...steps];
  const unapplied: ProposedOp[] = [];
  let minted = 0;

  const findBy = <T extends { id: string }>(rows: readonly T[], id: string | undefined): number =>
    id === undefined ? -1 : rows.findIndex((r) => r.id === id);

  for (const op of ops) {
    const a = op.args;
    switch (op.command) {
      case "addIngredient":
        nextIngredients.push({
          id: `proposed:${(minted += 1)}`,
          name: str(a.title) ?? "",
          qty: str(a.qty) ?? "",
          unit: str(a.unit) ?? "",
          prep: str(a.prep) ?? "",
          group: str(a.group) ?? "",
          shopAs: str(a.shopAs) ?? "",
          note: "",
          stepId: "",
          change: "added",
        });
        break;
      case "reviseIngredient": {
        const at = findBy(nextIngredients, str(a.ingredientId));
        if (at === -1) {
          unapplied.push(op);
          break;
        }
        const row = nextIngredients[at]!;
        nextIngredients[at] = {
          ...row,
          ...(a.title !== undefined ? { name: str(a.title) ?? "" } : {}),
          ...(a.qty !== undefined ? { qty: str(a.qty) ?? "" } : {}),
          ...(a.unit !== undefined ? { unit: str(a.unit) ?? "" } : {}),
          ...(a.prep !== undefined ? { prep: str(a.prep) ?? "" } : {}),
          ...(a.group !== undefined ? { group: str(a.group) ?? "" } : {}),
          change: row.change ?? "changed",
        };
        break;
      }
      case "removeIngredient": {
        const at = findBy(nextIngredients, str(a.ingredientId));
        if (at === -1) unapplied.push(op);
        else nextIngredients[at] = { ...nextIngredients[at]!, change: "removed" };
        break;
      }
      case "addStep":
        nextSteps.push({
          id: `proposed:${(minted += 1)}`,
          title: str(a.title) ?? "",
          group: str(a.group) ?? "",
          body: str(a.markdown) ?? "",
          change: "added",
        });
        break;
      case "reviseStep": {
        const at = findBy(nextSteps, str(a.stepId));
        if (at === -1) {
          unapplied.push(op);
          break;
        }
        const row = nextSteps[at]!;
        nextSteps[at] = {
          ...row,
          ...(a.title !== undefined ? { title: str(a.title) ?? "" } : {}),
          ...(a.markdown !== undefined ? { body: str(a.markdown) ?? "" } : {}),
          change: row.change ?? "changed",
        };
        break;
      }
      case "removeStep": {
        const at = findBy(nextSteps, str(a.stepId));
        if (at === -1) unapplied.push(op);
        else nextSteps[at] = { ...nextSteps[at]!, change: "removed" };
        break;
      }
      case "addNote":
        // A note changes neither pane, so it shows only in the chat's own summary.
        break;
      default:
        unapplied.push(op);
    }
  }
  return { ingredients: nextIngredients, steps: nextSteps, unapplied };
}

/** One line per op, for the "here is what this would do" list above Apply. */
export function describeOp(op: ProposedOp, ingredients: readonly Ingredient[], steps: readonly Step[]): string {
  const a = op.args;
  const nameOf = (id: string | undefined): string =>
    ingredients.find((i) => i.id === id)?.name ?? steps.find((s) => s.id === id)?.title ?? "it";
  const measure = [str(a.qty), str(a.unit)].filter((p) => p !== undefined && p !== "").join(" ");
  switch (op.command) {
    case "addIngredient":
      return `Add ${[measure, str(a.title)].filter((p) => p !== undefined && p !== "").join(" ")}`;
    case "reviseIngredient":
      return `Change ${nameOf(str(a.ingredientId))}${measure === "" ? "" : ` to ${measure}`}`;
    case "removeIngredient":
      return `Remove ${nameOf(str(a.ingredientId))}`;
    case "addStep":
      return `Add a step: ${str(a.title) ?? ""}`;
    case "reviseStep":
      return `Rewrite step: ${nameOf(str(a.stepId))}`;
    case "removeStep":
      return `Remove step: ${nameOf(str(a.stepId))}`;
    case "addNote":
      return `Add a note: ${str(a.title) ?? ""}`;
    default:
      return op.command;
  }
}

/**
 * The proposal as real mutations, in order. Adds come first among their own kind so a later
 * op can never reference a row that has not been created; ops naming a row that has since
 * disappeared are skipped rather than failing the batch, which is the same thing the
 * overlay showed as unapplied.
 */
export async function applyProposal(
  ops: readonly ProposedOp[],
  run: (command: string, args: Record<string, unknown>) => Promise<boolean>,
): Promise<{ applied: number; failed: number }> {
  let applied = 0;
  let failed = 0;
  for (const op of ops) {
    const ok = await run(op.command, op.args);
    if (ok) applied += 1;
    else failed += 1;
  }
  return { applied, failed };
}

// ── /api/recipe fetch wrappers (same-origin; bearer attached; 401 → sign-out) ──

function recipeHeaders(json: boolean): Headers {
  const headers = new Headers();
  const token = getToken();
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  if (json) headers.set("content-type", "application/json");
  return headers;
}

function sawUnauthorized(res: Response): boolean {
  if (res.status !== 401) return false;
  notifyUnauthorized();
  return true;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface ChatAnswer {
  readonly reply: string;
  readonly proposal: readonly ProposedOp[];
}

/** One earlier exchange. The server keeps no conversation state, so the studio carries the
 *  history and sends it back; the server assigns the roles. */
export interface ChatTurn {
  readonly question: string;
  readonly reply: string;
  readonly proposal: readonly ProposedOp[];
}

export type ChatResult = { ok: true; answer: ChatAnswer } | { ok: false; message: string };

/** POST /api/recipe/chat. One JSON answer, nothing streamed. Never throws. */
export async function askRecipeChat(req: {
  title: string;
  ingredients: readonly Ingredient[];
  steps: readonly Step[];
  question: string;
  history?: readonly ChatTurn[];
  signal?: AbortSignal;
}): Promise<ChatResult> {
  let res: Response;
  try {
    res = await fetch("/api/recipe/chat", {
      method: "POST",
      headers: recipeHeaders(true),
      body: JSON.stringify({
        recipe: {
          title: req.title,
          ingredients: req.ingredients.map((i) => ({
            id: i.id,
            name: i.name,
            qty: i.qty,
            unit: i.unit,
            prep: i.prep,
            group: i.group,
          })),
          steps: req.steps.map((s) => ({ id: s.id, title: s.title, group: s.group, body: s.body })),
        },
        question: req.question,
        history: req.history ?? [],
      }),
      signal: req.signal,
    });
  } catch (e) {
    return { ok: false, message: req.signal?.aborted === true ? "cancelled" : errText(e) };
  }
  if (sawUnauthorized(res)) return { ok: false, message: "signed out (the chat route returned 401)" };
  if (!res.ok) {
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") return { ok: false, message: body.error };
    } catch {
      // non-JSON error body — fall through to the status message
    }
    return { ok: false, message: `the recipe chat failed (HTTP ${res.status})` };
  }
  try {
    const body = (await res.json()) as { reply?: unknown; proposal?: unknown };
    if (typeof body.reply !== "string") return { ok: false, message: "the recipe chat replied with no answer" };
    return {
      ok: true,
      answer: {
        reply: body.reply,
        proposal: Array.isArray(body.proposal) ? (body.proposal as ProposedOp[]) : [],
      },
    };
  } catch (e) {
    return { ok: false, message: errText(e) };
  }
}
