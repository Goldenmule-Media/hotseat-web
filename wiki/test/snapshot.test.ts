/**
 * Snapshot round-trip integration test (DESIGN §8.3 / §17; BUILD_NOTES §9).
 *
 * Builds a real workspace (via `createTestWiki`), captures its authoritative
 * event log, and asserts the two snapshot invariants:
 *
 *  1. SERIALIZATION round-trip is identity: deserializeState(serializeState(s))
 *     deep-equals `s` — even across an actual JSON encode/decode (the form the
 *     snapshot is persisted in), so Map↔array flattening loses nothing.
 *  2. FOLD equivalence: folding the full log from zero produces state that
 *     deep-equals folding ONLY the tail onto a snapshot taken at an earlier
 *     version (`foldWorkspace(events, registry, { state, fromVersion })`). A
 *     snapshot is a cache, never a different truth.
 *
 * State equality uses Vitest's structural `toEqual`, which compares `Map`
 * contents deeply — so `pages`/`children` are checked entry-by-entry, not by
 * reference. No host clock / RNG anywhere: the wiki injects deterministic
 * clock/ids, and fold/serialize are pure.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IEventEnvelope, IWiki, IWorkspaceHandle, PageId } from "../src/api";
import { Registry } from "../src/core/registry";
import { deserializeState, serializeState } from "../src/core/snapshot";
import { foldWorkspace } from "../src/core/workspace";
import { featurePageTypes } from "wiki-models/feature";
import { createTestWiki, type ITestWiki } from "../src/testing";

describe("snapshot round-trip & fold equivalence", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;
  /** A fresh registry, built the same way the engine builds its own. */
  const registry = new Registry(featurePageTypes);

  /** The authoritative, version-ordered event log of the built workspace. */
  let events: readonly IEventEnvelope[];

  beforeAll(async () => {
    harness = await createTestWiki(featurePageTypes);
    wiki = harness.wiki;
    ws = await wiki.createWorkspace({ name: "Snapshot project" });

    // Build a non-trivial workspace: a brief (+3 children), filled fields, items
    // across pages, status transitions, a link, and a cross-page item move — so
    // the folded state covers every structural + content code path.
    const { value: brief, token: briefToken } = await ws.createPage("feature-brief", {
      title: "Bulk export",
      parentId: null,
    });
    const { value: other } = await ws.createPage("feature-brief", { title: "RBAC", parentId: null });
    const briefView = await ws.page(brief, { consistentWith: briefToken });
    const [plan, checklist, testPlan] = (await briefView.children()).map((c) => c.id);

    await ws.mutate(brief, "setSummary", { text: "Export as CSV/JSON." });
    await ws.mutate(brief, "addComponent", { name: "web-app" });
    await ws.mutate(brief, "addConstraint", { text: "Stream; never buffer >50MB." });
    const { questionId: q1 } = (await ws.mutate(brief, "askQuestion", {
      text: "Which formats?",
    })).value as { questionId: string };
    await ws.mutate(brief, "answerQuestion", { questionId: q1, answer: "CSV/JSON." });
    await ws.link(brief, other, "depends-on");

    await ws.mutate(brief, "beginPlanning", {});
    await ws.mutate(plan, "addStep", { text: "Stream from /export." });
    const { caseId } = (await ws.mutate(testPlan, "addCase", {
      text: "10k rows < 2s.",
    })).value as { caseId: string };

    // Cross-page move: a question relocates brief → plan (ItemRemoved + ItemAdded).
    const { questionId: q2 } = (await ws.mutate(brief, "askQuestion", {
      text: "Page size?",
    })).value as { questionId: string };
    await ws.moveItem({ from: brief, to: plan, section: "questions", field: "items", itemId: q2 });

    await ws.mutate(brief, "beginImplementation", {});
    const { taskId } = (await ws.mutate(checklist, "addTask", {
      text: "Endpoint",
    })).value as { taskId: string };
    await ws.mutate(checklist, "checkTask", { taskId });
    const { token: lastToken } = await ws.mutate(testPlan, "markCasePassed", { caseId });

    // History is a read; gate it on the last write's token so it reflects every
    // mutation above (read-your-writes), not a possibly-stale tail.
    events = await ws.history({ consistentWith: lastToken });
    // Sanity: a real, multi-commit log with a WorkspaceCreated head.
    expect(events.length).toBeGreaterThan(15);
    expect(events[0]?.type).toBe("WorkspaceCreated");
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("serialize → JSON → deserialize is identity (Map↔array, no host clock)", () => {
    const state = foldWorkspace(events, registry);

    // Round-trip through the EXACT persisted form: serialize → JSON → parse →
    // deserialize. This catches any Map/array flattening or key-coercion bug.
    const json = JSON.stringify(serializeState(state));
    const restored = deserializeState(JSON.parse(json));

    expect(restored).toEqual(state);

    // Spot-check the live Map shapes survived (not silently turned into objects).
    expect(restored.pages).toBeInstanceOf(Map);
    expect(restored.children).toBeInstanceOf(Map);
    expect(restored.pages.size).toBe(state.pages.size);
    expect([...restored.children.keys()]).toEqual([...state.children.keys()]);
  });

  it("fold-from-snapshot + tail deep-equals fold-from-zero", () => {
    const full = foldWorkspace(events, registry);

    // Take a snapshot partway through (after the brief + children + some content),
    // capturing the version it covers; the rest of the log is the "tail".
    const snapshotIndex = Math.floor(events.length / 2);
    const snapshotVersion = events[snapshotIndex - 1]!.version;
    const prefix = events.slice(0, snapshotIndex);

    // Build the snapshot state by folding the prefix, then ROUND-TRIP it through
    // the persisted serialized form (mirroring loadSnapshot) so we prove a real
    // restored snapshot — not a live in-memory object — folds the tail correctly.
    const prefixState = foldWorkspace(prefix, registry);
    const snapshotState = deserializeState(
      JSON.parse(JSON.stringify(serializeState(prefixState))),
    );
    expect(snapshotState.version).toBe(snapshotVersion + 1);

    // Fold the FULL log onto the snapshot: events with version ≤ snapshotVersion
    // are skipped (already baked in); the tail is applied forward.
    const foldedFromSnapshot = foldWorkspace(events, registry, {
      state: snapshotState,
      fromVersion: snapshotVersion,
    });

    // Byte-identical state: snapshot+tail == from-zero.
    expect(foldedFromSnapshot).toEqual(full);

    // And a couple of concrete invariants the deep-equal subsumes but which make
    // the intent explicit (and would localize a regression).
    expect(foldedFromSnapshot.version).toBe(full.version);
    expect(foldedFromSnapshot.pages.size).toBe(full.pages.size);
    for (const [id, node] of full.pages) {
      expect(foldedFromSnapshot.pages.get(id as PageId)).toEqual(node);
    }
  });

  it("folding only the tail onto the snapshot equals folding the whole log onto it (idempotent skip)", () => {
    // Folding the tail-only slice vs. folding the whole log (with skip) onto the
    // same snapshot must agree — the version-≤ skip is the only thing that makes
    // the coarse-cursor read safe (DESIGN §8.3).
    const full = foldWorkspace(events, registry);

    const snapshotIndex = Math.floor(events.length / 3);
    const snapshotVersion = events[snapshotIndex - 1]!.version;
    const prefix = events.slice(0, snapshotIndex);
    const tail = events.slice(snapshotIndex);

    const snapA = foldWorkspace(prefix, registry);
    const snapB = foldWorkspace(prefix, registry);

    const fromTailOnly = foldWorkspace(tail, registry, {
      state: snapA,
      fromVersion: snapshotVersion,
    });
    const fromWholeWithSkip = foldWorkspace(events, registry, {
      state: snapB,
      fromVersion: snapshotVersion,
    });

    expect(fromTailOnly).toEqual(full);
    expect(fromWholeWithSkip).toEqual(full);
  });
});
