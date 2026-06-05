import { describe, expect, it } from "vitest";
import { extractTerms, parseSnippet } from "./snippet";

describe("parseSnippet", () => {
  it("splits a ts_headline snippet into plain and highlighted segments", () => {
    const segs = parseSnippet("the **concurrency** model is **optimistic**");
    expect(segs).toEqual([
      { text: "the ", hit: false },
      { text: "concurrency", hit: true },
      { text: " model is ", hit: false },
      { text: "optimistic", hit: true },
    ]);
  });

  it("marks a leading match and drops empty segments", () => {
    expect(parseSnippet("**token** at the start")).toEqual([
      { text: "token", hit: true },
      { text: " at the start", hit: false },
    ]);
  });

  it("returns a single plain segment when there are no markers", () => {
    expect(parseSnippet("no markers here")).toEqual([{ text: "no markers here", hit: false }]);
  });
});

describe("extractTerms", () => {
  it("puts exact snippet matches first, then query tokens, deduped", () => {
    const terms = extractTerms("the **concurrency** token", "concur token");
    expect(terms[0]).toBe("concurrency");
    expect(terms).toContain("concur");
    expect(terms).toContain("token");
    // "token" appears in both the snippet and the query but only once.
    expect(terms.filter((t) => t.toLowerCase() === "token")).toHaveLength(1);
  });

  it("dedupes case-insensitively and drops sub-2-char tokens", () => {
    const terms = extractTerms("**Run** a thing", "run a");
    expect(terms.filter((t) => t.toLowerCase() === "run")).toHaveLength(1);
    expect(terms).not.toContain("a");
  });

  it("falls back to query tokens when the snippet has no highlights", () => {
    expect(extractTerms("plain snippet", "optimistic concurrency")).toEqual([
      "optimistic",
      "concurrency",
    ]);
  });
});
