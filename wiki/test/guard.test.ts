/**
 * FSM guard unit tests (new declarative model).
 *
 * The page FSM is now lifecycle-ONLY (content-edit legality lives in `mutableIn`).
 * Element FSMs (question/step/case) live inline in each type's `elements` and are
 * exposed via the registry's element guards.
 */
import { describe, expect, it } from "vitest";

import { makeGuard, t } from "../src/core/guard";
import { Registry } from "../src/core/registry";
import { FeatureBrief, ImplementationPlan, TestingPlan } from "wiki-models/feature";

const briefTransitions = FeatureBrief.__def.statusTransitions;
const guard = makeGuard<string, string>([...briefTransitions]);

const allCommands: string[] = [...new Set<string>(briefTransitions.map((tr) => tr.event))];
const allStates: string[] = [...new Set<string>([...guard.states(), "shipped", "abandoned"])];

describe("makeGuard — page lifecycle FSM (feature-brief)", () => {
  it("authorizes a legal lifecycle transition and reports its target status", () => {
    expect(guard.can("draft", "beginPlanning")).toBe(true);
    expect(guard.next("draft", "beginPlanning")).toBe("planning");
    expect(guard.can("planning", "beginImplementation")).toBe(true);
    expect(guard.next("planning", "beginImplementation")).toBe("building");
    expect(guard.can("review", "ship")).toBe(true);
    expect(guard.next("review", "ship")).toBe("shipped");
  });

  it("content edits are NOT page transitions (they are gated by mutableIn)", () => {
    expect(guard.can("draft", "setSummary")).toBe(false);
    expect(guard.can("building", "recordCommit")).toBe(false);
  });

  it("rejects a command with no edge from the given status", () => {
    expect(guard.can("draft", "ship")).toBe(false);
    expect(guard.next("draft", "ship")).toBeUndefined();
    expect(guard.can("draft", "beginImplementation")).toBe(false);
  });

  it("rejects every command from a terminal status (shipped / abandoned)", () => {
    for (const command of allCommands) {
      expect(guard.can("shipped", command)).toBe(false);
      expect(guard.can("abandoned", command)).toBe(false);
    }
    expect(guard.available("shipped")).toEqual([]);
    expect(guard.available("abandoned")).toEqual([]);
  });

  it("available() returns exactly the declared lifecycle set per status", () => {
    const expected: Record<string, string[]> = {
      draft: ["beginPlanning", "abandon"],
      planning: ["beginImplementation", "abandon"],
      building: ["reopenPlanning", "submitForReview", "abandon"],
      review: ["requestChanges", "ship", "abandon"],
    };
    for (const [status, commands] of Object.entries(expected)) {
      expect([...guard.available(status)].sort()).toEqual([...commands].sort());
    }
  });

  it("states() enumerates exactly the reachable lifecycle states", () => {
    expect([...guard.states()].sort()).toEqual(
      ["abandoned", "building", "draft", "planning", "review", "shipped"].sort(),
    );
  });
});

describe("makeGuard — property: no command is legal without a declared transition", () => {
  it("can(status, command) ⇔ a transition exists", () => {
    for (const status of allStates) {
      for (const command of allCommands) {
        const declared = briefTransitions.some((tr) => tr.fromState === status && tr.event === command);
        expect(guard.can(status, command)).toBe(declared);
      }
    }
  });
});

describe("element FSMs via the registry (question / step / case)", () => {
  const registry = new Registry([FeatureBrief, ImplementationPlan, TestingPlan]);

  it("question: open → resolved only (answer), never twice", () => {
    const g = registry.elementGuard("feature-brief", "question")!;
    expect(g.can("open", "answer")).toBe(true);
    expect(g.next("open", "answer")).toBe("resolved");
    expect(g.can("resolved", "answer")).toBe(false);
    expect(g.available("resolved")).toEqual([]);
  });

  it("step: todo ⇄ done via markDone / reopen", () => {
    const g = registry.elementGuard("implementation-plan", "step")!;
    expect(g.next("todo", "markDone")).toBe("done");
    expect(g.next("done", "reopen")).toBe("todo");
    expect(g.can("done", "markDone")).toBe(false);
  });

  it("case: planned → passed/failed, failed can recover to passed", () => {
    const g = registry.elementGuard("testing-plan", "case")!;
    expect(g.next("planned", "pass")).toBe("passed");
    expect(g.next("planned", "fail")).toBe("failed");
    expect(g.next("failed", "pass")).toBe("passed");
    expect(g.can("passed", "fail")).toBe(false);
  });
});

describe("t() builder", () => {
  it("constructs the transition triple and attaches optional meta only when given", () => {
    const bare = t("a", "go", "b");
    expect(bare).toEqual({ fromState: "a", event: "go", toState: "b" });
    expect("meta" in bare).toBe(false);
    const withMeta = t("a", "go", "b", { description: "advance" });
    expect(withMeta.meta).toEqual({ description: "advance" });
  });
});
