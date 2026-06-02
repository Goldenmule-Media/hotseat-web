/**
 * LLM-surface unit tests (BUILD_NOTES §9, DESIGN §17, §13.6).
 *
 * The page view exposes the command catalog an agent is offered:
 *   - `describeMutations()` emits valid JSON-Schema `argsSchema` (+ optional
 *     `resultSchema`) per command, with an `available` flag for the current status;
 *   - `availableMutations()` returns exactly the §13.6 offered set per feature-brief
 *     status (a subset of the full command set), and nothing in a terminal status.
 *
 * One server per file (beforeAll/afterAll). Real (in-memory) wiki — the catalog is
 * read off the SAME registry/guard the bus authorizes against.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IWorkspaceHandle, JsonSchema, PageId } from "../src/api";
import { FeatureBrief } from "wiki-models/feature";
import { featurePageTypes } from "wiki-models/feature";
import { createTestWiki, type ITestWiki } from "../src/testing";

/** Full command set declared by the feature-brief page type. */
const ALL_BRIEF_COMMANDS = Object.keys(FeatureBrief.__def.commands);

/** §13.6 offered (page-scoped) mutations on the brief, by status. */
const OFFERED_BY_STATUS: Record<string, string[]> = {
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
  shipped: [],
  abandoned: [],
};

/** A minimal structural sanity check that `s` is a JSON-Schema object. */
function isJsonSchemaObject(s: unknown): s is JsonSchema {
  if (typeof s !== "object" || s === null || Array.isArray(s)) return false;
  // Must survive a JSON round-trip (no functions / cycles / undefined-only).
  const round = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
  // zod-to-json-schema emits `type` (and for objects, `properties`).
  return typeof round.type === "string" || "$ref" in round || "anyOf" in round || "allOf" in round;
}

let tw: ITestWiki;
let ws: IWorkspaceHandle;

beforeAll(async () => {
  tw = await createTestWiki(featurePageTypes);
  ws = await tw.wiki.createWorkspace({ name: "LLM shape" });
});

afterAll(async () => {
  await tw.stop();
});

/** Create a fresh feature-brief and return its id + children ids. */
async function freshBrief(title: string): Promise<{
  brief: PageId;
  plan: PageId;
  checklist: PageId;
  testPlan: PageId;
}> {
  const { value: brief, token } = await ws.createPage("feature-brief", { title, parentId: null });
  // Read-your-writes: gate the children read on the createPage token so the page
  // (and its atomically-created children) are guaranteed visible.
  const view = await ws.page(brief, { consistentWith: token });
  const [plan, checklist, testPlan] = (await view.children()).map((c) => c.id);
  return { brief, plan, checklist, testPlan };
}

describe("describeMutations() — valid JSON Schema + availability flags", () => {
  it("emits one descriptor per declared command, each with a valid args JSON Schema", async () => {
    const { brief } = await freshBrief("Schemas A");
    const descriptors = await (await ws.page(brief)).describeMutations();

    // One per declared command (regardless of availability).
    expect(descriptors.map((d) => d.name).sort()).toEqual([...ALL_BRIEF_COMMANDS].sort());

    for (const d of descriptors) {
      expect(typeof d.name).toBe("string");
      expect(isJsonSchemaObject(d.argsSchema)).toBe(true);
      // result-bearing commands carry a valid result schema too.
      if (d.resultSchema !== undefined) {
        expect(isJsonSchemaObject(d.resultSchema)).toBe(true);
      }
      expect(typeof d.available).toBe("boolean");
    }
  });

  it("the args schema reflects each command's real parameters (e.g. setSummary.text)", async () => {
    const { brief } = await freshBrief("Schemas B");
    const byName = new Map(
      (await (await ws.page(brief)).describeMutations()).map((d) => [d.name, d]),
    );

    const setSummary = byName.get("setSummary");
    expect(setSummary).toBeDefined();
    const args = JSON.parse(JSON.stringify(setSummary!.argsSchema)) as {
      type: string;
      properties?: Record<string, unknown>;
    };
    expect(args.type).toBe("object");
    expect(args.properties).toHaveProperty("text");

    // answerQuestion takes questionId + answer.
    const answer = byName.get("answerQuestion");
    const aArgs = JSON.parse(JSON.stringify(answer!.argsSchema)) as {
      properties?: Record<string, unknown>;
    };
    expect(aArgs.properties).toHaveProperty("questionId");
    expect(aArgs.properties).toHaveProperty("answer");

    // addComponent declares a result schema { componentId }.
    const addComponent = byName.get("addComponent");
    expect(addComponent!.resultSchema).toBeDefined();
    const rSchema = JSON.parse(JSON.stringify(addComponent!.resultSchema)) as {
      properties?: Record<string, unknown>;
    };
    expect(rSchema.properties).toHaveProperty("componentId");
  });

  it("the `available` flags equal exactly the available command set for the status (draft)", async () => {
    const { brief } = await freshBrief("Schemas C");
    const view = await ws.page(brief);
    expect(await view.status()).toBe("draft");

    const availableFromDescriptors = (await view.describeMutations())
      .filter((d) => d.available)
      .map((d) => d.name)
      .sort();
    expect(availableFromDescriptors).toEqual([...(await view.availableMutations())].sort());
    expect(availableFromDescriptors).toEqual([...OFFERED_BY_STATUS.draft].sort());
  });
});

describe("availableMutations() — matches the §13.6 table per status", () => {
  it("draft offers exactly the §13.6 draft set", async () => {
    const { brief } = await freshBrief("Status draft");
    const view = await ws.page(brief);
    expect(await view.status()).toBe("draft");
    expect([...(await view.availableMutations())].sort()).toEqual(
      [...OFFERED_BY_STATUS.draft].sort(),
    );
  });

  it("planning offers exactly the §13.6 planning set", async () => {
    const { brief } = await freshBrief("Status planning");
    const { token } = await ws.mutate(brief, "beginPlanning", {});
    const view = await ws.page(brief, { consistentWith: token });
    expect(await view.status({ consistentWith: token })).toBe("planning");
    expect([...(await view.availableMutations({ consistentWith: token }))].sort()).toEqual(
      [...OFFERED_BY_STATUS.planning].sort(),
    );
  });

  it("building offers exactly the §13.6 building set (after the cross-page gate is met)", async () => {
    const { brief, plan, testPlan } = await freshBrief("Status building");
    await ws.mutate(brief, "beginPlanning", {});
    await ws.mutate(plan, "addStep", { text: "do the thing" });
    await ws.mutate(testPlan, "addCase", { text: "verify the thing" });
    const { token } = await ws.mutate(brief, "beginImplementation", {});
    const view = await ws.page(brief, { consistentWith: token });
    expect(await view.status({ consistentWith: token })).toBe("building");
    expect([...(await view.availableMutations({ consistentWith: token }))].sort()).toEqual(
      [...OFFERED_BY_STATUS.building].sort(),
    );
  });

  it("review offers exactly the §13.6 review set", async () => {
    const { brief, plan, testPlan } = await freshBrief("Status review");
    await ws.mutate(brief, "beginPlanning", {});
    await ws.mutate(plan, "addStep", { text: "step" });
    await ws.mutate(testPlan, "addCase", { text: "case" });
    await ws.mutate(brief, "beginImplementation", {});
    const { token } = await ws.mutate(brief, "submitForReview", {});
    const view = await ws.page(brief, { consistentWith: token });
    expect(await view.status({ consistentWith: token })).toBe("review");
    expect([...(await view.availableMutations({ consistentWith: token }))].sort()).toEqual(
      [...OFFERED_BY_STATUS.review].sort(),
    );
  });

  it("shipped is terminal — offers nothing (after all gates satisfied)", async () => {
    const { brief, plan, checklist, testPlan } = await freshBrief("Status shipped");
    await ws.mutate(brief, "beginPlanning", {});
    await ws.mutate(plan, "addStep", { text: "step" });
    const { caseId } = (await ws.mutate(testPlan, "addCase", { text: "case" })).value as {
      caseId: string;
    };
    await ws.mutate(brief, "beginImplementation", {});
    const { taskId } = (await ws.mutate(checklist, "addTask", { text: "task" })).value as {
      taskId: string;
    };
    await ws.mutate(checklist, "checkTask", { taskId });
    await ws.mutate(testPlan, "markCasePassed", { caseId });
    await ws.mutate(brief, "submitForReview", {});
    const { token } = await ws.mutate(brief, "ship", {});

    const view = await ws.page(brief, { consistentWith: token });
    expect(await view.status({ consistentWith: token })).toBe("shipped");
    expect(await view.availableMutations({ consistentWith: token })).toEqual([]);
  });

  it("abandoned is terminal — offers nothing", async () => {
    const { brief } = await freshBrief("Status abandoned");
    const { token } = await ws.mutate(brief, "abandon", {});
    const view = await ws.page(brief, { consistentWith: token });
    expect(await view.status({ consistentWith: token })).toBe("abandoned");
    expect(await view.availableMutations({ consistentWith: token })).toEqual([]);
  });

  it("availableMutations() is always a SUBSET of the full command set", async () => {
    const { brief } = await freshBrief("Subset check");
    const full = new Set(ALL_BRIEF_COMMANDS);
    for (const cmd of await (await ws.page(brief)).availableMutations()) {
      expect(full.has(cmd)).toBe(true);
    }
  });
});
