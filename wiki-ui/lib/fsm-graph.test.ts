import { describe, expect, it } from "vitest";
import type { FsmDescriptor } from "wiki";
import { buildFsmGraph } from "./fsm-graph";

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
