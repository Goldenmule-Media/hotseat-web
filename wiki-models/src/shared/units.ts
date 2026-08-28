/**
 * Cooking measurements: a canonical unit vocabulary, quantity parsing/formatting, and the
 * conversions a recipe actually needs. Two kinds of conversion live here, and the second
 * is the interesting one:
 *
 *  - DIMENSIONAL — oz↔g, tbsp↔cup. Pure arithmetic on a unit table, ingredient-independent.
 *  - BRIDGED — cup→g, "stick of butter"→g, and the salt case (a teaspoon of Diamond Crystal
 *    and a teaspoon of table salt are not the same amount of salt). These need to know WHAT
 *    is being measured, so each entry in {@link BRIDGES} supplies a density and/or the mass
 *    of its count units. Without a bridge, a cross-dimension conversion honestly fails
 *    rather than guessing.
 *
 * Pure and deterministic — no clock, no RNG, no locale-dependent collation — because the
 * recipe model's derived projections call it during `render`. The wiki-ui studio calls the
 * same functions for its unit toggles, so a converted quantity reads identically in the
 * browser and in the rendered Markdown.
 *
 * Deliberately NOT a bundle (no `index.ts` in this directory): the server's `--models-dir`
 * discovery would try to load one as a page-type array. wiki-ui reaches these through
 * `wiki-models/recipe`, which re-exports them.
 */

export type Dimension = "mass" | "volume" | "count";

export interface Unit {
  /** The canonical token stored in an ingredient's `unit` scalar. */
  readonly token: string;
  readonly dimension: Dimension;
  /** Multiplier into the dimension's base: grams, millilitres, or 1 for a count. */
  readonly toBase: number;
  /** Display form, singular. */
  readonly label: string;
}

/** A quantity paired with a unit token. `qty === null` is an unmeasured ingredient
 *  ("a dash of vanilla") — it carries a unit at most, and never combines numerically. */
export interface Measure {
  readonly qty: number | null;
  readonly unit: string;
}

const UNITS: readonly Unit[] = [
  { token: "g", dimension: "mass", toBase: 1, label: "g" },
  { token: "kg", dimension: "mass", toBase: 1000, label: "kg" },
  { token: "oz", dimension: "mass", toBase: 28.349523125, label: "oz" },
  { token: "lb", dimension: "mass", toBase: 453.59237, label: "lb" },

  { token: "ml", dimension: "volume", toBase: 1, label: "ml" },
  { token: "l", dimension: "volume", toBase: 1000, label: "l" },
  { token: "tsp", dimension: "volume", toBase: 4.92892159375, label: "tsp" },
  { token: "tbsp", dimension: "volume", toBase: 14.78676478125, label: "tbsp" },
  { token: "floz", dimension: "volume", toBase: 29.5735295625, label: "fl oz" },
  { token: "cup", dimension: "volume", toBase: 236.5882365, label: "cup" },
  { token: "pt", dimension: "volume", toBase: 473.176473, label: "pint" },
  { token: "qt", dimension: "volume", toBase: 946.352946, label: "quart" },
  { token: "gal", dimension: "volume", toBase: 3785.411784, label: "gallon" },

  { token: "each", dimension: "count", toBase: 1, label: "" },
  { token: "stick", dimension: "count", toBase: 1, label: "stick" },
  { token: "clove", dimension: "count", toBase: 1, label: "clove" },
  { token: "can", dimension: "count", toBase: 1, label: "can" },
  { token: "package", dimension: "count", toBase: 1, label: "package" },
  { token: "pinch", dimension: "count", toBase: 1, label: "pinch" },
  { token: "dash", dimension: "count", toBase: 1, label: "dash" },
];

const BY_TOKEN = new Map(UNITS.map((u) => [u.token, u]));

/** Every unit an ingredient's `unit` scalar may hold — the studio's dropdown, and what
 *  `describePageType` advertises to an agent. */
export const UNIT_TOKENS: readonly string[] = UNITS.map((u) => u.token);

/**
 * Single-letter spellings are CASE-SENSITIVE and collide across dimensions: `T` is a
 * tablespoon and `t` a teaspoon, the one recipe convention that a case-insensitive lookup
 * would silently get wrong (by a factor of three). Resolved before {@link ALIASES}.
 */
const CASED_ALIASES: Readonly<Record<string, string>> = {
  T: "tbsp",
  t: "tsp",
  C: "cup",
  c: "cup",
};

const ALIASES: Readonly<Record<string, string>> = {
  gram: "g", grams: "g", gm: "g", gs: "g",
  kilogram: "kg", kilograms: "kg", kilo: "kg",
  ounce: "oz", ounces: "oz",
  pound: "lb", pounds: "lb", lbs: "lb",
  millilitre: "ml", milliliter: "ml", millilitres: "ml", milliliters: "ml",
  litre: "l", liter: "l", litres: "l", liters: "l",
  teaspoon: "tsp", teaspoons: "tsp", tsps: "tsp",
  tablespoon: "tbsp", tablespoons: "tbsp", tbsps: "tbsp", tbs: "tbsp", tblsp: "tbsp",
  "fluid ounce": "floz", "fluid ounces": "floz", "fl oz": "floz", floz: "floz",
  cup: "cup", cups: "cup",
  pint: "pt", pints: "pt", pts: "pt",
  quart: "qt", quarts: "qt", qts: "qt",
  gallon: "gal", gallons: "gal",
  sticks: "stick",
  cloves: "clove",
  cans: "can",
  packages: "package", packet: "package", packets: "package", pkg: "package",
  pinches: "pinch",
  dashes: "dash",
  whole: "each", ea: "each", "": "each",
};

/**
 * Resolve a written unit to its canonical entry. Returns `null` for anything not in the
 * vocabulary — the caller keeps the author's own text rather than dropping it.
 */
export function canonicalUnit(raw: string): Unit | null {
  const trimmed = raw.trim();
  const cased = CASED_ALIASES[trimmed];
  if (cased !== undefined) return BY_TOKEN.get(cased) ?? null;
  const key = trimmed.toLowerCase().replace(/\.$/, "");
  const direct = BY_TOKEN.get(key);
  if (direct !== undefined) return direct;
  const alias = ALIASES[key];
  return alias === undefined ? null : (BY_TOKEN.get(alias) ?? null);
}

// ── quantities ───────────────────────────────────────────────────────────────

/** Unicode vulgar fractions, which recipes use interchangeably with `1/2`. */
const VULGAR: Readonly<Record<string, number>> = {
  "¼": 0.25, "½": 0.5, "¾": 0.75,
  "⅓": 1 / 3, "⅔": 2 / 3,
  "⅕": 0.2, "⅖": 0.4, "⅗": 0.6, "⅘": 0.8,
  "⅙": 1 / 6, "⅚": 5 / 6,
  "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875,
};

function parseAtom(text: string): number | null {
  const t = text.trim();
  if (t === "") return null;
  const vulgar = VULGAR[t];
  if (vulgar !== undefined) return vulgar;
  const frac = /^(\d+)\s*\/\s*(\d+)$/.exec(t);
  if (frac !== null) {
    const denom = Number(frac[2]);
    return denom === 0 ? null : Number(frac[1]) / denom;
  }
  if (/^\d*\.?\d+$/.test(t)) return Number(t);
  return null;
}

/**
 * A written quantity as a number. Covers every encoding recipes mix freely: `3.5`, `.25`,
 * `1/2`, `1 1/4`, `1 ½`, `½`. A RANGE (`4 1/2 to 5`, `8-12`) reads as its LOW bound, which
 * is the amount you can commit to buying; {@link parseRange} exposes both.
 */
export function parseQuantity(text: string): number | null {
  const range = parseRange(text);
  return range === null ? null : range.low;
}

export function parseRange(text: string): { low: number; high: number } | null {
  const cleaned = text.trim().replace(/\s+/g, " ");
  if (cleaned === "") return null;
  const split = /\s+to\s+|\s*–\s*|\s*—\s*|(?<=[\d\s])-(?=\d)/.exec(cleaned);
  if (split !== null) {
    const low = parseCompound(cleaned.slice(0, split.index));
    const high = parseCompound(cleaned.slice(split.index + split[0].length));
    if (low !== null && high !== null) return { low, high };
  }
  const single = parseCompound(cleaned);
  return single === null ? null : { low: single, high: single };
}

/** `1 1/4` / `1 ½` / a bare atom — a whole part plus an optional fractional part. */
function parseCompound(text: string): number | null {
  const t = text.trim();
  if (t === "") return null;
  const whole = /^(\d+)\s*(?:\s|(?=[¼½¾⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]))(.+)$/.exec(t);
  if (whole !== null) {
    const rest = parseAtom(whole[2]!);
    if (rest !== null && rest < 1) return Number(whole[1]) + rest;
  }
  return parseAtom(t);
}

const FRACTIONS: readonly (readonly [number, string])[] = [
  [1 / 8, "⅛"], [1 / 6, "⅙"], [1 / 4, "¼"], [1 / 3, "⅓"], [3 / 8, "⅜"],
  [1 / 2, "½"], [5 / 8, "⅝"], [2 / 3, "⅔"], [3 / 4, "¾"], [5 / 6, "⅚"], [7 / 8, "⅞"],
];

/**
 * A number back to how a cook would write it: a vulgar fraction when it lands close enough
 * to a familiar one, otherwise a trimmed decimal. Weights stay decimal — nobody writes
 * `112½ g` — so anything at or above 50 rounds to a whole number.
 */
export function formatQuantity(n: number): string {
  if (!Number.isFinite(n)) return "";
  if (n >= 50) return String(Math.round(n));
  const whole = Math.floor(n);
  const rest = n - whole;
  if (rest > 1e-9) {
    for (const [value, glyph] of FRACTIONS) {
      if (Math.abs(rest - value) < 0.02) return whole === 0 ? glyph : `${whole} ${glyph}`;
    }
  } else {
    return String(whole);
  }
  return String(Math.round(n * 100) / 100);
}

// ── ingredient bridges ───────────────────────────────────────────────────────

/**
 * What a specific ingredient weighs, so volume and count can cross into mass.
 *
 * `match` is tested against the lowercased ingredient name, FIRST match winning — order
 * the table most-specific-first, since "diamond crystal salt" also contains "salt".
 */
export interface IngredientBridge {
  readonly match: RegExp;
  /** Density. Set it through {@link gPerCup} / {@link gPerTsp} rather than by hand. */
  readonly gPerMl?: number;
  /** What one of a COUNT unit weighs: `{ stick: 113 }`, `{ each: 50 }`. */
  readonly gPerUnit?: Readonly<Record<string, number>>;
}

const ML_PER_CUP = 236.5882365;
const ML_PER_TSP = 4.92892159375;

const gPerCup = (g: number): number => g / ML_PER_CUP;
const gPerTsp = (g: number): number => g / ML_PER_TSP;

/**
 * The measured weights that make cross-dimension conversion possible. The salt entries are
 * the reason this table exists: Diamond Crystal's flakes are so much less dense than table
 * salt that swapping brands teaspoon-for-teaspoon roughly doubles the salt in a recipe.
 */
export const BRIDGES: readonly IngredientBridge[] = [
  // Brand before the generic word: Morton also makes a "kosher salt", and it is nearly
  // twice the salt per teaspoon that Diamond Crystal's flakes are. A bare "kosher salt"
  // reads as Diamond, which is what recipes writing it unqualified almost always mean.
  { match: /morton/, gPerMl: gPerTsp(4.8) },
  { match: /diamond|kosher/, gPerMl: gPerTsp(2.8) },
  { match: /\bsalt\b/, gPerMl: gPerTsp(6.0) },

  { match: /bread flour/, gPerMl: gPerCup(120) },
  { match: /whole wheat flour/, gPerMl: gPerCup(113) },
  { match: /\bflour\b/, gPerMl: gPerCup(120) },
  { match: /brown sugar/, gPerMl: gPerCup(213) },
  { match: /powdered sugar|confectioner/, gPerMl: gPerCup(113) },
  { match: /\bsugar\b/, gPerMl: gPerCup(200) },
  { match: /cocoa/, gPerMl: gPerCup(85) },
  { match: /honey|molasses|treacle|syrup/, gPerMl: gPerCup(340) },
  { match: /\boil\b/, gPerMl: gPerCup(218) },
  { match: /butter/, gPerMl: gPerCup(227), gPerUnit: { stick: 113 } },
  { match: /\bmilk\b|buttermilk|cream/, gPerMl: gPerCup(240) },
  { match: /\bwater\b/, gPerMl: 1 },
  { match: /instant yeast|active dry yeast|\byeast\b/, gPerMl: gPerTsp(3.1), gPerUnit: { package: 7 } },
  { match: /\begg\b|\beggs\b/, gPerUnit: { each: 50 } },
];

export function bridgeFor(ingredient: string): IngredientBridge | null {
  const name = ingredient.trim().toLowerCase();
  if (name === "") return null;
  return BRIDGES.find((b) => b.match.test(name)) ?? null;
}

// ── conversion ───────────────────────────────────────────────────────────────

/** A measure in grams, or `null` when nothing bridges its dimension to mass. */
export function toGrams(m: Measure, ingredient?: string): number | null {
  if (m.qty === null) return null;
  const unit = canonicalUnit(m.unit);
  if (unit === null) return null;
  if (unit.dimension === "mass") return m.qty * unit.toBase;
  const bridge = ingredient === undefined ? null : bridgeFor(ingredient);
  if (bridge === null) return null;
  if (unit.dimension === "volume") {
    return bridge.gPerMl === undefined ? null : m.qty * unit.toBase * bridge.gPerMl;
  }
  const per = bridge.gPerUnit?.[unit.token];
  return per === undefined ? null : m.qty * per;
}

function fromGrams(grams: number, unit: Unit, ingredient?: string): number | null {
  if (unit.dimension === "mass") return grams / unit.toBase;
  const bridge = ingredient === undefined ? null : bridgeFor(ingredient);
  if (bridge === null) return null;
  if (unit.dimension === "volume") {
    return bridge.gPerMl === undefined ? null : grams / bridge.gPerMl / unit.toBase;
  }
  const per = bridge.gPerUnit?.[unit.token];
  return per === undefined ? null : grams / per;
}

/**
 * Restate a measure in `toUnit`. Same-dimension conversions need no ingredient; crossing
 * dimensions needs one with a {@link BRIDGES} entry. `null` when the conversion has no
 * honest answer — the caller shows the original.
 */
export function convert(m: Measure, toUnit: string, ingredient?: string): Measure | null {
  if (m.qty === null) return null;
  const from = canonicalUnit(m.unit);
  const to = canonicalUnit(toUnit);
  if (from === null || to === null) return null;
  if (from.token === to.token) return m;
  if (from.dimension === to.dimension) {
    return { qty: (m.qty * from.toBase) / to.toBase, unit: to.token };
  }
  const grams = toGrams(m, ingredient);
  if (grams === null) return null;
  const qty = fromGrams(grams, to, ingredient);
  return qty === null ? null : { qty, unit: to.token };
}

/**
 * Add two measures of the same ingredient — the shopping list's whole job. Same dimension
 * adds in the FIRST measure's unit; different dimensions add in grams via the bridge.
 * `null` when they cannot honestly be added, which is the signal to list them separately
 * rather than to invent a total.
 */
export function combine(a: Measure, b: Measure, ingredient?: string): Measure | null {
  if (a.qty === null || b.qty === null) return null;
  const ua = canonicalUnit(a.unit);
  const ub = canonicalUnit(b.unit);
  if (ua === null || ub === null) return null;
  if (ua.dimension === ub.dimension) {
    return { qty: a.qty + (b.qty * ub.toBase) / ua.toBase, unit: ua.token };
  }
  const ga = toGrams(a, ingredient);
  const gb = toGrams(b, ingredient);
  if (ga === null || gb === null) return null;
  return { qty: ga + gb, unit: "g" };
}

/**
 * A measure as a cook would read it: `3 ½ cup`, `112 g`, `2 eggs`. The `each` unit has no
 * label, so a bare count renders as just its number.
 */
export function formatMeasure(m: Measure): string {
  const unit = canonicalUnit(m.unit);
  const qty = m.qty === null ? "" : formatQuantity(m.qty);
  const label = unit === null ? m.unit.trim() : unit.label;
  if (label === "") return qty;
  if (qty === "") return label;
  return `${qty} ${label}`;
}

/** The unit a per-row toggle offers next: mass ⇄ the recipe's own unit. Volume and count
 *  rows only offer grams when the ingredient has a bridge, so the toggle never appears on
 *  a row it could not actually convert. */
export function toggleTarget(m: Measure, ingredient: string): string | null {
  const unit = canonicalUnit(m.unit);
  if (unit === null || m.qty === null) return null;
  if (unit.dimension === "mass") return unit.token === "g" ? "oz" : "g";
  return toGrams(m, ingredient) === null ? null : "g";
}
