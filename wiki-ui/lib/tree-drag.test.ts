import { describe, expect, it } from "vitest";
import type { ITreeNode } from "wiki";
import { placeAt, resolveDrop, resolveRootDrop, subtreeIds, zoneAt, type DragSource } from "./tree-drag";

function node(id: string, children: ITreeNode[] = []): ITreeNode {
  return { id, title: id, children } as ITreeNode;
}

function drag(over: Partial<DragSource> = {}): DragSource {
  return { id: "a:1", parentKey: "@root", pinned: false, subtree: new Set(["a:1"]), ...over };
}

describe("zoneAt", () => {
  it("splits a row into before / inside / after bands", () => {
    expect(zoneAt(1, 32)).toBe("before");
    expect(zoneAt(16, 32)).toBe("inside");
    expect(zoneAt(31, 32)).toBe("after");
  });

  it("treats a zero-height row as all-inside", () => {
    expect(zoneAt(0, 0)).toBe("inside");
  });
});

describe("subtreeIds", () => {
  it("collects the node and every descendant", () => {
    expect([...subtreeIds(node("a:1", [node("a:2", [node("a:3")]), node("a:4")]))]).toEqual([
      "a:1",
      "a:2",
      "a:3",
      "a:4",
    ]);
  });
});

describe("resolveDrop", () => {
  const target = { id: "b:1", parentKey: "@root" };

  it("reads the middle band as a reparent under the target", () => {
    expect(resolveDrop(drag(), target, "inside")).toEqual({ parentKey: "b:1" });
  });

  it("reads the edge bands as a sibling placement in the target's parent", () => {
    expect(resolveDrop(drag(), target, "before")).toEqual({
      parentKey: "@root",
      anchor: { id: "b:1", side: "before" },
    });
    expect(resolveDrop(drag(), target, "after")).toEqual({
      parentKey: "@root",
      anchor: { id: "b:1", side: "after" },
    });
  });

  it("refuses a drop onto the page itself or into its own subtree", () => {
    const d = drag({ subtree: new Set(["a:1", "a:2"]) });
    expect(resolveDrop(d, { id: "a:1", parentKey: "@root" }, "inside")).toBeNull();
    expect(resolveDrop(d, { id: "a:2", parentKey: "a:1" }, "before")).toBeNull();
  });

  it("lets a pinned page reorder among its siblings but never leave its owner", () => {
    const d = drag({ id: "p:1", parentKey: "own:1", pinned: true, subtree: new Set(["p:1"]) });
    expect(d.parentKey).toBe(resolveDrop(d, { id: "p:2", parentKey: "own:1" }, "after")?.parentKey);
    expect(resolveDrop(d, { id: "p:2", parentKey: "own:1" }, "inside")).toBeNull();
    expect(resolveDrop(d, target, "before")).toBeNull();
  });
});

describe("resolveRootDrop", () => {
  it("appends to the root, and refuses a pinned page that isn't already there", () => {
    expect(resolveRootDrop(drag(), "@root")).toEqual({ parentKey: "@root" });
    expect(resolveRootDrop(drag({ pinned: true, parentKey: "own:1" }), "@root")).toBeNull();
    expect(resolveRootDrop(drag({ pinned: true }), "@root")).toEqual({ parentKey: "@root" });
  });
});

describe("placeAt", () => {
  it("moves an existing sibling to either side of a target", () => {
    expect(placeAt(["a", "b", "c"], "a", { id: "c", side: "after" })).toEqual(["b", "c", "a"]);
    expect(placeAt(["a", "b", "c"], "c", { id: "a", side: "before" })).toEqual(["c", "a", "b"]);
  });

  it("inserts a page arriving from another parent", () => {
    expect(placeAt(["a", "b"], "z", { id: "a", side: "after" })).toEqual(["a", "z", "b"]);
  });

  it("appends with no anchor, or when the anchor is gone", () => {
    expect(placeAt(["a", "b"], "z")).toEqual(["a", "b", "z"]);
    expect(placeAt(["a", "b"], "z", { id: "gone", side: "before" })).toEqual(["a", "b", "z"]);
  });
});
