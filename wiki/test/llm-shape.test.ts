/**
 * LLM-surface unit tests (new declarative model).
 *
 * The page view exposes the command catalog an agent is offered:
 *   - `describeMutations()` emits one descriptor per declared command (valid args
 *     JSON-Schema, optional result schema, an `available` flag, and a `target`
 *     where the command edits a section) PLUS the generated structural commands;
 *   - `availableMutations()` combines FSM-legal lifecycle commands with the
 *     content commands whose section is mutable in the current status.
 *
 * Expectations are derived from the page-type declaration + registry so the test
 * verifies the gating logic (mutableIn ∪ FSM), not a brittle hand-listed set.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IWorkspaceHandle, JsonSchema, PageId } from "../src/api";
import { FeatureBrief } from "wiki-models/feature";
import { featurePageTypes } from "wiki-models/feature";
import { Registry } from "../src/core/registry";
import { createTestWiki, type ITestWiki } from "../src/testing";

const registry = new Registry(featurePageTypes);
const briefDef = FeatureBrief.__def;
const briefDeclared = Object.keys(briefDef.commands);
const briefGenerated = [...registry.generatedCommands("feature-brief").keys()];

/** The commands that SHOULD be available on a feature-brief in `status`. */
function expectedAvailable(status: string): string[] {
  const out: string[] = [];
  const guard = registry.pageGuard("feature-brief");
  const decls = briefDef.sections;
  const mutable = (sectionKey: string): boolean => {
    const sd = decls[sectionKey];
    return sd?.mutableIn === undefined || sd.mutableIn.includes(status);
  };
  for (const [name, cmd] of Object.entries(briefDef.commands)) {
    if (cmd.transition?.level === "page") {
      if (guard.can(status, name)) out.push(name);
    } else if (cmd.target?.section !== undefined) {
      if (mutable(cmd.target.section)) out.push(name);
    } else {
      out.push(name);
    }
  }
  for (const [name, gen] of registry.generatedCommands("feature-brief")) {
    if (mutable(gen.section)) out.push(name);
  }
  return out.sort();
}

function isJsonSchemaObject(s: unknown): s is JsonSchema {
  if (typeof s !== "object" || s === null || Array.isArray(s)) return false;
  const round = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
  return typeof round.type === "string" || "$ref" in round || "anyOf" in round || "allOf" in round || Object.keys(round).length === 0;
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

async function freshBrief(title: string): Promise<{ brief: PageId; plan: PageId; testPlan: PageId }> {
  const { value: brief, token } = await ws.createPage("feature-brief", { title, parentId: null });
  const view = await ws.page(brief, { consistentWith: token });
  const [plan, testPlan] = (await view.children()).map((c) => c.id);
  return { brief, plan, testPlan };
}

describe("describeMutations() — declared + generated, with targets", () => {
  it("emits one descriptor per declared command plus the generated structural set", async () => {
    const { brief } = await freshBrief("Schemas A");
    const descriptors = await (await ws.page(brief)).describeMutations();
    const names = descriptors.map((d) => d.name).sort();
    expect(names).toEqual([...briefDeclared, ...briefGenerated].sort());

    for (const d of descriptors) {
      expect(typeof d.name).toBe("string");
      expect(isJsonSchemaObject(d.argsSchema)).toBe(true);
      if (d.resultSchema !== undefined) expect(isJsonSchemaObject(d.resultSchema)).toBe(true);
      expect(typeof d.available).toBe("boolean");
    }
  });

  it("a content command surfaces the section it edits via `target`", async () => {
    const { brief } = await freshBrief("Schemas B");
    const byName = new Map((await (await ws.page(brief)).describeMutations()).map((d) => [d.name, d]));
    expect(byName.get("setSummary")!.target).toEqual({ section: "summary", field: "body" });
    expect(byName.get("addComponent")!.target).toEqual({ section: "components", field: "items" });
  });

  it("args/result schemas reflect each command's real parameters", async () => {
    const { brief } = await freshBrief("Schemas C");
    const byName = new Map((await (await ws.page(brief)).describeMutations()).map((d) => [d.name, d]));
    const args = JSON.parse(JSON.stringify(byName.get("setSummary")!.argsSchema)) as { type: string; properties?: Record<string, unknown> };
    expect(args.properties).toHaveProperty("text");
    const aArgs = JSON.parse(JSON.stringify(byName.get("answerQuestion")!.argsSchema)) as { properties?: Record<string, unknown> };
    expect(aArgs.properties).toHaveProperty("questionId");
    expect(aArgs.properties).toHaveProperty("answer");
    const rSchema = JSON.parse(JSON.stringify(byName.get("addComponent")!.resultSchema)) as { properties?: Record<string, unknown> };
    expect(rSchema.properties).toHaveProperty("componentId");
  });

  it("the `available` flags equal availableMutations() for the status (draft)", async () => {
    const { brief } = await freshBrief("Schemas D");
    const view = await ws.page(brief);
    expect(await view.status()).toBe("draft");
    const availableFromDescriptors = (await view.describeMutations()).filter((d) => d.available).map((d) => d.name).sort();
    expect(availableFromDescriptors).toEqual([...(await view.availableMutations())].sort());
    expect(availableFromDescriptors).toEqual(expectedAvailable("draft"));
  });
});

describe("availableMutations() — FSM lifecycle ∪ mutableIn content per status", () => {
  it("draft", async () => {
    const { brief } = await freshBrief("Status draft");
    const view = await ws.page(brief);
    expect([...(await view.availableMutations())].sort()).toEqual(expectedAvailable("draft"));
  });

  it("planning", async () => {
    const { brief } = await freshBrief("Status planning");
    const { token } = await ws.mutate(brief, "beginPlanning", {});
    const view = await ws.page(brief, { consistentWith: token });
    expect([...(await view.availableMutations({ consistentWith: token }))].sort()).toEqual(expectedAvailable("planning"));
  });

  it("building", async () => {
    const { brief, plan, testPlan } = await freshBrief("Status building");
    await ws.mutate(brief, "beginPlanning", {});
    await ws.mutate(plan, "addStep", { text: "do the thing" });
    await ws.mutate(plan, "addDataModel", { language: "ts", source: "export interface Thing {}" });
    await ws.mutate(testPlan, "addCase", { text: "verify the thing" });
    const { token } = await ws.mutate(brief, "beginImplementation", {});
    const view = await ws.page(brief, { consistentWith: token });
    expect([...(await view.availableMutations({ consistentWith: token }))].sort()).toEqual(expectedAvailable("building"));
  });

  it("review", async () => {
    const { brief, plan, testPlan } = await freshBrief("Status review");
    await ws.mutate(brief, "beginPlanning", {});
    await ws.mutate(plan, "addStep", { text: "step" });
    await ws.mutate(plan, "addDataModel", { language: "ts", source: "export interface T {}" });
    await ws.mutate(testPlan, "addCase", { text: "case" });
    await ws.mutate(brief, "beginImplementation", {});
    const { token } = await ws.mutate(brief, "submitForReview", {});
    const view = await ws.page(brief, { consistentWith: token });
    expect([...(await view.availableMutations({ consistentWith: token }))].sort()).toEqual(expectedAvailable("review"));
  });

  it("abandoned is terminal — only content commands gated by a status no section allows are gone", async () => {
    const { brief } = await freshBrief("Status abandoned");
    const { token } = await ws.mutate(brief, "abandon", {});
    const view = await ws.page(brief, { consistentWith: token });
    expect(await view.status({ consistentWith: token })).toBe("abandoned");
    expect([...(await view.availableMutations({ consistentWith: token }))].sort()).toEqual(expectedAvailable("abandoned"));
  });
});
