import { describe, expect, it } from "vitest";
import type { FsmDescriptor, IMutationDescriptor } from "wiki";
import { buildFsmGraph, resolveTransitionTarget, type EdgeRef } from "./fsm-graph";

const fsm: FsmDescriptor = {
  type: "feature-brief",
  initial: "draft",
  states: ["draft", "planning", "building", "review", "shipped", "abandoned"],
  transitions: [
    { from: "draft", event: "beginPlanning", to: "planning" },
    { from: "review", event: "ship", to: "shipped" },
    { from: "review", event: "requestChanges", to: "building" },
    { from: "review", event: "abandon", to: "abandoned" },
  ],
};

const edge = (model: ReturnType<typeof buildFsmGraph>, from: string, ev: string) =>
  model.edges.find((e) => e.source === from && e.label === ev)!;

describe("buildFsmGraph", () => {
  it("marks exactly the current-status node", () => {
    const model = buildFsmGraph(fsm, "review", []);
    expect(model.nodes).toHaveLength(6);
    expect(model.nodes.find((n) => n.id === "review")!.isCurrent).toBe(true);
    expect(model.nodes.filter((n) => n.isCurrent)).toHaveLength(1);
  });

  it("classifies outgoing edges from the overlay, carrying the block reason", () => {
    const model = buildFsmGraph(fsm, "review", [
      { name: "ship", available: false, unmet: "all testing-plan cases must be passed" },
      { name: "requestChanges", available: true },
      { name: "abandon", available: true },
      { name: "beginPlanning", available: false },
    ]);
    expect(edge(model, "review", "ship").cls).toBe("blocked");
    expect(edge(model, "review", "ship").reason).toMatch(/cases/);
    expect(edge(model, "review", "requestChanges").cls).toBe("available");
    expect(edge(model, "review", "abandon").cls).toBe("available");
  });

  it("treats transitions that don't leave the current state as inert (regardless of overlay)", () => {
    const model = buildFsmGraph(fsm, "review", [{ name: "beginPlanning", available: false }]);
    const bp = edge(model, "draft", "beginPlanning");
    expect(bp.cls).toBe("inert");
    expect(bp.reason).toBeUndefined();
  });

  it("defaults an outgoing edge with no overlay entry to available", () => {
    const model = buildFsmGraph(fsm, "review", []);
    expect(edge(model, "review", "ship").cls).toBe("available");
  });
});

describe("resolveTransitionTarget", () => {
  const descriptors: readonly IMutationDescriptor[] = [
    { name: "requestChanges", argsSchema: { type: "object" }, available: true },
    { name: "ship", argsSchema: { type: "object" }, available: false, unmet: "all testing-plan cases must be passed" },
  ];
  const ref = (event: string, cls: EdgeRef["cls"], from = "review", to = "x"): EdgeRef => ({ event, from, to, cls });

  it("resolves an available edge to a runnable target", () => {
    const t = resolveTransitionTarget(ref("requestChanges", "available", "review", "building"), descriptors);
    expect(t).not.toBeNull();
    expect(t!.descriptor.name).toBe("requestChanges");
    expect(t!.available).toBe(true);
    expect(t!.from).toBe("review");
    expect(t!.to).toBe("building");
    expect(t!.unmet).toBeUndefined();
  });

  it("resolves a blocked edge to a read-only target carrying the descriptor's unmet reason", () => {
    const t = resolveTransitionTarget(ref("ship", "blocked", "review", "shipped"), descriptors);
    expect(t).not.toBeNull();
    expect(t!.available).toBe(false);
    expect(t!.unmet).toMatch(/cases/);
  });

  it("ignores an inert edge", () => {
    expect(resolveTransitionTarget(ref("requestChanges", "inert"), descriptors)).toBeNull();
  });

  it("ignores an edge whose command is absent from the overlay", () => {
    expect(resolveTransitionTarget(ref("unknownCmd", "available"), descriptors)).toBeNull();
  });
});
