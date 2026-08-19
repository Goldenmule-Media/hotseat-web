/**
 * Ingestion validators: field-kind grammar, no-markdown-in-text-leaf,
 * ref integrity (incl. deep inline refs), block normal form.
 */
import { describe, expect, it } from "vitest";

import type { IBlock, IPageNode, ISection, IWorkspaceState, PageId, SectionId } from "../src/api";
import { Registry } from "../src/core/registry";
import { validatePage, contentHash } from "../src/core/ingestion";
import { BlockNormalFormError, FieldKindError, RefIntegrityError } from "../src/core/errors";

const registry = new Registry([]);

function workspaceWith(node: IPageNode): IWorkspaceState {
  return {
    id: "ws:1" as never,
    name: "ws",
    status: "active",
    pages: new Map([[node.id, node]]),
    children: new Map(),
    links: [],
    retired: new Set(),
    version: 1,
  };
}

function page(sections: ISection[]): IPageNode {
  return {
    id: "p:1" as PageId,
    type: "t",
    parentId: null,
    title: "T",
    status: "draft",
    sections,
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
  };
}

function sec(fields: ISection["fields"]): ISection {
  return { id: "sec:a" as SectionId, key: "a", name: "A", order: 0, parentId: null, fields };
}

describe("field-kind grammar", () => {
  it("prose rejects a fenced code block", () => {
    const p = page([sec({ body: { kind: "prose", value: "```ts\nx\n```" } })]);
    expect(() => validatePage(workspaceWith(p), p, registry)).toThrow(FieldKindError);
  });

  it("code requires a non-empty lang tag", () => {
    const p = page([sec({ src: { kind: "code", lang: "", source: "x", hash: contentHash("x") } })]);
    expect(() => validatePage(workspaceWith(p), p, registry)).toThrow(FieldKindError);
  });

  it("a ref field with an unresolvable target is rejected", () => {
    const p = page([sec({ r: { kind: "ref", target: { kind: "page", id: "p:missing" as PageId } } })]);
    expect(() => validatePage(workspaceWith(p), p, registry)).toThrow(RefIntegrityError);
  });
});

describe("blocks", () => {
  it("rejects Markdown syntax in a text leaf", () => {
    const block: IBlock = { kind: "paragraph", id: "b1" as never, inlines: [{ kind: "text", value: "see *this*", marks: [] }] };
    const p = page([sec({ doc: { kind: "blocks", blocks: [block] } })]);
    expect(() => validatePage(workspaceWith(p), p, registry)).toThrow(BlockNormalFormError);
  });

  it("detects a dangling inline ref deep in a block tree", () => {
    const inner: IBlock = { kind: "paragraph", id: "b2" as never, inlines: [{ kind: "ref", target: { kind: "page", id: "p:missing" as PageId } }] };
    const quote: IBlock = { kind: "quote", id: "b1" as never, blocks: [inner] };
    const p = page([sec({ doc: { kind: "blocks", blocks: [quote] } })]);
    expect(() => validatePage(workspaceWith(p), p, registry)).toThrow(RefIntegrityError);
  });

  it("rejects un-canonical marks (not sorted)", () => {
    const block: IBlock = { kind: "paragraph", id: "b1" as never, inlines: [{ kind: "text", value: "x", marks: ["strong", "emphasis"] }] };
    const p = page([sec({ doc: { kind: "blocks", blocks: [block] } })]);
    expect(() => validatePage(workspaceWith(p), p, registry)).toThrow(BlockNormalFormError);
  });

  it("rejects an image whose parts would not render back to itself", () => {
    // Each of these would emit Markdown that no longer parses to the same block,
    // breaking the round-trip fixed point the whole content model rests on.
    const bad: IBlock[] = [
      { kind: "image", id: "b1" as never, ref: "", alt: "x" },
      { kind: "image", id: "b1" as never, ref: "a\nb", alt: "x" },
      { kind: "image", id: "b1" as never, ref: "a(b)", alt: "x" },
      { kind: "image", id: "b1" as never, ref: "a", alt: "[x]" },
      { kind: "image", id: "b1" as never, ref: "a", alt: "x", title: 'a "b' },
    ];
    for (const block of bad) {
      const p = page([sec({ doc: { kind: "blocks", blocks: [block] } })]);
      expect(() => validatePage(workspaceWith(p), p, registry)).toThrow(BlockNormalFormError);
    }
  });

  it("accepts a well-formed image and leaves its ref unchecked", () => {
    // An attachment ref is NOT integrity-checked: validation is synchronous and pure,
    // and an existence check would need I/O. It has the same standing as any URL.
    const block: IBlock = { kind: "image", id: "b1" as never, ref: `attachment:${"a".repeat(64)}`, alt: "Diagram" };
    const p = page([sec({ doc: { kind: "blocks", blocks: [block] } })]);
    expect(() => validatePage(workspaceWith(p), p, registry)).not.toThrow();
  });
});
