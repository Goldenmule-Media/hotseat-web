/**
 * Direct unit tests of `applyOps` (§2.1): each section operation in isolation.
 */
import { describe, expect, it } from "vitest";

import type { IBlock, IField, ISection, PageState, SectionId, SectionOp } from "../src/api";
import { applyOps } from "../src/core/operations";
import { contentHash } from "../src/core/ingestion";

function makePage(sections: ISection[]): PageState {
  return {
    id: "p:1" as never,
    type: "t",
    parentId: null,
    title: "T",
    status: "draft",
    sections,
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
  };
}

function sec(key: string, fields: Record<string, IField> = {}): ISection {
  return { id: `sec:${key}` as SectionId, key, name: key, order: 0, parentId: null, fields };
}

function run(page: PageState, ops: SectionOp[]): void {
  applyOps(page, ops, { now: "2020-02-02T00:00:00.000Z" });
}

describe("applyOps", () => {
  it("setField replaces a typed field and bumps updatedAt", () => {
    const page = makePage([sec("summary", { body: { kind: "prose", value: "" } })]);
    run(page, [{ op: "setField", section: "summary", field: "body", value: { kind: "prose", value: "hi" } }]);
    expect(page.sections[0]!.fields.body).toEqual({ kind: "prose", value: "hi" });
    expect(page.updatedAt).toBe("2020-02-02T00:00:00.000Z");
  });

  it("addElement / setElementField / moveElement / removeElement", () => {
    const page = makePage([sec("items", { items: { kind: "list", elementType: "x", elements: [] } })]);
    run(page, [
      { op: "addElement", section: "items", field: "items", id: "a", fields: { v: { kind: "scalar", value: 1 } } },
      { op: "addElement", section: "items", field: "items", id: "b", fields: { v: { kind: "scalar", value: 2 } } },
    ]);
    const list = () => (page.sections[0]!.fields.items as { kind: "list"; elements: { id: string }[] }).elements;
    expect(list().map((e) => e.id)).toEqual(["a", "b"]);
    run(page, [{ op: "moveElement", section: "items", field: "items", id: "b", toIndex: 0 }]);
    expect(list().map((e) => e.id)).toEqual(["b", "a"]);
    run(page, [{ op: "setElementField", section: "items", field: "items", id: "a", elementField: "v", value: { kind: "scalar", value: 9 } }]);
    expect((list().find((e) => e.id === "a") as unknown as { fields: { v: IField } }).fields.v).toEqual({ kind: "scalar", value: 9 });
    run(page, [{ op: "removeElement", section: "items", field: "items", id: "b" }]);
    expect(list().map((e) => e.id)).toEqual(["a"]);
  });

  it("applyTextEdits replays edits descending and recomputes hash", () => {
    const src = "hello world";
    const page = makePage([sec("code", { src: { kind: "code", lang: "ts", source: src, hash: contentHash(src) } })]);
    run(page, [
      { op: "applyTextEdits", section: "code", field: "src", edits: [
        { start: 0, end: 5, replacement: "goodbye" },
        { start: 6, end: 11, replacement: "there" },
      ] },
    ]);
    const f = page.sections[0]!.fields.src as { kind: "code"; source: string; hash: string };
    expect(f.source).toBe("goodbye there");
    expect(f.hash).toBe(contentHash("goodbye there"));
  });

  it("addBlock / setBlock / moveBlock / removeBlock", () => {
    const page = makePage([sec("doc", { body: { kind: "blocks", blocks: [] } })]);
    const blocks = () => (page.sections[0]!.fields.body as { kind: "blocks"; blocks: IBlock[] }).blocks;
    const para = (id: string, value: string): IBlock => ({ kind: "paragraph", id: id as never, inlines: [{ kind: "text", value, marks: [] }] });
    run(page, [
      { op: "addBlock", section: "doc", field: "body", block: para("b1", "one") },
      { op: "addBlock", section: "doc", field: "body", block: para("b2", "two") },
    ]);
    expect(blocks().map((b) => b.id)).toEqual(["b1", "b2"]);
    run(page, [{ op: "moveBlock", section: "doc", field: "body", block: "b2" as never, toIndex: 0 }]);
    expect(blocks().map((b) => b.id)).toEqual(["b2", "b1"]);
    run(page, [{ op: "setBlock", section: "doc", field: "body", block: para("b1", "ONE") }]);
    expect((blocks().find((b) => b.id === ("b1" as never)) as { inlines: { value: string }[] }).inlines[0]!.value).toBe("ONE");
    run(page, [{ op: "removeBlock", section: "doc", field: "body", block: "b2" as never }]);
    expect(blocks().map((b) => b.id)).toEqual(["b1"]);
  });

  it("addSection / renameSection / moveSection / removeSection", () => {
    const page = makePage([sec("a"), sec("b")]);
    run(page, [{ op: "addSection", key: "c", name: "C", id: "sec:c" as SectionId }]);
    expect(page.sections.map((s) => s.key)).toContain("c");
    run(page, [{ op: "renameSection", section: "c", name: "Renamed" }]);
    expect(page.sections.find((s) => s.key === "c")!.name).toBe("Renamed");
    run(page, [{ op: "moveSection", section: "c", parentSection: null, toIndex: 0 }]);
    expect(page.sections.filter((s) => s.parentId === null).sort((x, y) => x.order - y.order)[0]!.key).toBe("c");
    run(page, [{ op: "removeSection", section: "c" }]);
    expect(page.sections.map((s) => s.key)).not.toContain("c");
  });

  it("setMeta writes into the section meta bag", () => {
    const page = makePage([sec("a")]);
    run(page, [{ op: "setMeta", section: "a", path: ["count"], value: 3 }]);
    expect(page.sections[0]!.meta).toEqual({ count: 3 });
  });
});
