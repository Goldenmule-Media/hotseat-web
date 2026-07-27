/**
 * The outline projections: a flat ordered section list carrying `depth` scalars IS the
 * heading hierarchy, and every tree question the studio asks is answered by reading the
 * depth run — no parent pointers, no nesting.
 */
import { describe, expect, it } from "vitest";

import type { SectionElementSummary } from "./wiki-host-api";
import {
  ancestorIds,
  canIndent,
  canOutdent,
  depthOf,
  hasChildren,
  hiddenByCollapse,
  siblingMoveTarget,
  slotOf,
  subtreeIds,
} from "./outline";

/** `a0 b1 c2 d1 e0` → five sections at those depths, ids "a".."e". */
function outline(spec: string): SectionElementSummary[] {
  return spec.split(" ").map((tok) => ({
    id: tok.slice(0, -1),
    title: tok.slice(0, -1).toUpperCase(),
    scalars: { depth: Number(tok.slice(-1)) },
  }));
}

describe("depthOf / slotOf", () => {
  it("reads the scalars, defaulting a missing or malformed depth to top level", () => {
    expect(depthOf({ id: "a", scalars: { depth: 2 } })).toBe(2);
    expect(depthOf({ id: "a", scalars: { depth: "1" } })).toBe(1);
    expect(depthOf({ id: "a" })).toBe(0);
    expect(depthOf({ id: "a", scalars: { depth: -3 } })).toBe(0);
    expect(depthOf(undefined)).toBe(0);
    expect(slotOf({ id: "a", scalars: { slot: "overview" } })).toBe("overview");
    expect(slotOf({ id: "a" })).toBe("");
  });
});

describe("subtree / ancestors", () => {
  const els = outline("a0 b1 c2 d1 e0");

  it("takes a section's whole following deeper run as its subtree", () => {
    expect(subtreeIds(els, 0)).toEqual(["a", "b", "c", "d"]);
    expect(subtreeIds(els, 1)).toEqual(["b", "c"]);
    expect(subtreeIds(els, 2)).toEqual(["c"]);
    expect(subtreeIds(els, 4)).toEqual(["e"]);
  });

  it("walks back up the depth run for ancestors, outermost first", () => {
    expect(ancestorIds(els, 2)).toEqual(["a", "b"]);
    expect(ancestorIds(els, 3)).toEqual(["a"]);
    expect(ancestorIds(els, 0)).toEqual([]);
    expect(ancestorIds(els, 4)).toEqual([]);
  });

  it("knows which sections have children", () => {
    expect(els.map((_, i) => hasChildren(els, i))).toEqual([true, true, false, false, false]);
  });
});

describe("indent / outdent legality", () => {
  it("indents only under a section at or below its own level, never the first", () => {
    const els = outline("a0 b0 c1");
    expect(canIndent(els, 0)).toBe(false); // nothing above to nest under
    expect(canIndent(els, 1)).toBe(true);
    // c is already b's child; going deeper would skip a level, since b is only depth 0.
    expect(canIndent(els, 2)).toBe(false);
    // …but with a sibling at its own depth above it, c may nest under that sibling.
    expect(canIndent(outline("a0 b1 c1"), 2)).toBe(true);
  });

  it("refuses to indent a required-slot section — a slot stays top-level", () => {
    const els: SectionElementSummary[] = [
      { id: "a", scalars: { depth: 0 } },
      { id: "b", scalars: { depth: 0, slot: "overview" } },
    ];
    expect(canIndent(els, 1)).toBe(false);
  });

  it("outdents anything below the top level", () => {
    const els = outline("a0 b1");
    expect(canOutdent(els, 0)).toBe(false);
    expect(canOutdent(els, 1)).toBe(true);
  });
});

describe("hiddenByCollapse", () => {
  it("folds away a collapsed section's whole subtree, not just its body", () => {
    const els = outline("a0 b1 c2 d0");
    expect([...hiddenByCollapse(els, new Set(["a"]))].sort()).toEqual(["b", "c"]);
    expect([...hiddenByCollapse(els, new Set(["b"]))]).toEqual(["c"]);
    expect(hiddenByCollapse(els, new Set(["d"])).size).toBe(0);
  });
});

describe("siblingMoveTarget", () => {
  it("moves a section past its previous sibling, subtree and all", () => {
    const els = outline("a0 b1 c0");
    // Move c0 up past a0 (whose subtree is a,b): lifted = [a,b] → land at index 0.
    expect(siblingMoveTarget(els, 2, "up")).toBe(0);
  });

  it("moves a section past the NEXT sibling's whole subtree", () => {
    const els = outline("a0 b0 c1 d0");
    // Move a0 down past b0 (subtree b,c): lifted = [b,c,d] → land before d, index 2.
    expect(siblingMoveTarget(els, 0, "down")).toBe(2);
  });

  it("lands at the end when the next sibling is last", () => {
    const els = outline("a0 b0 c1");
    expect(siblingMoveTarget(els, 0, "down")).toBe(2); // lifted = [b,c] → append
  });

  it("returns null at the edges of a parent's child list", () => {
    const els = outline("a0 b1 c1 d0");
    expect(siblingMoveTarget(els, 1, "up")).toBe(null); // b is a's first child
    expect(siblingMoveTarget(els, 2, "down")).toBe(null); // c is a's last child
    expect(siblingMoveTarget(els, 0, "up")).toBe(null);
    expect(siblingMoveTarget(els, 3, "down")).toBe(null);
  });

  it("keeps a child inside its parent when reordering among siblings", () => {
    const els = outline("a0 b1 c1 d1");
    // Move d1 up past c1: lifted = [a,b,c] → land at c's index (2).
    expect(siblingMoveTarget(els, 3, "up")).toBe(2);
  });
});
