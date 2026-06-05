/**
 * {@link affectedPageIds} — the steady-state delta set the search index re-renders for a
 * commit. A page's render embeds its CHILDREN's titles (child list) and its outgoing-link
 * targets (references), so a STRUCTURAL change (title/place-in-tree) must ripple to those
 * render-dependents, while a pure content edit and a link change must NOT over-sweep.
 *
 * These assertions pin the EXACT ripple set, independent of which events happen to exist —
 * the companion to the compile-time `never`-guard in `affectedPageIds` (a new structural
 * event type fails `tsc` until classified, rather than silently under-indexing).
 */
import { describe, expect, it } from "vitest";

import { affectedPageIds, renderSearchDocs } from "../src/search";
import { Registry } from "../src/core/registry";
import type { IEventEnvelope, IPageNode, IWorkspaceState, PageId, WorkspaceId, WorkspaceStatus } from "../src/api";

/** A synthetic envelope — affectedPageIds reads only `type`/`pageId`/`payload`. */
const ev = (type: string, pageId: string, payload: Record<string, unknown> = {}): IEventEnvelope =>
  ({ type, pageId, payload }) as unknown as IEventEnvelope;

const node = (id: string, parentId: string | null): IPageNode => ({
  id: id as PageId,
  type: "note",
  parentId: parentId as PageId | null,
  title: id,
  status: "draft",
  sections: [],
  createdAt: "",
  updatedAt: "",
});

const stateOf = (
  nodes: IPageNode[],
  links: { from: string; to: string; role: string }[],
  version: number,
): IWorkspaceState => ({
  id: "ws" as WorkspaceId,
  name: "WS",
  status: "active" as WorkspaceStatus,
  pages: new Map(nodes.map((n) => [n.id, n])),
  children: new Map(),
  links: links.map((l) => ({ from: l.from as PageId, to: l.to as PageId, role: l.role })),
  version,
});

describe("affectedPageIds — render-dependent ripple", () => {
  it("a title change ripples to the parent (child list) and to backlinkers (references)", () => {
    // P → C (child); Q links to C. Renaming C changes C's title everywhere it is embedded.
    const st = stateOf(
      [node("P", null), node("C", "P"), node("Q", null)],
      [{ from: "Q", to: "C", role: "ref" }],
      10,
    );
    const affected = affectedPageIds([ev("PageTitleSet", "C", { pageId: "C", title: "new" })], st);
    expect([...affected].sort()).toEqual(["C", "P", "Q"]);
  });

  it("a link change ripples ONLY to its endpoints — NOT to their parents/backlinkers", () => {
    // Preserves today's behavior: a LinkAdded re-renders from/to but is NOT structural, so
    // A's parent P is left untouched (the `structural ||= isStructuralEvent` shortcut would
    // have wrongly swept P in).
    const st = stateOf([node("P", null), node("A", "P"), node("B", null)], [], 10);
    const affected = affectedPageIds([ev("LinkAdded", "A", { from: "A", to: "B" })], st);
    expect([...affected].sort()).toEqual(["A", "B"]);
  });

  it("a pure content edit ripples to nobody but the edited page (O(1))", () => {
    const st = stateOf([node("P", null), node("C", "P")], [], 10);
    const affected = affectedPageIds([ev("SectionOpsApplied", "C", {})], st);
    expect([...affected]).toEqual(["C"]);
  });

  it("a reparent ripples to both the old and the new parent (both child lists change)", () => {
    const st = stateOf([node("OLD", null), node("NEW", null), node("C", "NEW")], [], 10);
    const affected = affectedPageIds(
      [ev("PageReparented", "C", { pageId: "C", oldParentId: "OLD", newParentId: "NEW" })],
      st,
    );
    expect([...affected].sort()).toEqual(["C", "NEW", "OLD"]);
  });
});

describe("renderSearchDocs — onRenderError hook (F5)", () => {
  // An empty registry has no "note" page type, so renderPage throws for the page below.
  const emptyRegistry = new Registry([]);

  it("fires the hook and indexes an EMPTY body when a page fails to render", () => {
    const st = stateOf([node("C", null)], [], 1);
    const failures: string[] = [];
    const docs = renderSearchDocs(st, emptyRegistry, { onRenderError: (id) => failures.push(id) });
    expect(failures).toEqual(["C"]); // the failure is surfaced, not silently swallowed
    expect(docs).toHaveLength(1); // the page is still indexed…
    expect(docs[0].pageId).toBe("C");
    expect(docs[0].body).toBe(""); // …with an empty body (drops from search until next render)
  });

  it("swallows a THROWING hook so indexing is never aborted", () => {
    const st = stateOf([node("C", null)], [], 1);
    expect(() =>
      renderSearchDocs(st, emptyRegistry, {
        onRenderError: () => {
          throw new Error("hook boom");
        },
      }),
    ).not.toThrow();
  });
});
