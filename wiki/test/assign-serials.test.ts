/**
 * `assignSerials` — the schema-evolution backfill for the `serial` field kind. When a serial
 * field is added to a page type that ALREADY has pages, those pages' `PageCreated` carried no
 * minted value, so the field materializes to the placeholder 0. `assignSerials` fills the unset
 * pages — per type, in creation (id) order — with the next value after the current max, in one
 * atomic commit, and never touches an already-assigned serial.
 *
 * The from-zero case is tested at the handler level (over a hand-folded state), because the
 * normal `createPage` path now always mints a serial and so can't produce a 0. Idempotency +
 * immutability are tested end-to-end through the workspace handle.
 */
import { describe, expect, it } from "vitest";

import { adrPageTypes } from "wiki-models/adr";
import { Toc } from "wiki-models/toc";
import type { DomainEvent, IEventEnvelope, ISection, PageId, SectionOp, WorkspaceId } from "../src/api";
import { definePageType } from "../src/core/define";
import { Registry } from "../src/core/registry";
import { assignSerials } from "../src/core/structure";
import { foldWorkspace } from "../src/core/workspace";
import { createTestWiki } from "../src/testing";

const WS = "ws:test" as WorkspaceId;

function env<P>(version: number, type: string, payload: P, pageId?: PageId): IEventEnvelope {
  return {
    eventId: `ev-${version}`,
    streamId: WS,
    ...(pageId !== undefined ? { pageId } : {}),
    version,
    type,
    schemaVersion: 0,
    payload,
    meta: { occurredAt: `2020-01-01T00:00:0${version}.000Z` },
  };
}

/** A minimal serial-bearing type, with NO serial in its creation events (i.e. pre-migration). */
const Thing = definePageType({
  type: "thing",
  version: 1,
  initialStatus: "open",
  statusTransitions: [],
  sections: {
    meta: { name: "Meta", required: true, mutableIn: ["open"], fields: { number: { kind: "serial" } } },
  },
  commands: {},
  render: { title: "T-{meta.number}: {title}", sections: [] },
});

const numberOf = (node: { sections: ISection[] }): number => {
  const f = node.sections.find((s) => s.key === "meta")?.fields["number"];
  return f !== undefined && f.kind === "scalar" && typeof f.value === "number" ? f.value : -1;
};

describe("assignSerials — backfill onto pages that predate the serial field", () => {
  const registry = new Registry([Thing]);
  // Three pages created WITHOUT serials → each materializes meta.number = 0 (the placeholder).
  const ids = ["thing:p1", "thing:p2", "thing:p3"] as PageId[];
  const base: IEventEnvelope[] = [
    env(0, "WorkspaceCreated", { name: "W" }),
    env(1, "PageCreated", { type: "thing", parentId: null, title: "A" }, ids[0]),
    env(2, "PageCreated", { type: "thing", parentId: null, title: "B" }, ids[1]),
    env(3, "PageCreated", { type: "thing", parentId: null, title: "C" }, ids[2]),
  ];

  it("starts every pre-existing page at the placeholder 0", () => {
    const state = foldWorkspace(base, registry);
    expect(ids.map((id) => numberOf(state.pages.get(id)!))).toEqual([0, 0, 0]);
  });

  it("assigns 1,2,3 in creation (id) order, one setField op per page", () => {
    const state = foldWorkspace(base, registry);
    const { events } = assignSerials(state, {}, {} as never, registry);
    // One SectionOpsApplied per unset page, in id order, carrying a scalar serial.
    expect(events.map((e: DomainEvent) => e.pageId)).toEqual(ids);
    const assigned = events.map((e: DomainEvent) => {
      const op = (e.payload as { ops: SectionOp[] }).ops[0];
      return op.op === "setField" && op.value.kind === "scalar" ? op.value.value : null;
    });
    expect(assigned).toEqual([1, 2, 3]);
  });

  it("is idempotent — re-running over already-assigned pages emits nothing", () => {
    // Fold the backfill in, then run again: no page is unset, so no events.
    const state = foldWorkspace(base, registry);
    const backfill = assignSerials(state, {}, {} as never, registry).events.map((e, i) =>
      env(4 + i, e.type, e.payload, e.pageId),
    );
    const settled = foldWorkspace([...base, ...backfill], registry);
    expect(ids.map((id) => numberOf(settled.pages.get(id)!))).toEqual([1, 2, 3]);
    expect(assignSerials(settled, {}, {} as never, registry).events).toEqual([]);
  });
});

describe("assignSerials — immutability through the workspace handle", () => {
  it("never renumbers already-assigned ADRs (a no-op when nothing is unset)", async () => {
    const harness = await createTestWiki([...adrPageTypes, Toc]);
    try {
      const ws = await harness.wiki.createWorkspace({ name: "ADRs" });
      const toc = (await ws.createPage("toc", { title: "Decision Records", parentId: null })).value;
      const a = (await ws.createPage("decision-record", { title: "first", parentId: toc })).value;
      const b = (await ws.createPage("decision-record", { title: "second", parentId: toc })).value;
      const h1 = async (id: PageId): Promise<string> => (await ws.toMarkdown(id)).split("\n", 1)[0];
      expect(await h1(a)).toBe("# ADR-1: first");
      expect(await h1(b)).toBe("# ADR-2: second");

      await ws.assignSerials(); // every serial is already set → must change nothing

      expect(await h1(a)).toBe("# ADR-1: first");
      expect(await h1(b)).toBe("# ADR-2: second");
    } finally {
      await harness.stop();
    }
  });
});
