/**
 * Determinism tests for blocks/refs (§10): byte-identical render, canonical marks,
 * array order, ref-derived labels, per-kind goldens.
 */
import { describe, expect, it } from "vitest";

import type { IBlock, IInline } from "../src/api";
import { renderBlocks, renderInlines } from "../src/render/blocks";
import { normalizeBlocks } from "../src/core/ingestion";

const label = () => "[ref]";

describe("block render", () => {
  it("renders each block kind to its golden form", () => {
    const blocks: IBlock[] = [
      { kind: "heading", id: "h" as never, level: 2, inlines: [{ kind: "text", value: "Title", marks: [] }] },
      { kind: "paragraph", id: "p" as never, inlines: [{ kind: "text", value: "hi ", marks: [] }, { kind: "code-span", value: "x" }] },
      { kind: "code", id: "c" as never, lang: "ts", source: "const a = 1;", hash: "0" },
      { kind: "list", id: "l" as never, ordered: false, items: [[{ kind: "paragraph", id: "li" as never, inlines: [{ kind: "text", value: "one", marks: [] }] }]] },
      { kind: "divider", id: "d" as never },
    ];
    const out = renderBlocks(blocks, label);
    expect(out).toBe(["## Title", "hi `x`", "```ts\nconst a = 1;\n```", "- one", "---"].join("\n\n"));
  });

  it("strong(em x) and em(strong x) fold to the same canonical marks", () => {
    const a: IInline = { kind: "text", value: "x", marks: ["strong", "emphasis"] };
    const b: IInline = { kind: "text", value: "x", marks: ["emphasis", "strong"] };
    const blocksA = normalizeBlocks([{ kind: "paragraph", id: "p" as never, inlines: [a] }]);
    const blocksB = normalizeBlocks([{ kind: "paragraph", id: "p" as never, inlines: [b] }]);
    expect(renderBlocks(blocksA, label)).toBe(renderBlocks(blocksB, label));
  });

  it("renders byte-identically across repeated renders", () => {
    const inlines: IInline[] = normalizeBlocks([
      { kind: "paragraph", id: "p" as never, inlines: [{ kind: "text", value: "a", marks: ["emphasis"] }, { kind: "text", value: "b", marks: ["emphasis"] }] },
    ])[0]!.kind === "paragraph"
      ? (normalizeBlocks([{ kind: "paragraph", id: "p" as never, inlines: [{ kind: "text", value: "a", marks: ["emphasis"] }, { kind: "text", value: "b", marks: ["emphasis"] }] }])[0] as { inlines: IInline[] }).inlines
      : [];
    // adjacent same-mark text merges → "_ab_"
    expect(renderInlines(inlines, label)).toBe("_ab_");
    expect(renderInlines(inlines, label)).toBe("_ab_");
  });

  it("a ref-derived label updates when the resolver changes (reorder/rename payoff)", () => {
    const blocks: IBlock[] = [{ kind: "paragraph", id: "p" as never, inlines: [{ kind: "ref", target: { kind: "section", id: "s1" as never } }] }];
    expect(renderBlocks(blocks, () => "Old name")).toBe("Old name");
    expect(renderBlocks(blocks, () => "New name")).toBe("New name");
  });
});
