/**
 * Workspace reducer unit tests (new section content model).
 *
 * `foldWorkspace` rebuilds `IWorkspaceState` from a hand-built envelope list:
 *   - structural events (WorkspaceCreated / PageCreated / links) are folded directly;
 *   - content commits ride one `SectionOpsApplied` event carrying a `SectionOp[]`,
 *     folded by the one built-in reducer;
 *   - a non-contiguous `version` throws (fail-fast on a gap);
 *   - a content payload under an OLD `schemaVersion` is upcast before the fold.
 *
 * Pure: no server, no host clock — envelopes carry their own ids/time/version.
 */
import { describe, expect, it } from "vitest";

import type { IEventEnvelope, IField, IItem, ISection, PageId, SectionOp, WorkspaceId } from "../src/api";
import { definePageType, t, arg } from "../src/core/define";
import { Registry } from "../src/core/registry";
import { foldWorkspace } from "../src/core/workspace";
import { zodSchema, z } from "../src/schema/zod-adapter";
import { featurePageTypes } from "wiki-models/feature";

const WS = "ws:test" as WorkspaceId;

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

function ops(version: number, pageId: PageId, list: SectionOp[]): IEventEnvelope {
  return env(version, "SectionOpsApplied", { ops: list }, { pageId, schemaVersion: 1 });
}

const registry = new Registry(featurePageTypes);

function sectionByKey(node: { sections: ISection[] }, key: string): ISection | undefined {
  return node.sections.find((s) => s.key === key);
}
function listElements(node: { sections: ISection[] }, key: string, field = "items"): IItem[] {
  const f: IField | undefined = sectionByKey(node, key)?.fields[field];
  return f !== undefined && f.kind === "list" ? f.elements : [];
}

describe("foldWorkspace — fold a hand-built event list to expected state", () => {
  const briefId = "feature-brief:p1" as PageId;

  it("seeds the workspace, builds a page node, and folds section ops", () => {
    const events: IEventEnvelope[] = [
      env(0, "WorkspaceCreated", { name: "Acme platform" }),
      env(1, "PageCreated", { type: "feature-brief", parentId: null, title: "Bulk export" }, { pageId: briefId }),
      ops(2, briefId, [{ op: "setField", section: "summary", field: "body", value: { kind: "prose", value: "Export CSV/JSON." } }]),
      ops(3, briefId, [{ op: "addElement", section: "components", field: "items", id: "c1", fields: { name: { kind: "scalar", value: "web-app" } } }]),
      ops(4, briefId, [{ op: "addElement", section: "questions", field: "items", id: "q1", status: "open", fields: { text: { kind: "prose", value: "Which formats?" } } }]),
      ops(5, briefId, [
        { op: "setElementField", section: "questions", field: "items", id: "q1", elementField: "answer", value: { kind: "prose", value: "CSV + JSON" } },
        { op: "transition", level: "element", section: "questions", element: "q1", event: "answer" },
      ]),
      ops(6, briefId, [{ op: "transition", level: "page", event: "beginPlanning" }]),
    ];

    const state = foldWorkspace(events, registry);

    expect(state.id).toBe(WS);
    expect(state.name).toBe("Acme platform");
    expect(state.status).toBe("active");
    expect(state.version).toBe(7);
    expect(state.children.get("@root")).toEqual([briefId]);

    const node = state.pages.get(briefId)!;
    expect(node.type).toBe("feature-brief");
    expect(node.status).toBe("planning");
    const summary = sectionByKey(node, "summary")!.fields.body;
    expect(summary).toEqual({ kind: "prose", value: "Export CSV/JSON." });
    expect(listElements(node, "components")).toEqual([{ id: "c1", fields: { name: { kind: "scalar", value: "web-app" } } }]);
    expect(listElements(node, "questions")).toEqual([
      { id: "q1", status: "resolved", fields: { text: { kind: "prose", value: "Which formats?" }, answer: { kind: "prose", value: "CSV + JSON" } } },
    ]);
    // Required-but-empty sections exist with empty lists.
    expect(listElements(node, "constraints")).toEqual([]);
    expect(listElements(node, "commits")).toEqual([]);
  });

  it("folds a removeElement/addElement pair as a cross-page move", () => {
    const planId = "implementation-plan:p2" as PageId;
    const events: IEventEnvelope[] = [
      env(0, "WorkspaceCreated", { name: "WS" }),
      env(1, "PageCreated", { type: "feature-brief", parentId: null, title: "Brief" }, { pageId: briefId }),
      env(2, "PageCreated", { type: "implementation-plan", parentId: briefId, title: "Plan" }, { pageId: planId }),
      ops(3, briefId, [{ op: "addElement", section: "questions", field: "items", id: "q9", status: "open", fields: { text: { kind: "prose", value: "Page size?" } } }]),
      ops(4, briefId, [{ op: "removeElement", section: "questions", field: "items", id: "q9" }]),
      ops(5, planId, [{ op: "addElement", section: "questions", field: "items", id: "q9", status: "open", fields: { text: { kind: "prose", value: "Page size?" } } }]),
    ];

    const state = foldWorkspace(events, registry);
    expect(listElements(state.pages.get(briefId)!, "questions")).toEqual([]);
    expect(listElements(state.pages.get(planId)!, "questions")).toEqual([
      { id: "q9", status: "open", fields: { text: { kind: "prose", value: "Page size?" } } },
    ]);
  });

  it("records links on the workspace graph", () => {
    const otherId = "feature-brief:p2" as PageId;
    const events: IEventEnvelope[] = [
      env(0, "WorkspaceCreated", { name: "WS" }),
      env(1, "PageCreated", { type: "feature-brief", parentId: null, title: "A" }, { pageId: briefId }),
      env(2, "PageCreated", { type: "feature-brief", parentId: null, title: "B" }, { pageId: otherId }),
      env(3, "LinkAdded", { from: briefId, to: otherId, role: "depends-on" }),
    ];
    const state = foldWorkspace(events, registry);
    expect(state.links).toEqual([{ from: briefId, to: otherId, role: "depends-on" }]);
  });
});

describe("foldWorkspace — version contiguity", () => {
  const briefId = "feature-brief:p1" as PageId;
  it("throws on a version gap (fail-fast on a missing event)", () => {
    const events: IEventEnvelope[] = [
      env(0, "WorkspaceCreated", { name: "WS" }),
      env(1, "PageCreated", { type: "feature-brief", parentId: null, title: "Brief" }, { pageId: briefId }),
      ops(3, briefId, [{ op: "setField", section: "summary", field: "body", value: { kind: "prose", value: "x" } }]),
    ];
    expect(() => foldWorkspace(events, registry)).toThrow(RangeError);
    expect(() => foldWorkspace(events, registry)).toThrow(/expected version 2, saw 3/);
  });

  it("a contiguous list folds without error", () => {
    const events: IEventEnvelope[] = [
      env(0, "WorkspaceCreated", { name: "WS" }),
      env(1, "PageCreated", { type: "feature-brief", parentId: null, title: "Brief" }, { pageId: briefId }),
      ops(2, briefId, [{ op: "setField", section: "summary", field: "body", value: { kind: "prose", value: "x" } }]),
    ];
    expect(() => foldWorkspace(events, registry)).not.toThrow();
  });
});

describe("foldWorkspace — upcasting over SectionOp payloads (§10)", () => {
  // A note page at schema version 3 whose upcasters reshape the op payload: rename
  // the targeted field key `body` → `text` (v1→v2) and add a second op (v2→v3).
  const Note = definePageType({
    type: "note",
    version: 3,
    initialStatus: "open",
    upcasters: {
      1: (payload: unknown) => {
        const p = payload as { ops: SectionOp[] };
        const next = p.ops.map((o) => (o.op === "setField" && o.field === "body" ? { ...o, field: "text" } : o));
        return { ops: next };
      },
      2: (payload: unknown) => {
        const p = payload as { ops: SectionOp[] };
        return { ops: [...p.ops] };
      },
    },
    statusTransitions: [t("open", "setBody", "open")],
    sections: { body: { name: "Body", required: true, mutableIn: ["open"], fields: { text: { kind: "prose" } } } },
    commands: {
      setBody: { args: zodSchema(z.object({ text: z.string() })), target: { section: "body", field: "text" }, set: { text: arg("text") } },
    },
    render: { sections: [{ section: "body", heading: "Body", field: "text", as: "block" }] },
  });

  const noteRegistry = new Registry([Note]);
  const noteId = "note:n1" as PageId;

  it("runs the registered upcaster chain on an old-schema op payload before the fold", () => {
    const events: IEventEnvelope[] = [
      env(0, "WorkspaceCreated", { name: "WS" }),
      env(1, "PageCreated", { type: "note", parentId: null, title: "N" }, { pageId: noteId }),
      // written under schemaVersion 1 with the OLD field key `body`.
      env(2, "SectionOpsApplied", { ops: [{ op: "setField", section: "body", field: "body", value: { kind: "prose", value: "legacy text" } }] }, { pageId: noteId, schemaVersion: 1 }),
    ];
    const state = foldWorkspace(events, noteRegistry);
    const node = state.pages.get(noteId)!;
    expect(node.sections.find((s) => s.key === "body")!.fields.text).toEqual({ kind: "prose", value: "legacy text" });
  });

  it("a current-schema payload bypasses upcasting unchanged", () => {
    const events: IEventEnvelope[] = [
      env(0, "WorkspaceCreated", { name: "WS" }),
      env(1, "PageCreated", { type: "note", parentId: null, title: "N" }, { pageId: noteId }),
      env(2, "SectionOpsApplied", { ops: [{ op: "setField", section: "body", field: "text", value: { kind: "prose", value: "fresh" } }] }, { pageId: noteId, schemaVersion: 3 }),
    ];
    const state = foldWorkspace(events, noteRegistry);
    const node = state.pages.get(noteId)!;
    expect(node.sections.find((s) => s.key === "body")!.fields.text).toEqual({ kind: "prose", value: "fresh" });
  });
});
