import { describe, expect, it } from "vitest";
import { foldSectionElements, type SectionElements } from "./section-elements";

const good: SectionElements = {
  elements: [
    { id: "a", status: "ai-draft", title: "A" },
    { id: "b", status: "human-verified", title: "B" },
  ],
  loading: false,
  error: null,
};

describe("foldSectionElements", () => {
  it("a successful read replaces the elements and clears the error", () => {
    const prev: SectionElements = { elements: [], loading: true, error: "old failure" };
    expect(foldSectionElements(prev, { elements: good.elements })).toEqual(good);
  });

  it("a failed re-read KEEPS the previous elements and sets the error flag", () => {
    const next = foldSectionElements(good, { error: "boom" });
    expect(next.elements).toBe(good.elements);
    expect(next.error).toBe("boom");
    expect(next.loading).toBe(false);
  });

  it("a failure before any good read leaves the elements empty (nothing to keep)", () => {
    const pending: SectionElements = { elements: [], loading: true, error: null };
    expect(foldSectionElements(pending, { error: "unreachable" })).toEqual({
      elements: [],
      loading: false,
      error: "unreachable",
    });
  });
});
