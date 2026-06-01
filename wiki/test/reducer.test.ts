/**
 * Workspace reducer unit tests (BUILD_NOTES §9, DESIGN §17).
 *
 * `foldWorkspace` rebuilds `IWorkspaceState` from a hand-built envelope list:
 *   - structural events (WorkspaceCreated / PageCreated / links / item moves) are
 *     folded directly; content events route to the page type's `apply`;
 *   - a non-contiguous `version` throws (fail-fast on a gap);
 *   - a content event written under an OLD `schemaVersion` is upcast before `apply`.
 *
 * Pure: no server, no host clock — envelopes carry their own ids/time/version.
 */
import { describe, expect, it } from "vitest";

import type { DomainEvent, IEventEnvelope, PageId, WorkspaceId } from "../src/api";
import { definePageType, t } from "../src/core/define";
import { Registry } from "../src/core/registry";
import { foldWorkspace } from "../src/core/workspace";
import { zodSchema, z } from "../src/schema/zod-adapter";
import { featurePageTypes } from "../src/pages/feature";

const WS = "ws:test" as WorkspaceId;

/** Build a fully-shaped envelope (api.ts contract) at a given version. */
function env<P>(
  version: number,
  type: string,
  payload: P,
  opts: { pageId?: PageId; schemaVersion?: number } = {},
): IEventEnvelope {
  return {
    eventId: `ev-${version}`,
    streamId: WS,
    ...(opts.pageId !== undefined ? { pageId: opts.pageId } : {}),
    version,
    type,
    schemaVersion: opts.schemaVersion ?? 0,
    payload,
    meta: { occurredAt: `2020-01-01T00:00:0${version}.000Z` },
  };
}

const registry = new Registry(featurePageTypes);

describe("foldWorkspace — fold a hand-built event list to expected state", () => {
  const briefId = "feature-brief:p1" as PageId;

  it("seeds the workspace, builds a page node, and routes content events through apply", () => {
    const events: IEventEnvelope[] = [
      env(0, "WorkspaceCreated", { name: "Acme platform" }),
      env(1, "PageCreated", { type: "feature-brief", parentId: null, title: "Bulk export" }, {
        pageId: briefId,
      }),
      // content events (schemaVersion === page type version === 1)
      env(2, "SummarySet", { text: "Export CSV/JSON." }, { pageId: briefId, schemaVersion: 1 }),
      env(3, "ComponentAdded", { id: "c1", name: "web-app" }, { pageId: briefId, schemaVersion: 1 }),
      env(4, "QuestionAsked", { id: "q1", text: "Which formats?" }, {
        pageId: briefId,
        schemaVersion: 1,
      }),
      env(5, "QuestionAnswered", { id: "q1", answer: "CSV + JSON" }, {
        pageId: briefId,
        schemaVersion: 1,
      }),
      env(6, "PlanningBegan", {}, { pageId: briefId, schemaVersion: 1 }),
    ];

    const state = foldWorkspace(events, registry);

    // Workspace scalars.
    expect(state.id).toBe(WS);
    expect(state.name).toBe("Acme platform");
    expect(state.status).toBe("active");
    // version == event count (head past the last folded version).
    expect(state.version).toBe(7);

    // Tree: the brief sits under @root.
    expect(state.children.get("@root")).toEqual([briefId]);

    // Page node: status advanced via PlanningBegan, fields + items mutated by apply.
    const node = state.pages.get(briefId);
    expect(node).toBeDefined();
    expect(node?.type).toBe("feature-brief");
    expect(node?.status).toBe("planning");
    expect((node?.fields as { summary?: string }).summary).toBe("Export CSV/JSON.");
    expect(node?.items.component).toEqual([{ id: "c1", name: "web-app" }]);
    // The question was asked then answered → resolved with its answer.
    expect(node?.items.question).toEqual([
      { id: "q1", text: "Which formats?", status: "resolved", answer: "CSV + JSON" },
    ]);
    // Declared-but-unused item buckets exist as empty arrays.
    expect(node?.items.constraint).toEqual([]);
    expect(node?.items.commit).toEqual([]);
  });

  it("folds an ItemRemoved/ItemAdded pair as a cross-page move (structural)", () => {
    const planId = "implementation-plan:p2" as PageId;
    const movedQuestion = { id: "q9", text: "Page size?", status: "open" };
    const events: IEventEnvelope[] = [
      env(0, "WorkspaceCreated", { name: "WS" }),
      env(1, "PageCreated", { type: "feature-brief", parentId: null, title: "Brief" }, {
        pageId: briefId,
      }),
      env(2, "PageCreated", { type: "implementation-plan", parentId: briefId, title: "Plan" }, {
        pageId: planId,
      }),
      env(3, "QuestionAsked", { id: "q9", text: "Page size?" }, {
        pageId: briefId,
        schemaVersion: 1,
      }),
      env(4, "ItemRemoved", { itemType: "question", item: movedQuestion }, { pageId: briefId }),
      env(5, "ItemAdded", { itemType: "question", item: movedQuestion }, { pageId: planId }),
    ];

    const state = foldWorkspace(events, registry);
    expect(state.pages.get(briefId)?.items.question).toEqual([]);
    expect(state.pages.get(planId)?.items.question).toEqual([movedQuestion]);
  });

  it("records links on the workspace graph", () => {
    const otherId = "feature-brief:p2" as PageId;
    const events: IEventEnvelope[] = [
      env(0, "WorkspaceCreated", { name: "WS" }),
      env(1, "PageCreated", { type: "feature-brief", parentId: null, title: "A" }, {
        pageId: briefId,
      }),
      env(2, "PageCreated", { type: "feature-brief", parentId: null, title: "B" }, {
        pageId: otherId,
      }),
      env(3, "LinkAdded", { from: briefId, to: otherId, role: "depends-on" }),
    ];
    const state = foldWorkspace(events, registry);
    expect(state.links).toEqual([{ from: briefId, to: otherId, role: "depends-on" }]);
  });
});

describe("foldWorkspace — version contiguity", () => {
  it("throws on a version gap (fail-fast on a missing event)", () => {
    const briefId = "feature-brief:p1" as PageId;
    const events: IEventEnvelope[] = [
      env(0, "WorkspaceCreated", { name: "WS" }),
      env(1, "PageCreated", { type: "feature-brief", parentId: null, title: "Brief" }, {
        pageId: briefId,
      }),
      // jump from 1 to 3 — version 2 is missing.
      env(3, "SummarySet", { text: "x" }, { pageId: briefId, schemaVersion: 1 }),
    ];
    expect(() => foldWorkspace(events, registry)).toThrow(RangeError);
    expect(() => foldWorkspace(events, registry)).toThrow(/expected version 2, saw 3/);
  });

  it("a contiguous list with the SAME events folds without error", () => {
    const briefId = "feature-brief:p1" as PageId;
    const events: IEventEnvelope[] = [
      env(0, "WorkspaceCreated", { name: "WS" }),
      env(1, "PageCreated", { type: "feature-brief", parentId: null, title: "Brief" }, {
        pageId: briefId,
      }),
      env(2, "SummarySet", { text: "x" }, { pageId: briefId, schemaVersion: 1 }),
    ];
    expect(() => foldWorkspace(events, registry)).not.toThrow();
  });
});

describe("foldWorkspace — upcasting (DESIGN §8.5)", () => {
  // A page type at schema version 3 with upcasters that migrate a renamed payload
  // field across two versions: v1 {body} → v2 {text} → v3 {text, migrated:true}.
  const Note = definePageType({
    type: "note",
    initialStatus: "open",
    initialFields: { text: "" } as { text: string; migrated?: boolean },
    version: 3,
    upcasters: {
      1: (payload: unknown) => {
        const p = payload as { body: string };
        return { text: p.body };
      },
      2: (payload: unknown) => {
        const p = payload as { text: string };
        return { text: p.text, migrated: true };
      },
    },
    statusTransitions: [t("open", "setBody", "open")],
    commands: {
      setBody: {
        args: zodSchema(z.object({ text: z.string() })),
        transition: { level: "page", event: "setBody" } as const,
        produces: (_p, args: { text: string }): { events: DomainEvent[]; result: undefined } => ({
          events: [{ type: "BodySet", payload: { text: args.text, migrated: true } }],
          result: undefined,
        }),
      },
    },
    apply: (page, event) => {
      const p = event.payload as { text?: string; migrated?: boolean };
      if (event.type === "BodySet") {
        const f = page.fields as { text: string; migrated?: boolean };
        if (typeof p.text === "string") f.text = p.text;
        if (p.migrated !== undefined) f.migrated = p.migrated;
      }
      return page;
    },
    render: (page) => `note: ${(page.fields as { text: string }).text}`,
  });

  const noteRegistry = new Registry([Note]);
  const noteId = "note:n1" as PageId;

  it("runs the registered upcaster chain on an old-schema content payload before apply", () => {
    const events: IEventEnvelope[] = [
      env(0, "WorkspaceCreated", { name: "WS" }),
      env(1, "PageCreated", { type: "note", parentId: null, title: "N" }, { pageId: noteId }),
      // written under schemaVersion 1 with the OLD field name `body`.
      env(2, "BodySet", { body: "legacy text" }, { pageId: noteId, schemaVersion: 1 }),
    ];

    const state = foldWorkspace(events, noteRegistry);
    const fields = state.pages.get(noteId)?.fields as { text: string; migrated?: boolean };
    // v1 {body:"legacy text"} → v2 {text:"legacy text"} → v3 {text, migrated:true},
    // then apply copies text + migrated onto the node.
    expect(fields.text).toBe("legacy text");
    expect(fields.migrated).toBe(true);
  });

  it("a current-schema payload (schemaVersion === version) bypasses upcasting unchanged", () => {
    const events: IEventEnvelope[] = [
      env(0, "WorkspaceCreated", { name: "WS" }),
      env(1, "PageCreated", { type: "note", parentId: null, title: "N" }, { pageId: noteId }),
      env(2, "BodySet", { text: "fresh", migrated: false }, { pageId: noteId, schemaVersion: 3 }),
    ];
    const state = foldWorkspace(events, noteRegistry);
    const fields = state.pages.get(noteId)?.fields as { text: string; migrated?: boolean };
    expect(fields.text).toBe("fresh");
    expect(fields.migrated).toBe(false);
  });
});
