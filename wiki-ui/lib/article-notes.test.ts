/**
 * Reading the Source rows and the Summary back out of a rendered `article-notes` page.
 * The studio's inputs seed from these, so a parse that silently returns "" would look
 * like an empty field and invite the user to overwrite real content.
 */
import { describe, expect, it } from "vitest";

import { diffNotes, notesToDocument, readSource, readSummary, splitNoteDocument } from "./article-notes";

const page = [
  "# The Shape of Data",
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
    const fresh = ["# New", "", "## Source", "_No source recorded._", "", "## Notes", "_No notes yet._"].join("\n");
    expect(readSource(fresh)).toEqual({ link: "", date: "" });
    expect(readSource(null)).toEqual({ link: "", date: "" });
  });
});

describe("readSummary", () => {
  it("reads the summary body", () => {
    expect(readSummary(page)).toBe("Worth rereading. The middle third is the argument.");
  });

  it("treats the unauthored placeholder as empty, not as content", () => {
    const fresh = ["# New", "", "## Summary", "_Not summarized yet._", "", "## Notes", "x"].join("\n");
    expect(readSummary(fresh)).toBe("");
    expect(readSummary(null)).toBe("");
  });
});

const note = (id: string, markdown: string): { id: string; markdown: string } => ({ id, markdown });

describe("notesToDocument", () => {
  it("joins the notes into one document, blank line between", () => {
    expect(notesToDocument([note("a", "First."), note("b", "Second.")])).toBe("First.\n\nSecond.");
  });

  it("drops an empty note rather than opening a hole in the document", () => {
    expect(notesToDocument([note("a", "First."), note("b", "  \n"), note("c", "Third.")])).toBe("First.\n\nThird.");
  });
});

describe("splitNoteDocument", () => {
  it("splits on blank lines", () => {
    expect(splitNoteDocument("First.\n\nSecond.")).toEqual(["First.", "Second."]);
  });

  it("keeps a list with the paragraph it hangs off", () => {
    expect(splitNoteDocument("In order:\n\n- Safe\n- Ethical\n\nNext thought.")).toEqual([
      "In order:\n\n- Safe\n- Ethical",
      "Next thought.",
    ]);
  });

  it("keeps a quote with its lead-in and starts fresh after it", () => {
    expect(splitNoteDocument("They wrote:\n\n> A claim.\n\nMy reaction.")).toEqual(["They wrote:\n\n> A claim.", "My reaction."]);
  });

  it("ignores blank space at the ends and between", () => {
    expect(splitNoteDocument("\n\n  First.  \n\n   \n\nSecond.\n\n")).toEqual(["First.", "Second."]);
  });

  it("round-trips a document of stacked notes", () => {
    const notes = ["A paragraph.", "In order:\n\n- one\n- two", "A closing thought."];
    expect(splitNoteDocument(notesToDocument(notes.map((m, i) => note(String(i), m))))).toEqual(notes);
  });
});

describe("diffNotes", () => {
  const stored = [note("a", "First."), note("b", "Second."), note("c", "Third.")];

  it("is silent when nothing changed", () => {
    expect(diffNotes(stored, ["First.", "Second.", "Third."])).toEqual([]);
  });

  it("edits one note in place", () => {
    expect(diffNotes(stored, ["First.", "Second, revised.", "Third."])).toEqual([
      { command: "reviseNote", args: { noteId: "b", markdown: "Second, revised." } },
    ]);
  });

  it("anchors a note typed between two others", () => {
    expect(diffNotes(stored, ["First.", "Second.", "New.", "Third."])).toEqual([
      { command: "addNote", args: { markdown: "New.", afterId: "b" } },
    ]);
  });

  it("appends a note at the end without an anchor", () => {
    expect(diffNotes(stored, ["First.", "Second.", "Third.", "Fourth."])).toEqual([
      { command: "addNote", args: { markdown: "Fourth." } },
    ]);
  });

  it("removes a deleted note", () => {
    expect(diffNotes(stored, ["First.", "Third."])).toEqual([{ command: "removeNote", args: { noteId: "b" } }]);
  });

  it("rewrites positionally when several new notes precede an untouched tail", () => {
    expect(diffNotes(stored, ["First.", "New one.", "New two.", "Second.", "Third."])).toEqual([
      { command: "reviseNote", args: { noteId: "b", markdown: "New one." } },
      { command: "reviseNote", args: { noteId: "c", markdown: "New two." } },
      { command: "addNote", args: { markdown: "Second." } },
      { command: "addNote", args: { markdown: "Third." } },
    ]);
  });

  it("fills an empty list from a document typed in one go", () => {
    expect(diffNotes([], ["One.", "Two."])).toEqual([
      { command: "addNote", args: { markdown: "One." } },
      { command: "addNote", args: { markdown: "Two." } },
    ]);
  });

  it("clears every note when the document is emptied", () => {
    expect(diffNotes(stored, [])).toEqual([
      { command: "removeNote", args: { noteId: "a" } },
      { command: "removeNote", args: { noteId: "b" } },
      { command: "removeNote", args: { noteId: "c" } },
    ]);
  });

  it("ignores whitespace differences between the stored note and the document", () => {
    expect(diffNotes([note("a", "First.\n")], ["First."])).toEqual([]);
  });
});
