import { describe, expect, it } from "vitest";
import { clampSplit, DEFAULT_SPLIT, loadSplit, saveSplit, SPLIT_KEY } from "./restate-split";
import type { KeyValueStore } from "./restate";

function memoryStore(): KeyValueStore & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe("clampSplit", () => {
  it("passes a ratio through when both columns keep their minimum", () => {
    expect(clampSplit(0.5, 1000)).toBe(0.5);
    expect(clampSplit(0.4, 2000)).toBe(0.4);
  });

  it("clamps so each column keeps MIN_COLUMN_PX (320) of the container", () => {
    // 1000px wide → ratio must stay within [0.32, 0.68].
    expect(clampSplit(0.1, 1000)).toBeCloseTo(0.32);
    expect(clampSplit(0.95, 1000)).toBeCloseTo(0.68);
  });

  it("falls back to an even split when the container can't fit two minimums", () => {
    expect(clampSplit(0.9, 600)).toBe(0.5); // 2×320 > 600
  });

  it("falls back to the default for degenerate inputs", () => {
    expect(clampSplit(0.5, 0)).toBe(DEFAULT_SPLIT);
    expect(clampSplit(Number.NaN, 1000)).toBe(DEFAULT_SPLIT);
    expect(clampSplit(0.5, Number.NaN)).toBe(DEFAULT_SPLIT);
  });

  it("honours a custom per-column minimum", () => {
    expect(clampSplit(0.05, 1000, 100)).toBeCloseTo(0.1);
    expect(clampSplit(0.99, 1000, 100)).toBeCloseTo(0.9);
  });
});

describe("split persistence", () => {
  it("round-trips a ratio through save/load under the wiki.restate.split key", () => {
    const store = memoryStore();
    saveSplit(store, 0.62);
    expect(store.map.get(SPLIT_KEY)).toBe("0.62");
    expect(loadSplit(store)).toBe(0.62);
  });

  it("returns null when nothing is stored or the value is unusable", () => {
    const store = memoryStore();
    expect(loadSplit(store)).toBeNull();
    for (const bad of ["garbage", "0", "1", "-0.3", "1.4", ""]) {
      store.setItem(SPLIT_KEY, bad);
      expect(loadSplit(store)).toBeNull();
    }
  });
});
