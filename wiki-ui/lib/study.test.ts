import { describe, expect, it } from "vitest";
import {
  boldCandidates,
  findTermMatches,
  loadStudyDraft,
  saveStudyDraft,
  studyStorageKey,
  termContext,
  type StudyDraft,
} from "./study";
import type { KeyValueStore } from "./restate";

const T = (id: string, term: string): { id: string; term: string } => ({ id, term });

describe("findTermMatches", () => {
  it("matches case-insensitively on whole words only", () => {
    const ms = findTermMatches("The Embedding layer; embeddings everywhere; disembedding no.", [T("a", "embedding")]);
    expect(ms).toHaveLength(2);
    expect(ms[0]).toMatchObject({ start: 4, end: 13 });
  });

  it("tolerates the text's plural of a singular term", () => {
    const ms = findTermMatches("Two epochs passed.", [T("a", "epoch")]);
    expect(ms).toHaveLength(1);
    expect(ms[0]!.end).toBe(10);
  });

  it("prefers the longest term over one it contains, without double-claiming", () => {
    const ms = findTermMatches("A logit vector holds one logit per token.", [T("short", "logit"), T("long", "logit vector")]);
    expect(ms.map((m) => m.termId)).toEqual(["long", "short"]);
  });

  it("handles terms with punctuation and returns matches in order", () => {
    const ms = findTermMatches("Use top-k, then temperature.", [T("t", "temperature"), T("k", "top-k")]);
    expect(ms.map((m) => m.termId)).toEqual(["k", "t"]);
  });

  it("returns nothing for blank terms or no occurrences", () => {
    expect(findTermMatches("Nothing here.", [T("a", "  "), T("b", "entropy")])).toEqual([]);
  });
});

describe("boldCandidates", () => {
  it("extracts bold runs in order, deduped case-insensitively, minus existing terms", () => {
    const md = "- The **attention mechanism** uses **Q (Query)**.\n- **Attention mechanism** again.\n- **Entropy** too.";
    expect(boldCandidates(md, ["entropy"])).toEqual(["attention mechanism", "Q (Query)"]);
  });

  it("skips fenced code and trailing punctuation", () => {
    const md = "```\n**not a term**\n```\nReal **term:** here.";
    expect(boldCandidates(md, [])).toEqual(["term"]);
  });

  it("drops runs too long to be terms", () => {
    const long = "x".repeat(61);
    expect(boldCandidates(`**${long}**`, [])).toEqual([]);
  });
});

describe("termContext", () => {
  const notes = [
    { title: "Sampling", markdown: "- **Temperature** divides logits.\n- Unrelated line." },
    { title: "Metrics", markdown: "- Entropy is average information." },
  ];

  it("collects only the lines where the term appears, grouped under note titles", () => {
    const ctx = termContext(notes, "temperature");
    expect(ctx).toContain("## Sampling");
    expect(ctx).toContain("divides logits");
    expect(ctx).not.toContain("Unrelated line");
    expect(ctx).not.toContain("## Metrics");
  });

  it("caps the assembled context", () => {
    const big = [{ title: "N", markdown: Array.from({ length: 200 }, () => "- entropy line").join("\n") }];
    expect(termContext(big, "entropy", 100).length).toBeLessThan(120);
  });
});

describe("draft persistence", () => {
  function memoryStore(): KeyValueStore {
    const m = new Map<string, string>();
    return {
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => void m.set(k, v),
      removeItem: (k) => void m.delete(k),
    };
  }

  it("round-trips a draft", () => {
    const store = memoryStore();
    const draft: StudyDraft = {
      selected: { kind: "term", id: "t1" },
      noteDrafts: { n1: "note text" },
      termDrafts: { t1: "definition text" },
    };
    saveStudyDraft(store, "ws", "page", draft);
    expect(loadStudyDraft(store, "ws", "page")).toEqual(draft);
  });

  it("returns null for absent, corrupt, or empty payloads", () => {
    const store = memoryStore();
    expect(loadStudyDraft(store, "ws", "page")).toBeNull();
    store.setItem(studyStorageKey("ws", "page"), "not json");
    expect(loadStudyDraft(store, "ws", "page")).toBeNull();
    store.setItem(studyStorageKey("ws", "page"), JSON.stringify({ noteDrafts: {}, termDrafts: {} }));
    expect(loadStudyDraft(store, "ws", "page")).toBeNull();
  });

  it("drops a malformed selection but keeps the drafts", () => {
    const store = memoryStore();
    store.setItem(
      studyStorageKey("ws", "page"),
      JSON.stringify({ selected: { kind: "nope" }, termDrafts: { t: "d" }, noteDrafts: {} }),
    );
    expect(loadStudyDraft(store, "ws", "page")).toEqual({ noteDrafts: {}, termDrafts: { t: "d" } });
  });
});
