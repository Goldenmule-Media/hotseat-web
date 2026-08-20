import { describe, expect, it } from "vitest";

import { glossaryDefinitions, gradeOf, termRefsOf, titleOf } from "./glossary";
import type { SectionElementSummary } from "./live";

const el = (over: Partial<SectionElementSummary> & { id: string }): SectionElementSummary =>
  ({ title: undefined, status: undefined, scalars: undefined, ...over }) as SectionElementSummary;

describe("titleOf / gradeOf", () => {
  it("falls back to the id, then to Untitled", () => {
    expect(titleOf(el({ id: "t1", title: "Quorum" }))).toBe("Quorum");
    expect(titleOf(el({ id: "t1" }))).toBe("t1");
    expect(titleOf(undefined)).toBe("Untitled");
  });

  it("reads the grade scalar, defaulting to empty", () => {
    expect(gradeOf(el({ id: "t1", scalars: { grade: "partial" } }))).toBe("partial");
    expect(gradeOf(el({ id: "t1" }))).toBe("");
    expect(gradeOf(el({ id: "t1", scalars: { grade: 3 } }))).toBe("");
  });
});

describe("termRefsOf", () => {
  it("defaults a statusless element to marked and carries the grade", () => {
    expect(termRefsOf([el({ id: "a", title: "Lease" }), el({ id: "b", title: "Quorum", status: "checked", scalars: { grade: "surface" } })])).toEqual([
      { id: "a", term: "Lease", status: "marked", grade: "" },
      { id: "b", term: "Quorum", status: "checked", grade: "surface" },
    ]);
  });
});

describe("glossaryDefinitions", () => {
  const standalone = ["# Systems", "", "## Glossary", "", "### Lease", "", "A lock that expires.", ""].join("\n");

  it("maps lowercased term to definition", () => {
    const defs = glossaryDefinitions(standalone, "first");
    expect(defs.get("lease")).toContain("A lock that expires.");
  });

  it("is empty for a null render or a page with no Glossary heading", () => {
    expect(glossaryDefinitions(null, "first").size).toBe(0);
    expect(glossaryDefinitions("# Notes: X\n\n## Notes\n\nnothing here.\n", "last").size).toBe(0);
  });

  it('"last" finds the real Glossary when a note body carries its own ## heading', () => {
    const study = [
      "# Notes: Book",
      "",
      "## Notes",
      "",
      "### A note",
      "",
      "## Glossary", // authored INSIDE a note body — a decoy
      "",
      "not the real one",
      "",
      "## Glossary",
      "",
      "### Quorum",
      "",
      "More than half.",
      "",
    ].join("\n");
    expect(glossaryDefinitions(study, "last").get("quorum")).toContain("More than half.");
    // "first" would pick up the decoy instead — which is why the occurrence is a parameter.
    expect(glossaryDefinitions(study, "first").get("quorum")).toBeUndefined();
  });

  it('"first" is right for a standalone glossary, where a DEFINITION may carry a ## heading', () => {
    const withHeading = [
      "# Systems",
      "",
      "## Glossary",
      "",
      "### Lease",
      "",
      "A lock that expires.",
      "",
      "## Glossary", // written inside the definition — must not win
      "",
      "decoy",
      "",
    ].join("\n");
    expect(glossaryDefinitions(withHeading, "first").get("lease")).toContain("A lock that expires.");
  });
});
