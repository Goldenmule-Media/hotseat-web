import { describe, expect, it } from "vitest";
import {
  asCritiqueVerdict,
  assembleDraft,
  clearRestateDraft,
  isRestatable,
  loadRestateDraft,
  pruneBySection,
  restateStorageKey,
  saveRestateDraft,
  severityFromHeading,
  sliceH2Section,
  splitDraft,
  splitRenderedElement,
  type KeyValueStore,
} from "./restate";

// ── splitDraft ─────────────────────────────────────────────────────────────────

describe("splitDraft", () => {
  it("splits on top-level ## headings into [{title, markdown}]", () => {
    const draft = "## Alpha\n\nFirst body.\n\n## Beta\n\nSecond body,\ntwo lines.";
    expect(splitDraft(draft, "Fallback")).toEqual([
      { title: "Alpha", markdown: "First body." },
      { title: "Beta", markdown: "Second body,\ntwo lines." },
    ]);
  });

  it("a draft with NO ## headings becomes one section titled from the fallback", () => {
    expect(splitDraft("Just prose,\nno headings.", "First selected")).toEqual([
      { title: "First selected", markdown: "Just prose,\nno headings." },
    ]);
  });

  it("content before the first heading becomes a leading fallback-titled section", () => {
    expect(splitDraft("Preamble text.\n\n## Alpha\n\nBody.", "Lead")).toEqual([
      { title: "Lead", markdown: "Preamble text." },
      { title: "Alpha", markdown: "Body." },
    ]);
  });

  it("does not split on ### deeper headings or on ## inside fenced code", () => {
    const draft = "## Alpha\n\n### Sub-point\n\n```md\n## not a heading\n```\n\nTail.";
    expect(splitDraft(draft, "F")).toEqual([
      { title: "Alpha", markdown: "### Sub-point\n\n```md\n## not a heading\n```\n\nTail." },
    ]);
  });

  it("keeps a heading-only section (empty body) — the engine is the validator", () => {
    expect(splitDraft("## Alpha\n\n## Beta\n\nBody.", "F")).toEqual([
      { title: "Alpha", markdown: "" },
      { title: "Beta", markdown: "Body." },
    ]);
  });

  it("strips ATX closing hashes and surrounding whitespace from titles", () => {
    expect(splitDraft("##   Spaced out  ##\n\nBody.", "F")).toEqual([{ title: "Spaced out", markdown: "Body." }]);
  });

  it("returns [] for an empty or whitespace-only draft", () => {
    expect(splitDraft("", "F")).toEqual([]);
    expect(splitDraft("  \n\n  ", "F")).toEqual([]);
  });

  it("normalizes CRLF line endings", () => {
    expect(splitDraft("## A\r\n\r\nBody.\r\n", "F")).toEqual([{ title: "A", markdown: "Body." }]);
  });
});

// ── assembleDraft (the splitDraft inverse) ─────────────────────────────────────

describe("assembleDraft", () => {
  it("round-trips through splitDraft: same title/markdown pairs back (multi-section)", () => {
    const xs = [
      { title: "Alpha", body: "First body.\n\nSecond paragraph." },
      { title: "Beta", body: "- a list\n- of items" },
      { title: "Gamma", body: "" },
    ];
    expect(splitDraft(assembleDraft(xs), "unused-fallback")).toEqual([
      { title: "Alpha", markdown: "First body.\n\nSecond paragraph." },
      { title: "Beta", markdown: "- a list\n- of items" },
      { title: "Gamma", markdown: "" },
    ]);
  });

  it("assembles a single section as one ## block", () => {
    expect(assembleDraft([{ title: "Only", body: "Text." }])).toBe("## Only\n\nText.");
    expect(splitDraft(assembleDraft([{ title: "Only", body: "Text." }]), "f")).toEqual([
      { title: "Only", markdown: "Text." },
    ]);
  });

  it("bodies containing fenced ``` blocks (even with ## inside) survive the round-trip", () => {
    const xs = [
      { title: "Code", body: "```md\n## not a heading\n```" },
      { title: "After", body: "Tail." },
    ];
    expect(splitDraft(assembleDraft(xs), "f")).toEqual([
      { title: "Code", markdown: "```md\n## not a heading\n```" },
      { title: "After", markdown: "Tail." },
    ]);
  });
});

// ── splitRenderedElement / severityFromHeading ─────────────────────────────────

describe("splitRenderedElement", () => {
  it("separates the leading rendered heading from the body (unnumbered `### Title`)", () => {
    expect(splitRenderedElement("### Storage model\n\nThe body.\n\nMore.")).toEqual({
      heading: "Storage model",
      body: "The body.\n\nMore.",
    });
  });

  it("returns the whole text as body when there is no leading heading", () => {
    expect(splitRenderedElement("- a single rendered bullet")).toEqual({
      heading: null,
      body: "- a single rendered bullet",
    });
  });

  it("handles a heading-only render (empty body)", () => {
    expect(splitRenderedElement("### Only a title")).toEqual({ heading: "Only a title", body: "" });
  });

  it("passes a numbered heading through verbatim (other page types still render ordinals)", () => {
    expect(splitRenderedElement("### 2. Storage model\n\nBody.")).toEqual({
      heading: "2. Storage model",
      body: "Body.",
    });
  });
});

describe("severityFromHeading", () => {
  it("extracts the trailing (severity) from a note heading", () => {
    expect(severityFromHeading("Race in the tail (major)")).toBe("major");
    expect(severityFromHeading("Terminology drift (minor)")).toBe("minor");
    expect(severityFromHeading("Broken invariant (critical)")).toBe("critical");
  });

  it("returns null for headings without a severity suffix (or no heading)", () => {
    expect(severityFromHeading("Storage model")).toBeNull();
    expect(severityFromHeading("Odd title (urgent)")).toBeNull();
    expect(severityFromHeading(null)).toBeNull();
  });
});

// ── sliceH2Section ─────────────────────────────────────────────────────────────

describe("sliceH2Section", () => {
  const page = "# Spec: T\n\n## Sections\n\n### Overview\n\nThe summary line.\n\n### A\n\nBody.\n\n## Review\n\n_Not reviewed._";

  it("returns the body of the named H2 section, stopping at the next H2", () => {
    expect(sliceH2Section(page, "Review")).toBe("_Not reviewed._");
  });

  it("keeps deeper headings inside the section body", () => {
    expect(sliceH2Section(page, "Sections")).toBe("### Overview\n\nThe summary line.\n\n### A\n\nBody.");
  });

  it("returns null for an absent section and ignores fenced ## lines", () => {
    expect(sliceH2Section(page, "Missing")).toBeNull();
    expect(sliceH2Section("```\n## Review\n```\ntext", "Review")).toBeNull();
  });

  // Section bodies preserve authored H2s and render BEFORE the real "## Review" heading.
  const shadowed =
    "# Spec: T\n\n## Sections\n\n### A\n\nBody.\n\n## Review\n\nA literal heading INSIDE a section body.\n\n## Review\n\nThe real recorded summary.";

  it('occurrence "last" skips a literal "## Review" authored inside a section body', () => {
    expect(sliceH2Section(shadowed, "Review")).toBe("A literal heading INSIDE a section body.");
    expect(sliceH2Section(shadowed, "Review", "last")).toBe("The real recorded summary.");
  });

  it('accepted residual: a literal "## Review" AFTER the real one still shadows last-match', () => {
    const after = "## Review\n\nThe real one.\n\n## Review\n\nAuthored inside a note body, after it.";
    expect(sliceH2Section(after, "Review", "last")).toBe("Authored inside a note body, after it.");
  });
});

// ── the critique verdict ───────────────────────────────────────────────────────

describe("asCritiqueVerdict", () => {
  it("narrows a well-formed verdict", () => {
    const raw = { grade: "surface", summary: "s", gaps: ["g1", 2, "g2"], improvements: "not-a-list" };
    expect(asCritiqueVerdict(raw)).toEqual({ grade: "surface", summary: "s", gaps: ["g1", "g2"], improvements: [] });
  });

  it("defaults an absent or unknown grade to partial", () => {
    expect(asCritiqueVerdict({ summary: "s" })?.grade).toBe("partial");
    expect(asCritiqueVerdict({ summary: "s", grade: "excellent" })?.grade).toBe("partial");
  });

  it("returns null without a usable summary", () => {
    expect(asCritiqueVerdict(null)).toBeNull();
    expect(asCritiqueVerdict({ gaps: [] })).toBeNull();
    expect(asCritiqueVerdict({ summary: "  " })).toBeNull();
  });
});

// ── draft persistence ──────────────────────────────────────────────────────────

function memoryStore(): KeyValueStore & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe("restate draft persistence", () => {
  it("keys by workspace + page in the wiki.* naming style", () => {
    expect(restateStorageKey("ws-1", "spec-restatement:abc")).toBe("wiki.restate.ws-1.spec-restatement:abc");
  });

  it("round-trips {selectedId, drafts, sessionId} through save/load", () => {
    const store = memoryStore();
    const state = {
      selectedId: "a",
      drafts: { a: "## X\n\nbody", b: "other section's draft" },
      sessionId: "sess-9",
    };
    saveRestateDraft(store, "ws", "p", state);
    expect(loadRestateDraft(store, "ws", "p")).toEqual(state);
    // Another page's key is untouched.
    expect(loadRestateDraft(store, "ws", "other")).toBeNull();
  });

  it("keeps a deliberately-emptied draft as an entry (absent ≠ empty — absent re-seeds)", () => {
    const store = memoryStore();
    saveRestateDraft(store, "ws", "p", { selectedId: "a", drafts: { a: "" } });
    expect(loadRestateDraft(store, "ws", "p")).toEqual({ selectedId: "a", drafts: { a: "" } });
  });

  it("keeps the page session with nothing else selected or drafted", () => {
    const store = memoryStore();
    saveRestateDraft(store, "ws", "p", { drafts: {}, sessionId: "sess-9" });
    expect(loadRestateDraft(store, "ws", "p")).toEqual({ drafts: {}, sessionId: "sess-9" });
  });

  it("round-trips with no selection, and clears cleanly", () => {
    const store = memoryStore();
    saveRestateDraft(store, "ws", "p", { drafts: { a: "d" } });
    expect(loadRestateDraft(store, "ws", "p")).toEqual({ drafts: { a: "d" } });
    clearRestateDraft(store, "ws", "p");
    expect(loadRestateDraft(store, "ws", "p")).toBeNull();
  });

  it("migrates a multi-select payload: first selection, single-section entries only", () => {
    const store = memoryStore();
    store.setItem(
      restateStorageKey("ws", "p"),
      JSON.stringify({
        selectedIds: ["b", "a"],
        drafts: { "a\nb": "the pair's draft", b: "b's draft" },
        sessionId: "sess-1",
        sourceKey: "a\nb",
      }),
    );
    expect(loadRestateDraft(store, "ws", "p")).toEqual({ selectedId: "b", drafts: { b: "b's draft" } });
  });

  it("carries an older flat `draft` over", () => {
    const store = memoryStore();
    store.setItem(restateStorageKey("ws", "p"), JSON.stringify({ selectedIds: ["a"], draft: "old text" }));
    expect(loadRestateDraft(store, "ws", "p")).toEqual({ selectedId: "a", drafts: { a: "old text" } });
  });

  it("drops per-section-era sessions — they were opened under a different prompt contract", () => {
    const store = memoryStore();
    const kept = { selectedId: "a", drafts: { a: "d" } };
    for (const legacy of [{ sessions: { a: "sess-1" } }, { sessionId: "sess-1", sourceKey: "a" }]) {
      store.setItem(restateStorageKey("ws", "p"), JSON.stringify({ ...kept, ...legacy }));
      expect(loadRestateDraft(store, "ws", "p")).toEqual(kept);
    }
  });

  it("returns null for corrupt or empty stored payloads", () => {
    const store = memoryStore();
    store.setItem(restateStorageKey("ws", "p"), "not-json");
    expect(loadRestateDraft(store, "ws", "p")).toBeNull();
    store.setItem(restateStorageKey("ws", "p"), JSON.stringify({ drafts: {} }));
    expect(loadRestateDraft(store, "ws", "p")).toBeNull();
    store.setItem(restateStorageKey("ws", "p"), JSON.stringify({ drafts: {}, sessions: { a: "legacy" } }));
    expect(loadRestateDraft(store, "ws", "p")).toBeNull();
  });
});

describe("isRestatable", () => {
  const elements = [
    { id: "a", status: "ai-draft" },
    { id: "b", status: "human-verified" },
    { id: "d" },
  ];

  it("holds only for a section that still exists AND is still ai-draft", () => {
    expect(isRestatable("a", elements)).toBe(true);
    expect(isRestatable("b", elements)).toBe(false); // verified underneath you
    expect(isRestatable("d", elements)).toBe(false); // no status at all
    expect(isRestatable("gone", elements)).toBe(false);
    expect(isRestatable(null, elements)).toBe(false);
    expect(isRestatable("a", [])).toBe(false);
  });
});

describe("pruneBySection", () => {
  const elements = [{ id: "a" }, { id: "b" }];

  it("keeps entries whose section still exists, empty values included", () => {
    expect(pruneBySection({ a: "solo", b: "", gone: "stale" }, elements)).toEqual({ a: "solo", b: "" });
  });

  it("works for any value type, and drops everything against an empty section list", () => {
    expect(pruneBySection({ a: { verdict: 1 } }, elements)).toEqual({ a: { verdict: 1 } });
    expect(pruneBySection({ a: "x" }, [])).toEqual({});
  });
});
