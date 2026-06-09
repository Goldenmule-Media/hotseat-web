/**
 * Structural handler / invariant unit tests.
 *
 * The structure handlers are PURE functions over a folded `IWorkspaceState`, parsed
 * args, injected `services`, and the `registry`; they return the `DomainEvent`s the
 * bus will commit (or throw a typed invariant error). Tests fold a base state, then
 * call handlers directly and assert events / errors:
 *   - reparent cycle rejection + parent-exists,
 *   - duplicate sibling title (createPage / setPageTitle),
 *   - link-target integrity,
 *   - moveItem atomicity (both events, or — on a miss — neither).
 *
 * Pure: no server. A deterministic `services` stub supplies ids/time.
 */
import { describe, expect, it } from "vitest";

import type {
  DomainEvent,
  IEventEnvelope,
  IWorkspaceState,
  PageId,
  WorkspaceId,
} from "../src/api";
import {
  CycleError,
  DuplicateRequiredChildError,
  DuplicateTitleError,
  InvariantViolationError,
  ItemNotFoundError,
  LinkTargetNotFoundError,
  ParentNotFoundError,
} from "../src/core/errors";
import { Registry } from "../src/core/registry";
import {
  createPage,
  link,
  moveItem,
  reparent,
  setPageTitle,
} from "../src/core/structure";
import type { Services } from "../src/core/types";
import { applyWorkspace, foldWorkspace } from "../src/core/workspace";
import { featurePageTypes } from "wiki-models/feature";

const WS = "ws:test" as WorkspaceId;
const registry = new Registry(featurePageTypes);

/** Deterministic services for the handlers (ids: id-1, id-2, …; fixed clock). */
function makeServices(): Services {
  let n = 0;
  return {
    now: () => "2020-01-01T00:00:00.000Z",
    newId: () => `id-${++n}`,
  };
}

function env<P>(
  version: number,
  type: string,
  payload: P,
  pageId?: PageId,
  schemaVersion = 0,
): IEventEnvelope {
  return {
    eventId: `ev-${version}`,
    streamId: WS,
    ...(pageId !== undefined ? { pageId } : {}),
    version,
    type,
    schemaVersion,
    payload,
    meta: { occurredAt: "2020-01-01T00:00:00.000Z" },
  };
}

/** A workspace with: parent (feature-brief) > child (implementation-plan), and a sibling brief. */
const parentId = "feature-brief:parent" as PageId;
const childId = "implementation-plan:child" as PageId;
const siblingId = "feature-brief:sibling" as PageId;

function baseState(): IWorkspaceState {
  const events: IEventEnvelope[] = [
    env(0, "WorkspaceCreated", { name: "WS" }),
    env(1, "PageCreated", { type: "feature-brief", parentId: null, title: "Parent" }, parentId),
    env(
      2,
      "PageCreated",
      { type: "implementation-plan", parentId, title: "Child" },
      childId,
    ),
    env(3, "PageCreated", { type: "feature-brief", parentId: null, title: "Sibling" }, siblingId),
  ];
  return foldWorkspace(events, registry);
}

describe("createPage — parent existence + unique sibling title", () => {
  it("emits a single PageCreated for a leaf type and returns the new id as result", () => {
    const state = baseState();
    const { events, result } = createPage(
      state,
      { type: "testing-plan", title: "Standalone tests", parentId: null },
      makeServices(),
      registry,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("PageCreated");
    expect(events[0].payload).toMatchObject({ type: "testing-plan", parentId: null });
    expect(result).toBe("testing-plan:id-1");
  });

  it("emits the page + ALL required children atomically (one commit), pinned", () => {
    const state = baseState();
    const { events } = createPage(
      state,
      { type: "feature-brief", title: "New feature", parentId: null },
      makeServices(),
      registry,
    );
    // 1 brief + 3 mandated children = 4 PageCreated events.
    expect(events).toHaveLength(4);
    expect(events.every((e) => e.type === "PageCreated")).toBe(true);
    const types = events.map((e) => (e.payload as { type: string }).type);
    expect(types).toEqual([
      "feature-brief",
      "implementation-plan",
      "testing-plan",
      "feature-spec",
    ]);
    // The three children are pinned and parented under the new brief.
    const briefId = events[0].pageId;
    for (const child of events.slice(1)) {
      expect((child.payload as { pinned?: boolean }).pinned).toBe(true);
      expect((child.payload as { parentId?: string }).parentId).toBe(briefId);
    }
  });

  it("rejects a duplicate sibling title", () => {
    const state = baseState();
    // "Parent" already exists under @root.
    expect(() =>
      createPage(
        state,
        { type: "feature-brief", title: "Parent", parentId: null },
        makeServices(),
        registry,
      ),
    ).toThrow(DuplicateTitleError);
  });

  it("rejects a missing parent", () => {
    const state = baseState();
    expect(() =>
      createPage(
        state,
        { type: "feature-brief", title: "Orphan", parentId: "feature-brief:ghost" as PageId },
        makeServices(),
        registry,
      ),
    ).toThrow(/does not exist/);
  });

  it("rejects an unknown page type", () => {
    const state = baseState();
    expect(() =>
      createPage(
        state,
        { type: "not-a-type", title: "X", parentId: null },
        makeServices(),
        registry,
      ),
    ).toThrow(InvariantViolationError);
  });

  it("rejects re-creating one of the parent type's required children, naming the existing one", () => {
    const state = baseState();
    // feature-brief:parent already has its implementation-plan child (an auto-materialized
    // required child of feature-brief). A manual second one would be an unmanaged duplicate.
    let err: unknown;
    try {
      createPage(
        state,
        { type: "implementation-plan", title: "Duplicate plan", parentId },
        makeServices(),
        registry,
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DuplicateRequiredChildError);
    expect((err as DuplicateRequiredChildError).existingId).toBe(childId);
    expect((err as DuplicateRequiredChildError).childType).toBe("implementation-plan");
  });

  it("still allows a non-required child type under a parent that declares required children", () => {
    const state = baseState();
    // testing-plan IS a required child of feature-brief and already exists? No — baseState's
    // parent only has an implementation-plan child, so a testing-plan is a fresh required child
    // and is allowed (there isn't already one). It must NOT trip the duplicate guard.
    const { events } = createPage(
      state,
      { type: "testing-plan", title: "Plan tests", parentId },
      makeServices(),
      registry,
    );
    expect(events[0].type).toBe("PageCreated");
  });

  it("allows re-creating a required child when the only existing one is ARCHIVED (recovery)", () => {
    // An archived child no longer satisfies the parent's required-child contract, so the guard
    // must let a fresh active one be created rather than dead-ending on the archived duplicate.
    const state = foldWorkspace(
      [
        env(0, "WorkspaceCreated", { name: "WS" }),
        env(1, "PageCreated", { type: "feature-brief", parentId: null, title: "Parent" }, parentId),
        env(2, "PageCreated", { type: "implementation-plan", parentId, title: "Child" }, childId),
        env(3, "PageArchived", { pageId: childId }, childId),
      ],
      registry,
    );
    const { events } = createPage(
      state,
      { type: "implementation-plan", title: "Fresh plan", parentId },
      makeServices(),
      registry,
    );
    expect(events[0].type).toBe("PageCreated");
  });
});

describe("DuplicateTitleError — names the conflict and discloses archived siblings", () => {
  // Two root siblings, one of them archived — its title is still reserved.
  function stateWithArchivedSibling(): IWorkspaceState {
    const events: IEventEnvelope[] = [
      env(0, "WorkspaceCreated", { name: "WS" }),
      env(1, "PageCreated", { type: "feature-brief", parentId: null, title: "Parent" }, parentId),
      env(2, "PageCreated", { type: "feature-brief", parentId: null, title: "Sibling" }, siblingId),
      env(3, "PageArchived", { pageId: siblingId }, siblingId),
    ];
    return foldWorkspace(events, registry);
  }

  it("flags conflictArchived + names the sibling when the clash is an ARCHIVED page", () => {
    // Renaming the active "Parent" to "Sibling" collides with the archived "Sibling".
    let err: unknown;
    try {
      setPageTitle(stateWithArchivedSibling(), { pageId: parentId, title: "Sibling" }, makeServices(), registry);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DuplicateTitleError);
    const dup = err as DuplicateTitleError;
    expect(dup.conflictId).toBe(siblingId);
    expect(dup.conflictArchived).toBe(true);
    expect(dup.message).toMatch(/archived/i);
  });

  it("does NOT flag archived for an active clash, but still names the sibling", () => {
    // baseState has active "Parent" and active "Sibling" at root.
    let err: unknown;
    try {
      setPageTitle(baseState(), { pageId: parentId, title: "Sibling" }, makeServices(), registry);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DuplicateTitleError);
    expect((err as DuplicateTitleError).conflictArchived).toBe(false);
    expect((err as DuplicateTitleError).conflictId).toBe(siblingId);
  });
});

describe("reparent — cycle rejection + parent existence + pinned guard", () => {
  it("rejects reparenting a page under its own descendant (cycle)", () => {
    const state = baseState();
    // child is a descendant of parent; making parent a child of child cycles.
    expect(() =>
      reparent(state, { pageId: parentId, newParentId: childId }, makeServices(), registry),
    ).toThrow(CycleError);
  });

  it("rejects reparenting a page under itself (degenerate cycle)", () => {
    const state = baseState();
    expect(() =>
      reparent(state, { pageId: parentId, newParentId: parentId }, makeServices(), registry),
    ).toThrow(CycleError);
  });

  it("rejects reparenting under a non-existent parent", () => {
    const state = baseState();
    expect(() =>
      reparent(
        state,
        { pageId: siblingId, newParentId: "feature-brief:ghost" as PageId },
        makeServices(),
        registry,
      ),
    ).toThrow(ParentNotFoundError);
  });

  it("rejects reparenting a pinned page out of its owner", () => {
    const state = baseState();
    // The implementation-plan auto-created child of a brief is pinned; create one.
    const created = createPage(
      state,
      { type: "feature-brief", title: "Owner", parentId: null },
      makeServices(),
      registry,
    );
    // Fold those events in so the pinned children exist in state.
    let v = state.version;
    for (const e of created.events) {
      foldOne(state, e, v++);
    }
    const ownerBrief = created.events[0].pageId as PageId;
    const pinnedPlan = created.events[1].pageId as PageId;
    expect(state.pages.get(pinnedPlan)?.pinned).toBe(true);

    expect(() =>
      reparent(state, { pageId: pinnedPlan, newParentId: ownerBrief }, makeServices(), registry),
    ).not.toThrow(); // same owner is fine

    expect(() =>
      reparent(state, { pageId: pinnedPlan, newParentId: null }, makeServices(), registry),
    ).toThrow(InvariantViolationError);
  });

  it("permits a legal reparent and emits PageReparented", () => {
    const state = baseState();
    // Move the sibling under the parent (no cycle, parent exists, not pinned).
    const { events } = reparent(
      state,
      { pageId: siblingId, newParentId: parentId },
      makeServices(),
      registry,
    );
    expect(events[0].type).toBe("PageReparented");
    expect(events[0].payload).toMatchObject({
      pageId: siblingId,
      oldParentId: null,
      newParentId: parentId,
    });
  });
});

describe("setPageTitle — unique among siblings", () => {
  it("rejects renaming a page to a title already used by a sibling", () => {
    const state = baseState();
    // "Sibling" and "Parent" are both under @root.
    expect(() =>
      setPageTitle(state, { pageId: siblingId, title: "Parent" }, makeServices(), registry),
    ).toThrow(DuplicateTitleError);
  });

  it("permits a unique rename (and ignores the page's own current title)", () => {
    const state = baseState();
    const { events } = setPageTitle(
      state,
      { pageId: siblingId, title: "Sibling" },
      makeServices(),
      registry,
    );
    expect(events[0].type).toBe("PageTitleSet");
    expect(events[0].payload).toMatchObject({ pageId: siblingId, title: "Sibling" });
  });
});

describe("link — endpoint integrity", () => {
  it("rejects a link whose target page does not exist", () => {
    const state = baseState();
    expect(() =>
      link(
        state,
        { from: parentId, to: "feature-brief:ghost" as PageId, role: "depends-on" },
        makeServices(),
        registry,
      ),
    ).toThrow(LinkTargetNotFoundError);
  });

  it("rejects a link whose source page does not exist", () => {
    const state = baseState();
    expect(() =>
      link(
        state,
        { from: "feature-brief:ghost" as PageId, to: parentId, role: "depends-on" },
        makeServices(),
        registry,
      ),
    ).toThrow(LinkTargetNotFoundError);
  });

  it("emits LinkAdded when both endpoints exist", () => {
    const state = baseState();
    const { events } = link(
      state,
      { from: parentId, to: siblingId, role: "depends-on" },
      makeServices(),
      registry,
    );
    expect(events[0].type).toBe("LinkAdded");
    expect(events[0].payload).toEqual({ from: parentId, to: siblingId, role: "depends-on" });
  });
});

describe("moveItem — cross-page list-element move (both events or neither)", () => {
  /** A state where the parent brief owns one open question (a `questions` list element). */
  function stateWithQuestion(): IWorkspaceState {
    const state = baseState();
    foldOne(
      state,
      {
        type: "SectionOpsApplied",
        pageId: parentId,
        payload: { ops: [{ op: "addElement", section: "questions", field: "items", id: "q1", status: "open", fields: { text: { kind: "prose", value: "Page size?" } } }] },
      },
      state.version,
    );
    return state;
  }

  it("emits BOTH SectionOpsApplied(remove on from) and SectionOpsApplied(add on to) in one batch", () => {
    const state = stateWithQuestion();
    const { events } = moveItem(
      state,
      { from: parentId, to: childId, section: "questions", field: "items", itemId: "q1" },
      makeServices(),
      registry,
    );
    expect(events).toHaveLength(2);
    const [removed, added] = events;
    expect(removed.type).toBe("SectionOpsApplied");
    expect(removed.pageId).toBe(parentId);
    expect(added.type).toBe("SectionOpsApplied");
    expect(added.pageId).toBe(childId);
    expect((removed.payload as { ops: { op: string }[] }).ops[0]!.op).toBe("removeElement");
    expect((added.payload as { ops: { op: string; status?: string }[] }).ops[0]!.op).toBe("addElement");
    expect((added.payload as { ops: { status?: string }[] }).ops[0]!.status).toBe("open");
  });

  it("emits NEITHER event when the element is missing (throws, no partial move)", () => {
    const state = stateWithQuestion();
    let events: IEventEnvelope[] | undefined;
    expect(() => {
      const out = moveItem(
        state,
        { from: parentId, to: childId, section: "questions", field: "items", itemId: "nope" },
        makeServices(),
        registry,
      );
      events = out.events as IEventEnvelope[];
    }).toThrow(ItemNotFoundError);
    expect(events).toBeUndefined();
  });

  it("rejects moving an element from a non-existent source page", () => {
    const state = stateWithQuestion();
    expect(() =>
      moveItem(
        state,
        { from: "feature-brief:ghost" as PageId, to: childId, section: "questions", field: "items", itemId: "q1" },
        makeServices(),
        registry,
      ),
    ).toThrow(/does not exist/);
  });
});

// ── helper: envelope + fold a single lightweight DomainEvent into state ──────────
function foldOne(state: IWorkspaceState, e: DomainEvent, version: number): void {
  const enveloped: IEventEnvelope = {
    eventId: `ev-${version}`,
    streamId: WS,
    ...(e.pageId !== undefined ? { pageId: e.pageId } : {}),
    version,
    type: e.type,
    // content events that route to a page need the page type's current schema version;
    // the feature page types here are all at version 1.
    schemaVersion: 1,
    payload: e.payload,
    meta: { occurredAt: "2020-01-01T00:00:00.000Z" },
  };
  applyWorkspace(state, enveloped, registry);
  state.version = enveloped.version + 1;
}
