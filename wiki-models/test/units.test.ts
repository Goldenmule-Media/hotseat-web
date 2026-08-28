import { describe, expect, it } from "vitest";

import {
  canonicalUnit,
  combine,
  convert,
  formatMeasure,
  formatQuantity,
  parseQuantity,
  parseRange,
  toGrams,
  toggleTarget,
} from "../src/shared/units";

describe("canonicalUnit", () => {
  it("keeps the single-letter spellings case-sensitive", () => {
    // The one convention a case-insensitive lookup gets wrong by a factor of three.
    expect(canonicalUnit("T")?.token).toBe("tbsp");
    expect(canonicalUnit("t")?.token).toBe("tsp");
  });

  it("reads both cases of C as a cup", () => {
    expect(canonicalUnit("C")?.token).toBe("cup");
    expect(canonicalUnit("c")?.token).toBe("cup");
  });

  it("folds plurals, long forms and trailing periods", () => {
    for (const raw of ["tbsp", "Tbsp", "tablespoon", "tablespoons", "tbs", "tbsp."]) {
      expect(canonicalUnit(raw)?.token).toBe("tbsp");
    }
    expect(canonicalUnit("GRAMS")?.token).toBe("g");
    expect(canonicalUnit("pounds")?.token).toBe("lb");
  });

  it("reads an absent unit as a bare count", () => {
    expect(canonicalUnit("")?.token).toBe("each");
  });

  it("is null for a word it does not know", () => {
    expect(canonicalUnit("smidgen")).toBeNull();
  });
});

describe("parseQuantity", () => {
  it("reads every encoding a recipe mixes", () => {
    expect(parseQuantity("3.5")).toBe(3.5);
    expect(parseQuantity(".25")).toBe(0.25);
    expect(parseQuantity("1/2")).toBe(0.5);
    expect(parseQuantity("1 1/4")).toBe(1.25);
    expect(parseQuantity("1 ½")).toBe(1.5);
    expect(parseQuantity("½")).toBe(0.5);
    expect(parseQuantity("640")).toBe(640);
  });

  it("reads a range as its low bound", () => {
    expect(parseQuantity("4 1/2 to 5")).toBe(4.5);
    expect(parseQuantity("8-12")).toBe(8);
    expect(parseRange("4 1/2 to 5")).toEqual({ low: 4.5, high: 5 });
    expect(parseRange("15 to 17")).toEqual({ low: 15, high: 17 });
  });

  it("is null for text that carries no number", () => {
    expect(parseQuantity("a dash")).toBeNull();
    expect(parseQuantity("")).toBeNull();
  });
});

describe("formatQuantity", () => {
  it("writes fractions the way a cook does", () => {
    expect(formatQuantity(0.5)).toBe("½");
    expect(formatQuantity(3.5)).toBe("3 ½");
    expect(formatQuantity(1.25)).toBe("1 ¼");
    expect(formatQuantity(2)).toBe("2");
  });

  it("keeps weights decimal", () => {
    expect(formatQuantity(112)).toBe("112");
    expect(formatQuantity(22.4)).toBe("22.4");
  });

  it("round-trips the encodings parseQuantity accepts", () => {
    for (const text of ["1/2", "1 1/4", "3.5"]) {
      const n = parseQuantity(text);
      expect(n).not.toBeNull();
      expect(parseQuantity(formatQuantity(n!))).toBeCloseTo(n!, 10);
    }
  });
});

describe("convert", () => {
  it("converts within a dimension without knowing the ingredient", () => {
    expect(convert({ qty: 16, unit: "oz" }, "g")?.qty).toBeCloseTo(453.59237, 5);
    expect(convert({ qty: 1, unit: "cup" }, "tbsp")?.qty).toBeCloseTo(16, 10);
    expect(convert({ qty: 3, unit: "tsp" }, "tbsp")?.qty).toBeCloseTo(1, 10);
  });

  it("crosses dimensions only with a bridged ingredient", () => {
    expect(convert({ qty: 1, unit: "cup" }, "g", "all purpose flour")?.qty).toBeCloseTo(120, 6);
    expect(convert({ qty: 1, unit: "cup" }, "g", "chopped walnuts")).toBeNull();
    expect(convert({ qty: 1, unit: "cup" }, "g")).toBeNull();
  });

  it("weighs a stick of butter", () => {
    expect(convert({ qty: 1, unit: "stick" }, "g", "unsalted butter")?.qty).toBeCloseTo(113, 6);
  });

  it("returns the measure unchanged when the unit already matches", () => {
    const m = { qty: 2, unit: "g" };
    expect(convert(m, "g")).toBe(m);
  });
});

describe("the salt bridge", () => {
  // Bread/Sourdough.md: "Double salt when using diamond." A teaspoon of Diamond Crystal
  // is less than half the salt of a teaspoon of table salt, which is the whole point.
  it("weighs a teaspoon differently per brand", () => {
    expect(toGrams({ qty: 8, unit: "tsp" }, "diamond salt")).toBeCloseTo(22.4, 6);
    expect(toGrams({ qty: 8, unit: "tsp" }, "Morton kosher salt")).toBeCloseTo(38.4, 6);
    expect(toGrams({ qty: 8, unit: "tsp" }, "table salt")).toBeCloseTo(48, 6);
  });

  it("prefers the brand over the bare word, whatever the case", () => {
    const diamond = toGrams({ qty: 1, unit: "tsp" }, "Diamond Crystal salt");
    const plain = toGrams({ qty: 1, unit: "tsp" }, "salt");
    expect(diamond).not.toBeCloseTo(plain!, 3);
  });
});

describe("combine", () => {
  it("adds counts — the divided-egg case", () => {
    // 3 eggs for the bread and 2 for the wash are one line on the shopping list.
    expect(combine({ qty: 3, unit: "each" }, { qty: 2, unit: "each" }, "egg")).toEqual({ qty: 5, unit: "each" });
  });

  it("adds within a dimension in the first measure's unit", () => {
    expect(combine({ qty: 1, unit: "cup" }, { qty: 8, unit: "tbsp" })?.qty).toBeCloseTo(1.5, 10);
    expect(combine({ qty: 1, unit: "cup" }, { qty: 8, unit: "tbsp" })?.unit).toBe("cup");
  });

  it("crosses dimensions in grams when the ingredient bridges", () => {
    const total = combine({ qty: 1, unit: "stick" }, { qty: 3, unit: "tbsp" }, "butter");
    expect(total?.unit).toBe("g");
    expect(total?.qty).toBeCloseTo(113 + 3 * 14.78676478125 * (227 / 236.5882365), 6);
  });

  it("refuses to invent a total it cannot justify", () => {
    expect(combine({ qty: 1, unit: "cup" }, { qty: 3, unit: "each" }, "chopped walnuts")).toBeNull();
    expect(combine({ qty: null, unit: "dash" }, { qty: 1, unit: "dash" }, "vanilla")).toBeNull();
  });
});

describe("presentation", () => {
  it("renders a measure the way the ingredient list reads", () => {
    expect(formatMeasure({ qty: 3.5, unit: "cup" })).toBe("3 ½ cup");
    expect(formatMeasure({ qty: 112, unit: "g" })).toBe("112 g");
    expect(formatMeasure({ qty: 2, unit: "each" })).toBe("2");
    expect(formatMeasure({ qty: null, unit: "dash" })).toBe("dash");
  });

  it("keeps an unknown unit as the author wrote it", () => {
    expect(formatMeasure({ qty: 1, unit: "smidgen" })).toBe("1 smidgen");
  });

  it("offers a toggle only where a conversion exists", () => {
    expect(toggleTarget({ qty: 1, unit: "cup" }, "all purpose flour")).toBe("g");
    expect(toggleTarget({ qty: 1, unit: "cup" }, "chopped walnuts")).toBeNull();
    expect(toggleTarget({ qty: 100, unit: "g" }, "anything")).toBe("oz");
  });
});
