/**
 * Bundle sign-off: shipping the brief CASCADES every pinned child to
 * its terminal status in one atomic commit, so the whole bundle lands aligned instead
 * of "shipped brief over draft/building children". The cascade is fully validated — a
 * child that isn't ready (here: a spec whose resolved decisions aren't all referenced)
 * rejects the entire ship, and because it's one commit, NOTHING moves on a rejection.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IWiki, IWorkspaceHandle, PageId } from "../src/api";
import { PreconditionUnmetError } from "../src/core/errors";
import { featurePageTypes } from "wiki-models/feature";
import { createTestWiki, type ITestWiki } from "../src/testing";

describe("feature bundle: ship signs off and aligns every child atomically", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;
  let brief: PageId;
  let plan: PageId;
  let testPlan: PageId;
  let spec: PageId;
  let q1: string;

  const statusOf = async (id: PageId): Promise<string | undefined> =>
    (await ws.page(id)).status();

  beforeAll(async () => {
    harness = await createTestWiki(featurePageTypes);
    wiki = harness.wiki;
    ws = await wiki.createWorkspace({ name: "Sign-off" });
    const c = await ws.createPage("feature-brief", { title: "Bulk export", parentId: null });
    brief = c.value;
    const kids = await (await ws.page(brief, { consistentWith: c.token })).children();
    plan = kids.find((k) => k.type === "implementation-plan")!.id;
    testPlan = kids.find((k) => k.type === "testing-plan")!.id;
    spec = kids.find((k) => k.type === "feature-spec")!.id;

    // Decide one question (so the spec has a required decision; and no open questions remain).
    q1 = ((await ws.mutate(brief, "askQuestion", { text: "Which formats?" })).value as { questionId: string }).questionId;
    await ws.mutate(brief, "answerQuestion", { questionId: q1, answer: "CSV/JSON." });

    // Plan → buildable, then build → review with all CONTENT gates satisfied.
    await ws.mutate(brief, "beginPlanning", {});
    const step = ((await ws.mutate(plan, "addStep", { text: "Stream the endpoint" })).value as { stepId: string }).stepId;
    await ws.mutate(plan, "addDataModel", { language: "ts", source: "interface E {}" });
    const cs = ((await ws.mutate(testPlan, "addCase", { text: "fast export" })).value as { caseId: string }).caseId;
    await ws.mutate(brief, "beginImplementation", {});
    await ws.mutate(plan, "markStepDone", { stepId: step });
    await ws.mutate(testPlan, "markCasePassed", { caseId: cs });
    await ws.mutate(brief, "submitForReview", {});
  });

  afterAll(async () => {
    await harness.stop();
  });

  it("REJECTS sign-off when the spec isn't reference-complete — and nothing moves (atomic)", async () => {
    expect(await statusOf(brief)).toBe("review");
    await expect(ws.mutate(brief, "ship", {})).rejects.toBeInstanceOf(PreconditionUnmetError);

    // The whole commit was rejected: brief and every child are untouched.
    expect(await statusOf(brief)).toBe("review");
    expect(await statusOf(plan)).toBe("draft");
    expect(await statusOf(testPlan)).toBe("draft");
    expect(await statusOf(spec)).toBe("drafting");
  });

  it("signs off once the spec is complete — brief shipped and every child aligned in one commit", async () => {
    await ws.mutate(spec, "addDecision", { questionId: q1, text: "v1 ships CSV and JSON." });

    const shipped = await ws.mutate(brief, "ship", {});
    // Read every status off the SAME committed token: the cascade was one atomic commit.
    const at = { consistentWith: shipped.token };
    expect(await (await ws.page(brief, at)).status()).toBe("shipped");
    expect(await (await ws.page(plan, at)).status()).toBe("ready");
    expect(await (await ws.page(testPlan, at)).status()).toBe("ready");
    expect(await (await ws.page(spec, at)).status()).toBe("sealed");
  });
});
