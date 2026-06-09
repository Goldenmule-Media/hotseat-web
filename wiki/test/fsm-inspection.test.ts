/**
 * FSM inspection (the wiki-ui model-inspection feature). Two engine surfaces back the
 * UI graph: `IWiki.fsmOf(type)` exposes a page type's status FSM as a serializable
 * descriptor, and `IPageView.describeMutations()` reports PRECONDITION-AWARE
 * availability — `available` reflects FSM-legality AND the command's pure
 * preconditions, with the first failing precondition's reason surfaced as `unmet`
 * (so the UI can render a transition as "blocked — here's why").
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IWiki, IWorkspaceHandle, PageId } from "../src/api";
import { UnknownPageTypeError } from "../src/core/errors";
import { featurePageTypes } from "wiki-models/feature";
import { createTestWiki, type ITestWiki } from "../src/testing";

describe("IWiki.fsmOf — serializable status-FSM descriptor", () => {
  let harness: ITestWiki;
  let wiki: IWiki;

  beforeAll(async () => {
    harness = await createTestWiki(featurePageTypes);
    wiki = harness.wiki;
  });
  afterAll(async () => {
    await harness.stop();
  });

  it("describes feature-brief: initial status, the full state set (initial first), every edge", () => {
    const fsm = wiki.fsmOf("feature-brief");
    expect(fsm.type).toBe("feature-brief");
    expect(fsm.initial).toBe("draft");
    expect(fsm.states[0]).toBe("draft"); // initial first
    expect(new Set(fsm.states)).toEqual(
      new Set(["draft", "planning", "building", "review", "shipped", "abandoned"]),
    );
    expect(fsm.transitions).toHaveLength(10);
    // Model-declared `agency` rides on the edge meta: forward edges the agent drives are
    // "agent"; sign-off gates are "human"; escape/backward edges (e.g. abandon) carry none.
    expect(fsm.transitions).toEqual(
      expect.arrayContaining([
        { from: "draft", event: "beginPlanning", to: "planning", meta: { agency: "agent" } },
        { from: "building", event: "submitForReview", to: "review", meta: { agency: "human" } },
        { from: "review", event: "ship", to: "shipped", meta: { agency: "human" } },
        { from: "review", event: "abandon", to: "abandoned" },
      ]),
    );
  });

  it("is JSON-serializable — no functions or cycles cross the engine→UI boundary", () => {
    const fsm = wiki.fsmOf("feature-brief");
    expect(JSON.parse(JSON.stringify(fsm))).toEqual(fsm);
  });

  it("throws UnknownPageTypeError for an unregistered type", () => {
    expect(() => wiki.fsmOf("does-not-exist")).toThrow(UnknownPageTypeError);
  });
});

describe("IWiki.describeType / pageTypes — instance-free authoring surface", () => {
  let harness: ITestWiki;
  let wiki: IWiki;

  beforeAll(async () => {
    harness = await createTestWiki(featurePageTypes);
    wiki = harness.wiki;
  });
  afterAll(async () => {
    await harness.stop();
  });

  it("lists every registered page type", () => {
    const types = wiki.pageTypes();
    expect(types).toEqual(
      expect.arrayContaining([
        "feature-brief",
        "feature-spec",
        "implementation-plan",
        "testing-plan",
      ]),
    );
  });

  it("describes feature-brief: FSM + declared commands with real arg schemas, no instance needed", () => {
    const desc = wiki.describeType("feature-brief");
    expect(desc.type).toBe("feature-brief");
    expect(desc.fsm.initial).toBe("draft");
    expect(desc.fsm.transitions.length).toBeGreaterThan(0);

    // A declared content command surfaces its REAL args schema + result + the section
    // it targets — the exact thing an author otherwise had to read model source for.
    const addComponent = desc.commands.find((c) => c.name === "addComponent");
    expect(addComponent).toBeDefined();
    expect(addComponent!.generated).toBe(false);
    const props = (addComponent!.argsSchema as { properties?: Record<string, unknown>; required?: string[] });
    expect(props.properties).toHaveProperty("name");
    expect(props.required).toContain("name");
    expect(addComponent!.resultSchema).toBeDefined();

    // A declared page-transition command carries the FSM event it fires.
    const ship = desc.commands.find((c) => c.name === "ship");
    expect(ship?.transition).toEqual({ level: "page", event: "ship" });
    // ...and its model-declared agency, joined instance-free off the static transition table
    // (a separate code path from describeMutations' status-scoped join).
    expect(ship?.agency).toBe("human");
    expect(desc.commands.find((c) => c.name === "beginPlanning")?.agency).toBe("agent");
    expect(desc.commands.find((c) => c.name === "abandon")?.agency).toBeUndefined();
  });

  it("includes generated structural commands (empty args schema, target only), declared first", () => {
    const desc = wiki.describeType("feature-brief");
    const declared = desc.commands.filter((c) => !c.generated);
    const generated = desc.commands.filter((c) => c.generated);
    expect(declared.length).toBeGreaterThan(0);
    expect(generated.length).toBeGreaterThan(0);
    // Declared commands come before generated ones (stable ordering).
    const firstGenerated = desc.commands.findIndex((c) => c.generated);
    const lastDeclared = desc.commands.map((c) => c.generated).lastIndexOf(false);
    expect(lastDeclared).toBeLessThan(firstGenerated);
    // A generated command mirrors describeMutations: empty args schema + a target.
    const gen = generated[0]!;
    expect(gen.argsSchema).toEqual({});
    expect(gen.target?.section).toBeTruthy();
  });

  it("surfaces requiredChildren (the pinned children createPage auto-materializes)", () => {
    const desc = wiki.describeType("feature-brief");
    expect(desc.requiredChildren).toEqual(["implementation-plan", "testing-plan", "feature-spec"]);
    // A leaf type declares none → the field is omitted.
    expect(wiki.describeType("testing-plan").requiredChildren).toBeUndefined();
  });

  it("surfaces the target field-KIND on field-targeting commands (blocks vs prose)", () => {
    const desc = wiki.describeType("feature-spec");
    // design.body is a `blocks` field (its prose runs reject inline Markdown) ...
    expect(
      desc.commands.some(
        (c) => c.target?.section === "design" && c.target?.field === "body" && c.targetKind === "blocks",
      ),
    ).toBe(true);
    // ... while overview.body is `prose`.
    expect(desc.commands.some((c) => c.target?.section === "overview" && c.targetKind === "prose")).toBe(true);
  });

  it("is JSON-serializable — crosses the engine→UI/MCP boundary cleanly", () => {
    const desc = wiki.describeType("feature-brief");
    expect(JSON.parse(JSON.stringify(desc))).toEqual(desc);
  });

  it("throws UnknownPageTypeError for an unregistered type", () => {
    expect(() => wiki.describeType("does-not-exist")).toThrow(UnknownPageTypeError);
  });
});

describe("describeMutations — precondition-aware availability + unmet reason", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;
  let brief: PageId;
  let plan: PageId;
  let testPlan: PageId;
  let caseId: string;
  let stepId: string;

  const shipDescriptor = async (token?: string) => {
    const view = await ws.page(brief, token !== undefined ? { consistentWith: token } : undefined);
    const descriptors = await view.describeMutations();
    return descriptors.find((d) => d.name === "ship")!;
  };

  beforeAll(async () => {
    harness = await createTestWiki(featurePageTypes);
    wiki = harness.wiki;
    ws = await wiki.createWorkspace({ name: "FSM overlay" });
    const created = await ws.createPage("feature-brief", { title: "Inspector", parentId: null });
    brief = created.value;
    const kids = await (await ws.page(brief, { consistentWith: created.token })).children();
    plan = kids.find((k) => k.type === "implementation-plan")!.id;
    testPlan = kids.find((k) => k.type === "testing-plan")!.id;

    // Walk to `review` with the beginImplementation content gates satisfied, but the
    // ship gates (all plan steps done, case passed) deliberately NOT yet satisfied.
    await ws.mutate(brief, "beginPlanning", {});
    stepId = ((await ws.mutate(plan, "addStep", { text: "Do the thing" })).value as { stepId: string }).stepId;
    await ws.mutate(plan, "addDataModel", { language: "ts", source: "interface X {}" });
    caseId = ((await ws.mutate(testPlan, "addCase", { text: "covers it" })).value as { caseId: string }).caseId;
    await ws.mutate(brief, "beginImplementation", {});
    await ws.mutate(brief, "submitForReview", {});
  });
  afterAll(async () => {
    await harness.stop();
  });

  it("reports ship as unavailable WITH a reason while a ship gate is unmet (in review)", async () => {
    expect(await (await ws.page(brief)).status()).toBe("review");
    const ship = await shipDescriptor();
    expect(ship.available).toBe(false);
    expect(typeof ship.unmet).toBe("string");
    expect(ship.unmet!.length).toBeGreaterThan(0);
    // ship is a sign-off edge — legal from `review`, so its model-declared agency is present
    // even though it is currently precondition-blocked.
    expect(ship.agency).toBe("human");
  });

  it("distinguishes FSM-illegal (no reason) from precondition-blocked (with reason)", async () => {
    const descriptors = await (await ws.page(brief)).describeMutations();
    const beginPlanning = descriptors.find((d) => d.name === "beginPlanning")!;
    // Not a legal transition from `review` at all → unavailable, and no precondition reason.
    expect(beginPlanning.available).toBe(false);
    expect(beginPlanning.unmet).toBeUndefined();
    // agency is read off the edge legal-from-current-status, so an unreachable edge has none.
    expect(beginPlanning.agency).toBeUndefined();
  });

  it("surfaces model-declared agency on the reachable edges of a fresh (draft) brief", async () => {
    const fresh = await ws.createPage("feature-brief", { title: "Agency", parentId: null });
    const descriptors = await (await ws.page(fresh.value, { consistentWith: fresh.token })).describeMutations();
    const by = (n: string) => descriptors.find((d) => d.name === n)!;
    // draft → beginPlanning is the forward edge the agent drives; abandon is an unclassified
    // escape edge; ship isn't legal from draft, so it carries no agency here.
    expect(by("beginPlanning").agency).toBe("agent");
    expect(by("abandon").agency).toBeUndefined();
    expect(by("ship").agency).toBeUndefined();
  });

  // NOTE: must run last in this block — it mutates the suite-shared plan/testPlan to
  // satisfy the ship gates the earlier tests rely on being UNMET (declaration order is
  // load-bearing; do not enable sequence.shuffle for this file).
  it("flips ship to available (no unmet) once every ship precondition holds", async () => {
    await ws.mutate(plan, "markStepDone", { stepId });
    const passed = await ws.mutate(testPlan, "markCasePassed", { caseId });
    const ship = await shipDescriptor(passed.token);
    expect(ship.available).toBe(true);
    expect(ship.unmet).toBeUndefined();
    // Still a human gate once fully unblocked — agency is independent of availability.
    expect(ship.agency).toBe("human");
  });
});
