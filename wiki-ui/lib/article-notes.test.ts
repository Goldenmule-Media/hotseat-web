/**
 * Reading the Source rows and the Summary back out of a rendered `article-notes` page.
 * The studio's inputs seed from these, so a parse that silently returns "" would look
 * like an empty field and invite the user to overwrite real content.
 */
import { describe, expect, it } from "vitest";

import { readSource, readSummary } from "./article-notes";

const page = [
  "# Article notes: The Shape of Data",
  "",
  "**Status:** reading",
  "",
  "## Source",
  "- **Link:** https://example.com/shape-of-data",
  "- **Date:** 2026-08-19",
  "",
  "## Summary",
  "Worth rereading. The middle third is the argument.",
  "",
  "## Notes",
  "A first thought.",
  "",
].join("\n");

describe("readSource", () => {
  it("reads the link and date rows", () => {
    expect(readSource(page)).toEqual({ link: "https://example.com/shape-of-data", date: "2026-08-19" });
  });

  it("returns empty strings for a page with nothing recorded yet", () => {
    const fresh = ["# Article notes: New", "", "## Source", "_No source recorded._", "", "## Notes", "_No notes yet._"].join("\n");
    expect(readSource(fresh)).toEqual({ link: "", date: "" });
    expect(readSource(null)).toEqual({ link: "", date: "" });
  });
});

describe("readSummary", () => {
  it("reads the summary body", () => {
    expect(readSummary(page)).toBe("Worth rereading. The middle third is the argument.");
  });

  it("treats the unauthored placeholder as empty, not as content", () => {
    const fresh = ["# Article notes: New", "", "## Summary", "_Not summarized yet._", "", "## Notes", "x"].join("\n");
    expect(readSummary(fresh)).toBe("");
    expect(readSummary(null)).toBe("");
  });
});
