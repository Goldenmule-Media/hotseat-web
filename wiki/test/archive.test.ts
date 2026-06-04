/**
 * Page archival is an orthogonal, reversible VISIBILITY flag — not a lifecycle status.
 *
 * Archiving sets `archived: true` while PRESERVING the page's `status`, and freezes
 * structural mutation; unarchiving clears the flag and restores mutability. This guards
 * the engine change that split visibility from the status FSM — previously `archivePage`
 * overwrote `status = "archived"`, a one-way door that destroyed the lifecycle state.
 *
 * Pure: no server. Handlers are called directly over a folded state (cf. structure.test.ts).
 */
import { describe, expect, it } from "vitest";

import type { IEventEnvelope, IWorkspaceState, PageId, WorkspaceId } from "../src/api";
import { InvariantViolationError, ParentNotFoundError } from "../src/core/errors";
import { Registry } from "../src/core/registry";
import { archivePage, createPage, reparent, setPageTitle, unarchivePage } from "../src/core/structure";
import type { Services } from "../src/core/types";
import { foldWorkspace } from "../src/core/workspace";
import { featurePageTypes } from "wiki-models/feature";

const WS = "ws:test" as WorkspaceId;
const registry = new Registry(featurePageTypes);
const briefId = "feature-brief:b" as PageId;
const planId = "implementation-plan:p" as PageId;

function makeServices(): Services {
  let n = 0;
  return { now: () => "2020-01-01T00:00:00.000Z", newId: () => `id-${++n}` };
}

function env<P>(version: number, type: string, payload: P, pageId?: PageId): IEventEnvelope {
  return {
    eventId: `ev-${version}`,
    streamId: WS,
    ...(pageId !== undefined ? { pageId } : {}),
    version,
    type,
    schemaVersion: 0,
    payload,
    meta: { occurredAt: "2020-01-01T00:00:00.000Z" },
  };
}

/** Base events: a workspace with a standalone feature-brief and one pinned plan child. */
function baseEvents(): IEventEnvelope[] {
  return [
    env(0, "WorkspaceCreated", { name: "WS" }),
    env(1, "PageCreated", { type: "feature-brief", parentId: null, title: "Brief" }, briefId),
    env(
      2,
      "PageCreated",
      { type: "implementation-plan", parentId: briefId, title: "Plan", pinned: true },
      planId,
    ),
  ];
}
const fold = (extra: IEventEnvelope[] = []): IWorkspaceState =>
  foldWorkspace([...baseEvents(), ...extra], registry);

const archiveEvent = (v: number, id: PageId): IEventEnvelope => env(v, "PageArchived", { pageId: id }, id);
const unarchiveEvent = (v: number, id: PageId): IEventEnvelope =>
  env(v, "PageUnarchived", { pageId: id }, id);

describe("archivePage — orthogonal, reversible visibility flag", () => {
  it("emits a single PageArchived event for the target", () => {
    const { events } = archivePage(fold(), { pageId: briefId }, makeServices(), registry);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("PageArchived");
    expect(events[0].payload).toMatchObject({ pageId: briefId });
  });

  it('sets `archived` while PRESERVING `status` (never overwrites it with "archived")', () => {
    const before = fold().pages.get(briefId)?.status;
    const node = fold([archiveEvent(3, briefId)]).pages.get(briefId);
    expect(node?.archived).toBe(true);
    expect(node?.status).toBe(before);
    expect(node?.status).not.toBe("archived");
  });

  it("freezes structural mutation while archived", () => {
    const state = fold([archiveEvent(3, briefId)]);
    expect(() =>
      setPageTitle(state, { pageId: briefId, title: "Renamed" }, makeServices(), registry),
    ).toThrow(InvariantViolationError);
  });

  it("refuses to archive a pinned child alone", () => {
    expect(() => archivePage(fold(), { pageId: planId }, makeServices(), registry)).toThrow(
      InvariantViolationError,
    );
  });

  it("is idempotent on an already-archived page (no events)", () => {
    const state = fold([archiveEvent(3, briefId)]);
    const { events } = archivePage(state, { pageId: briefId }, makeServices(), registry);
    expect(events).toHaveLength(0);
  });

  it("blocks creating a child under an archived page", () => {
    const state = fold([archiveEvent(3, briefId)]);
    expect(() =>
      createPage(state, { type: "testing-plan", title: "Late", parentId: briefId }, makeServices(), registry),
    ).toThrow(ParentNotFoundError);
  });

  it("blocks reparenting a page into an archived page", () => {
    const moverId = "testing-plan:m" as PageId;
    const state = fold([
      env(3, "PageCreated", { type: "testing-plan", parentId: null, title: "Mover" }, moverId),
      archiveEvent(4, briefId),
    ]);
    expect(() =>
      reparent(state, { pageId: moverId, newParentId: briefId }, makeServices(), registry),
    ).toThrow(ParentNotFoundError);
  });
});

describe("unarchivePage — restores visibility and mutability", () => {
  it("clears `archived`, leaves `status` intact, and re-enables mutation", () => {
    const before = fold().pages.get(briefId)?.status;
    const state = fold([archiveEvent(3, briefId), unarchiveEvent(4, briefId)]);
    const node = state.pages.get(briefId);
    expect(node?.archived).toBeFalsy();
    expect(node?.status).toBe(before);
    const { events } = setPageTitle(
      state,
      { pageId: briefId, title: "Renamed" },
      makeServices(),
      registry,
    );
    expect(events[0].type).toBe("PageTitleSet");
  });

  it("is idempotent on a page that is not archived (no events)", () => {
    const { events } = unarchivePage(fold(), { pageId: briefId }, makeServices(), registry);
    expect(events).toHaveLength(0);
  });
});
