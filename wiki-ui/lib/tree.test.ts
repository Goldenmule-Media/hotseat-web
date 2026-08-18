import { describe, expect, it } from "vitest";
import type { ITreeNode } from "wiki";
import { findNode, parentOptions } from "./tree";

function node(id: string, children: ITreeNode[] = [], extra: Partial<ITreeNode> = {}): ITreeNode {
  return { id, title: id, children, ...extra } as ITreeNode;
}

describe("findNode", () => {
  it("finds the root itself and a deep descendant, and returns null for a miss", () => {
    const root = node("@root", [node("a:1", [node("a:2")])]);
    expect(findNode(root, "@root")?.id).toBe("@root");
    expect(findNode(root, "a:2")?.id).toBe("a:2");
    expect(findNode(root, "a:9")).toBeNull();
    expect(findNode(null, "a:1")).toBeNull();
  });
});

describe("parentOptions", () => {
  it("flattens depth-first with depth counted from the root's children", () => {
    const root = node("@root", [node("a:1", [node("a:2", [node("a:3")])]), node("b:1")]);
    expect(parentOptions(root)).toEqual([
      { id: "a:1", title: "a:1", depth: 0 },
      { id: "a:2", title: "a:2", depth: 1 },
      { id: "a:3", title: "a:3", depth: 2 },
      { id: "b:1", title: "b:1", depth: 0 },
    ]);
  });

  it("prefers displayTitle when the type renders a title template", () => {
    const root = node("@root", [node("adr:1", [], { displayTitle: "ADR-7: Streams" })]);
    expect(parentOptions(root)[0].title).toBe("ADR-7: Streams");
  });

  it("skips an archived page AND its subtree — the engine rejects an archived parent", () => {
    const root = node("@root", [node("a:1", [node("a:2")], { archived: true }), node("b:1")]);
    expect(parentOptions(root).map((o) => o.id)).toEqual(["b:1"]);
  });

  it("returns [] for a null tree or a root with no children", () => {
    expect(parentOptions(null)).toEqual([]);
    expect(parentOptions(node("@root"))).toEqual([]);
  });
});
