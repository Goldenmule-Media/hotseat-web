import { describe, expect, it } from "vitest";
import {
  asCritiqueEvent,
  clearRestateDraft,
  createSseDecoder,
  loadRestateDraft,
  pruneSelection,
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

// ── splitRenderedElement / severityFromHeading ─────────────────────────────────

describe("splitRenderedElement", () => {
  it("separates the leading rendered heading from the body", () => {
    expect(splitRenderedElement("### 2. Storage model\n\nThe body.\n\nMore.")).toEqual({
      heading: "2. Storage model",
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
    expect(splitRenderedElement("### 1. Only a title")).toEqual({ heading: "1. Only a title", body: "" });
  });
});

describe("severityFromHeading", () => {
  it("extracts the trailing (severity) from a note heading", () => {
    expect(severityFromHeading("1. Race in the tail (major)")).toBe("major");
    expect(severityFromHeading("Terminology drift (minor)")).toBe("minor");
    expect(severityFromHeading("Broken invariant (critical)")).toBe("critical");
  });

  it("returns null for headings without a severity suffix (or no heading)", () => {
    expect(severityFromHeading("2. Storage model")).toBeNull();
    expect(severityFromHeading("Odd title (urgent)")).toBeNull();
    expect(severityFromHeading(null)).toBeNull();
  });
});

// ── sliceH2Section ─────────────────────────────────────────────────────────────

describe("sliceH2Section", () => {
  const page = "# Spec: T\n\n## Overview\n\nThe summary line.\n\n## Sections\n\n### 1. A\n\nBody.\n\n## Review\n\n_Not reviewed._";

  it("returns the body of the named H2 section, stopping at the next H2", () => {
    expect(sliceH2Section(page, "Overview")).toBe("The summary line.");
    expect(sliceH2Section(page, "Review")).toBe("_Not reviewed._");
  });

  it("keeps deeper headings inside the section body", () => {
    expect(sliceH2Section(page, "Sections")).toBe("### 1. A\n\nBody.");
  });

  it("returns null for an absent section and ignores fenced ## lines", () => {
    expect(sliceH2Section(page, "Missing")).toBeNull();
    expect(sliceH2Section("```\n## Overview\n```\ntext", "Overview")).toBeNull();
  });
});

// ── SSE decoding ───────────────────────────────────────────────────────────────

describe("createSseDecoder", () => {
  it("decodes multiple frames arriving in one chunk", () => {
    const sse = createSseDecoder();
    const events = sse.push('data: {"type":"delta","text":"a"}\n\ndata: {"type":"delta","text":"b"}\n\n');
    expect(events).toEqual([
      { type: "delta", text: "a" },
      { type: "delta", text: "b" },
    ]);
  });

  it("reassembles a frame split across arbitrary chunk boundaries", () => {
    const sse = createSseDecoder();
    expect(sse.push("da")).toEqual([]);
    expect(sse.push('ta: {"type":"delta","te')).toEqual([]);
    expect(sse.push('xt":"hi"}\n')).toEqual([]);
    expect(sse.push("\n")).toEqual([{ type: "delta", text: "hi" }]);
  });

  it("drops comment/keepalive lines and unparseable payloads", () => {
    const sse = createSseDecoder();
    expect(sse.push(": ping\n\ndata: not-json\n\ndata: {\"ok\":1}\n\n")).toEqual([{ ok: 1 }]);
  });

  it("joins multi-data-line frames with newlines (SSE spec)", () => {
    const sse = createSseDecoder();
    expect(sse.push('data: {"a":\ndata: 1}\n\n')).toEqual([{ a: 1 }]);
  });

  it("end() flushes a trailing unterminated frame", () => {
    const sse = createSseDecoder();
    expect(sse.push('data: {"type":"error","message":"boom"}')).toEqual([]);
    expect(sse.end()).toEqual([{ type: "error", message: "boom" }]);
  });
});

describe("asCritiqueEvent", () => {
  it("passes through delta and error frames", () => {
    expect(asCritiqueEvent({ type: "delta", text: "t" })).toEqual({ type: "delta", text: "t" });
    expect(asCritiqueEvent({ type: "error", message: "m" })).toEqual({ type: "error", message: "m" });
  });

  it("narrows a verdict frame, coercing gap/improvement lists and keeping sessionId", () => {
    const raw = {
      type: "verdict",
      verdict: { summary: "s", gaps: ["g1", 2, "g2"], improvements: "not-a-list" },
      sessionId: "sess-1",
    };
    expect(asCritiqueEvent(raw)).toEqual({
      type: "verdict",
      verdict: { summary: "s", gaps: ["g1", "g2"], improvements: [] },
      sessionId: "sess-1",
    });
  });

  it("returns null for malformed frames", () => {
    expect(asCritiqueEvent(null)).toBeNull();
    expect(asCritiqueEvent({ type: "delta" })).toBeNull();
    expect(asCritiqueEvent({ type: "verdict", verdict: { gaps: [] } })).toBeNull();
    expect(asCritiqueEvent({ type: "mystery" })).toBeNull();
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

  it("round-trips {selectedIds, draft, sessionId} through save/load", () => {
    const store = memoryStore();
    const state = { selectedIds: ["a", "b"], draft: "## X\n\nbody", sessionId: "sess-9" };
    saveRestateDraft(store, "ws", "p", state);
    expect(loadRestateDraft(store, "ws", "p")).toEqual(state);
    // Another page's key is untouched.
    expect(loadRestateDraft(store, "ws", "other")).toBeNull();
  });

  it("omits sessionId when it was never set, and clears cleanly", () => {
    const store = memoryStore();
    saveRestateDraft(store, "ws", "p", { selectedIds: ["a"], draft: "d" });
    expect(loadRestateDraft(store, "ws", "p")).toEqual({ selectedIds: ["a"], draft: "d" });
    clearRestateDraft(store, "ws", "p");
    expect(loadRestateDraft(store, "ws", "p")).toBeNull();
  });

  it("returns null for corrupt or empty stored payloads", () => {
    const store = memoryStore();
    store.setItem(restateStorageKey("ws", "p"), "not-json");
    expect(loadRestateDraft(store, "ws", "p")).toBeNull();
    store.setItem(restateStorageKey("ws", "p"), JSON.stringify({ selectedIds: [], draft: "" }));
    expect(loadRestateDraft(store, "ws", "p")).toBeNull();
  });
});

describe("pruneSelection", () => {
  const elements = [
    { id: "a", status: "ai-draft" },
    { id: "b", status: "human-verified" },
    { id: "c", status: "ai-draft" },
    { id: "d" },
  ];

  it("keeps only ids that still exist AND are still ai-draft, preserving order", () => {
    expect(pruneSelection(["c", "gone", "a", "b", "d"], elements)).toEqual(["c", "a"]);
  });

  it("returns [] against an empty section list", () => {
    expect(pruneSelection(["a"], [])).toEqual([]);
  });
});
