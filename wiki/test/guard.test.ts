/**
 * FSM guard unit tests (BUILD_NOTES §9, DESIGN §17).
 *
 * Exercises `makeGuard().can / .next / .available` against the REAL feature-brief
 * transition table, plus a property test asserting that no command is legal from a
 * status that lacks a transition for it (the FSM never authorizes an undeclared
 * edge). Pure — no server needed.
 */
import { describe, expect, it } from "vitest";

import { makeGuard, t } from "../src/core/guard";
import { FeatureBrief } from "../src/pages/feature/feature-brief";
import { question, task, testCase } from "../src/pages/feature/items";

const briefTransitions = FeatureBrief.__def.statusTransitions;
const guard = makeGuard(briefTransitions);

/** The full set of command names referenced anywhere in the table. */
const allCommands = [...new Set(briefTransitions.map((tr) => tr.event))];
/** Every status referenced by the table, plus the two declared terminals. */
const allStates = [...new Set([...guard.states(), "shipped", "abandoned"])];

describe("makeGuard — can / next / available (feature-brief FSM)", () => {
  it("authorizes a legal page transition and reports its target status", () => {
    expect(guard.can("draft", "beginPlanning")).toBe(true);
    expect(guard.next("draft", "beginPlanning")).toBe("planning");

    expect(guard.can("planning", "beginImplementation")).toBe(true);
    expect(guard.next("planning", "beginImplementation")).toBe("building");

    expect(guard.can("review", "ship")).toBe(true);
    expect(guard.next("review", "ship")).toBe("shipped");
  });

  it("treats a self-transition (content edit) as legal without changing status", () => {
    expect(guard.can("draft", "setSummary")).toBe(true);
    expect(guard.next("draft", "setSummary")).toBe("draft");

    expect(guard.can("building", "recordCommit")).toBe(true);
    expect(guard.next("building", "recordCommit")).toBe("building");
  });

  it("rejects a command that has no edge from the given status", () => {
    // `ship` is only legal from `review`, never from `draft`.
    expect(guard.can("draft", "ship")).toBe(false);
    expect(guard.next("draft", "ship")).toBeUndefined();

    // `beginImplementation` is a planning→building edge, not a draft edge.
    expect(guard.can("draft", "beginImplementation")).toBe(false);

    // `recordCommit` is not offered in draft/planning.
    expect(guard.can("planning", "recordCommit")).toBe(false);
  });

  it("rejects every command from a terminal status (shipped / abandoned)", () => {
    for (const command of allCommands) {
      expect(guard.can("shipped", command)).toBe(false);
      expect(guard.can("abandoned", command)).toBe(false);
    }
    expect(guard.available("shipped")).toEqual([]);
    expect(guard.available("abandoned")).toEqual([]);
  });

  it("available() returns exactly the declared §13.6 set per status (deduped, order-insensitive)", () => {
    const expected: Record<string, string[]> = {
      draft: [
        "setSummary",
        "addComponent",
        "removeComponent",
        "addConstraint",
        "removeConstraint",
        "askQuestion",
        "answerQuestion",
        "beginPlanning",
        "abandon",
      ],
      planning: [
        "addConstraint",
        "removeConstraint",
        "askQuestion",
        "answerQuestion",
        "beginImplementation",
        "abandon",
      ],
      building: [
        "addConstraint",
        "askQuestion",
        "answerQuestion",
        "recordCommit",
        "reopenPlanning",
        "submitForReview",
        "abandon",
      ],
      review: ["recordCommit", "requestChanges", "ship", "abandon"],
    };
    for (const [status, commands] of Object.entries(expected)) {
      expect([...guard.available(status)].sort()).toEqual([...commands].sort());
    }
  });

  it("available() never contains duplicates", () => {
    for (const status of allStates) {
      const avail = guard.available(status);
      expect(avail.length).toBe(new Set(avail).size);
    }
  });

  it("states() enumerates exactly the reachable lifecycle states", () => {
    expect([...guard.states()].sort()).toEqual(
      ["abandoned", "building", "draft", "planning", "review", "shipped"].sort(),
    );
  });
});

describe("makeGuard — property: no command is legal without a declared transition", () => {
  it("can(status, command) ⇔ a transition (status, command) exists in the table", () => {
    for (const status of allStates) {
      for (const command of allCommands) {
        const declared = briefTransitions.some(
          (tr) => tr.fromState === status && tr.event === command,
        );
        expect(guard.can(status, command)).toBe(declared);
        // And: legality implies a defined target; illegality implies undefined.
        if (declared) {
          expect(guard.next(status, command)).toBeTypeOf("string");
        } else {
          expect(guard.next(status, command)).toBeUndefined();
        }
      }
    }
  });

  it("available(status) is precisely the set of commands that can() accepts from status", () => {
    for (const status of allStates) {
      const viaAvailable = new Set(guard.available(status));
      const viaCan = new Set(allCommands.filter((c) => guard.can(status, c)));
      expect(viaAvailable).toEqual(viaCan);
    }
  });
});

describe("makeGuard — item-level FSMs (question / task / case)", () => {
  it("question: open → resolved only, and never resolved twice", () => {
    const g = makeGuard(question.__def.statusTransitions ?? []);
    expect(g.can("open", "answerQuestion")).toBe(true);
    expect(g.next("open", "answerQuestion")).toBe("resolved");
    // A resolved question cannot be answered again — the loser of a race fails here.
    expect(g.can("resolved", "answerQuestion")).toBe(false);
    expect(g.available("resolved")).toEqual([]);
  });

  it("task: todo ⇄ done via check / uncheck", () => {
    const g = makeGuard(task.__def.statusTransitions ?? []);
    expect(g.next("todo", "checkTask")).toBe("done");
    expect(g.next("done", "uncheckTask")).toBe("todo");
    expect(g.can("done", "checkTask")).toBe(false);
    expect(g.can("todo", "uncheckTask")).toBe(false);
  });

  it("case: planned → passed/failed, and a failed case can recover to passed", () => {
    const g = makeGuard(testCase.__def.statusTransitions ?? []);
    expect(g.next("planned", "markCasePassed")).toBe("passed");
    expect(g.next("planned", "markCaseFailed")).toBe("failed");
    expect(g.next("failed", "markCasePassed")).toBe("passed");
    // A passed case is terminal for these events.
    expect(g.can("passed", "markCaseFailed")).toBe(false);
    expect(g.available("passed")).toEqual([]);
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
