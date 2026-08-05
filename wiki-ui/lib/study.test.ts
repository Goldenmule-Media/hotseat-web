import { describe, expect, it } from "vitest";
import {
  asStudyVerdict,
  boldCandidates,
  evaluationFeedbackMarkdown,
  findTermMatches,
  glossaryEntries,
  loadStudyDraft,
  parseEvaluationFeedback,
  saveStudyDraft,
  studyStorageKey,
  termContext,
  termFilterRank,
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

describe("glossaryEntries", () => {
  const md = [
    "### Entropy",
    "Average information per token.",
    "",
    "**Critique:** Solid.",
    "",
    "### Logit",
    "A raw score.",
    "",
    "### RLHF",
    "_None._",
  ].join("\n");

  it("parses term chunks, stripping critique and the empty placeholder", () => {
    expect(glossaryEntries(md)).toEqual([
      { term: "Entropy", definition: "Average information per token." },
      { term: "Logit", definition: "A raw score." },
      { term: "RLHF", definition: "" },
    ]);
  });

  it("does not split on #### or on headings inside fences", () => {
    const tricky = "### A\n#### not a term\n```\n### fenced\n```\nbody";
    expect(glossaryEntries(tricky)).toHaveLength(1);
  });
});

describe("termFilterRank", () => {
  it("ranks name-prefix over name-substring over definition-only, null when absent", () => {
    expect(termFilterRank("ent", "Entropy", "")).toBe(0);
    expect(termFilterRank("ent", "Cross Entropy", "")).toBe(1);
    expect(termFilterRank("bits", "Entropy", "related to bits required")).toBe(2);
    expect(termFilterRank("zzz", "Entropy", "average information")).toBeNull();
  });

  it("matches every term on a blank query", () => {
    expect(termFilterRank("  ", "Anything", "")).toBe(1);
  });
});

describe("evaluation feedback round-trip", () => {
  it("stores bullets then the suggestion, and parses them back apart", () => {
    const md = evaluationFeedbackMarkdown({
      grade: "partial",
      points: ["no reward model", "post-training, not inference"],
      suggestion: "Post-training that aligns outputs to human preferences via a reward model.",
    });
    expect(md).toContain("- no reward model");
    expect(md).toContain("**Suggestion:**");
    const parsed = parseEvaluationFeedback(md);
    expect(parsed.body).toBe("- no reward model\n- post-training, not inference");
    expect(parsed.suggestion).toContain("aligns outputs");
  });

  it("parses legacy feedback (no suggestion) as body-only", () => {
    expect(parseEvaluationFeedback("A sentence.\n\nGaps:\n- x")).toEqual({
      body: "A sentence.\n\nGaps:\n- x",
      suggestion: null,
    });
  });
});

describe("asStudyVerdict", () => {
  it("accepts the points+suggestion shape", () => {
    const v = asStudyVerdict({ grade: "understood", points: ["load-bearing idea present"], suggestion: "A crisp definition." });
    expect(v).toEqual({ grade: "understood", points: ["load-bearing idea present"], suggestion: "A crisp definition." });
  });

  it("folds a legacy summary/gaps reply into points and coerces a bad grade", () => {
    const v = asStudyVerdict({ grade: "meh", summary: "Reworded only.", gaps: ["no mechanism"] });
    expect(v).toEqual({ grade: "partial", points: ["Reworded only.", "no mechanism"], suggestion: null });
  });

  it("rejects a payload with nothing usable", () => {
    expect(asStudyVerdict({ grade: "surface" })).toBeNull();
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
