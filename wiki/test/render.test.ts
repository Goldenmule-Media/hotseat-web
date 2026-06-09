/**
 * Renderer unit tests.
 *
 * The feature-brief renderer is deterministic: equal state → byte-identical output.
 * We drive a live (in-memory) wiki through the worked-example script to the mid-flight
 * snapshot (status `building`, q1 resolved, q2 moved off, two commits, one reference),
 * then assert:
 *   - the rendered Markdown matches the expected shape EXACTLY (byte-for-byte),
 *   - rendering the SAME state twice is byte-identical (no wall clock / RNG leak),
 *   - an independently-built wiki with the SAME script renders identically.
 *
 * One server per file (beforeAll/afterAll).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IWorkspaceHandle, PageId } from "../src/api";
import { featurePageTypes } from "wiki-models/feature";
import { createTestWiki, type ITestWiki } from "../src/testing";

/**
 * Build the "Bulk export" brief at status `building` and return the handle +
 * the brief's page id. `rbacTitle` is the title of a sibling brief used as the
 * `depends-on` reference target.
 */
async function buildBuildingBrief(
  ws: IWorkspaceHandle,
): Promise<{ brief: PageId; plan: PageId; testPlan: PageId; token: string }> {
  // A sibling brief to reference (the "Access control (RBAC)").
  const { value: rbac } = await ws.createPage("feature-brief", {
    title: "Access control (RBAC)",
    parentId: null,
  });

  const { value: brief, token: briefToken } = await ws.createPage("feature-brief", {
    title: "Bulk export",
    parentId: null,
  });
  const briefView = await ws.page(brief, { consistentWith: briefToken });
  const [plan, testPlan] = (await briefView.children()).map((c) => c.id);

  // Give the mandated children the display titles used in the worked example.
  await ws.setPageTitle(plan, "Implementation plan");
  await ws.setPageTitle(testPlan, "Testing plan");

  // ── fill the brief (draft) ──
  await ws.mutate(brief, "setSummary", {
    text: "Let users export their workspace as CSV/JSON.",
  });
  await ws.mutate(brief, "addComponent", { name: "web-app" });
  await ws.mutate(brief, "addComponent", { name: "cli" });
  await ws.mutate(brief, "addConstraint", {
    text: "Export must stream; never buffer >50MB in memory.",
  });
  const { questionId: q1 } = (await ws.mutate(brief, "askQuestion", {
    text: "Which formats in v1?",
  })).value as { questionId: string };
  await ws.mutate(brief, "answerQuestion", {
    questionId: q1,
    answer: "CSV and JSON; Parquet later.",
  });
  await ws.link(brief, rbac, "depends-on");

  // ── planning ──
  await ws.mutate(brief, "beginPlanning", {});
  await ws.mutate(plan, "addStep", { text: "Stream a ReadableStream from a new /export endpoint." });
  await ws.mutate(plan, "addDataModel", {
    language: "ts",
    source: 'export interface ExportRequest {\n  format: "csv" | "json";\n}',
  });
  await ws.mutate(testPlan, "addCase", { text: "10k-row export < 2s, memory flat." });

  // A planning-detail question moved off the brief onto the plan (atomic cross-page move).
  const { questionId: q2 } = (await ws.mutate(brief, "askQuestion", {
    text: "Page size while streaming?",
  })).value as { questionId: string };
  await ws.moveItem({ from: brief, to: plan, section: "questions", field: "items", itemId: q2 });

  // ── implementation (gated) ──
  await ws.mutate(brief, "beginImplementation", {});
  await ws.mutate(brief, "recordCommit", {
    sha: "a1b2c3d",
    message: "feat(api): streaming export endpoint",
  });
  const { token } = await ws.mutate(brief, "recordCommit", {
    sha: "e4f5g6h",
    message: "feat(cli): wiki export",
  });

  return { brief, plan, testPlan, token };
}

const EXPECTED_BRIEF = `# Feature: Bulk export

**Status:** building

## Summary
Let users export their workspace as CSV/JSON.

## Components affected
- web-app
- cli

## Design constraints
1. Export must stream; never buffer >50MB in memory.

## Open questions
_None._

## Resolved questions
1. **Which formats in v1?** — _CSV and JSON; Parquet later._

## References
- depends-on → [Access control (RBAC)](feature-brief:id-3)

## Child pages
- [Implementation plan](implementation-plan:id-12)
- [Testing plan](testing-plan:id-13)
- [Spec](feature-spec:id-14)

## Commits
- \`a1b2c3d\` feat(api): streaming export endpoint
- \`e4f5g6h\` feat(cli): wiki export
`;

describe("feature-brief render — byte-stable shape", () => {
  let tw: ITestWiki;
  let ws: IWorkspaceHandle;
  let brief: PageId;
  /** The committed-head token after the build script, for read-your-writes. */
  let token: string;

  beforeAll(async () => {
    tw = await createTestWiki(featurePageTypes);
    ws = await tw.wiki.createWorkspace({ name: "Acme platform" });
    ({ brief, token } = await buildBuildingBrief(ws));
  });

  afterAll(async () => {
    await tw.stop();
  });

  it("matches the mid-flight Markdown byte-for-byte", async () => {
    expect(await ws.toMarkdown(brief, { consistentWith: token })).toBe(EXPECTED_BRIEF);
  });

  it("ends with exactly one trailing newline and uses \\n line endings", async () => {
    const md = await ws.toMarkdown(brief, { consistentWith: token });
    expect(md.endsWith("\n")).toBe(true);
    expect(md.endsWith("\n\n")).toBe(false);
    expect(md.includes("\r")).toBe(false);
  });

  it("renders every section heading exactly once, in order", async () => {
    const md = await ws.toMarkdown(brief, { consistentWith: token });
    const headings = md.split("\n").filter((l) => l.startsWith("## "));
    expect(headings).toEqual([
      "## Summary",
      "## Components affected",
      "## Design constraints",
      "## Open questions",
      "## Resolved questions",
      "## References",
      "## Child pages",
      "## Commits",
    ]);
  });

  it("is byte-identical when rendered repeatedly from the SAME state (no clock/RNG leak)", async () => {
    const a = await ws.toMarkdown(brief, { consistentWith: token });
    const b = await ws.toMarkdown(brief);
    const c = await (await ws.page(brief)).toMarkdown();
    expect(b).toBe(a);
    expect(c).toBe(a);
  });
});

describe("feature-brief render — equal state ⇒ identical output (across independent wikis)", () => {
  it("two independently-built wikis running the same script render byte-identically", async () => {
    const tw1 = await createTestWiki(featurePageTypes);
    const tw2 = await createTestWiki(featurePageTypes);
    try {
      const ws1 = await tw1.wiki.createWorkspace({ name: "Acme platform" });
      const ws2 = await tw2.wiki.createWorkspace({ name: "Acme platform" });
      const { brief: b1, token: t1 } = await buildBuildingBrief(ws1);
      const { brief: b2, token: t2 } = await buildBuildingBrief(ws2);
      expect(await ws1.toMarkdown(b1, { consistentWith: t1 })).toBe(
        await ws2.toMarkdown(b2, { consistentWith: t2 }),
      );
      // And both equal the canonical expectation.
      expect(await ws1.toMarkdown(b1, { consistentWith: t1 })).toBe(EXPECTED_BRIEF);
    } finally {
      await tw1.stop();
      await tw2.stop();
    }
  });
});

describe("workspace render — deterministic tree", () => {
  let tw: ITestWiki;
  let ws: IWorkspaceHandle;
  let token: string;

  beforeAll(async () => {
    tw = await createTestWiki(featurePageTypes);
    ws = await tw.wiki.createWorkspace({ name: "Acme platform" });
    ({ token } = await buildBuildingBrief(ws));
  });

  afterAll(async () => {
    await tw.stop();
  });

  it("renders the workspace tree with type+status annotations, byte-stable", async () => {
    const a = await ws.toMarkdown(undefined, { consistentWith: token });
    const b = await ws.toMarkdown();
    expect(b).toBe(a);
    // The H1 is the workspace name; the building brief and its three children appear.
    expect(a.startsWith("# Acme platform\n")).toBe(true);
    expect(a).toContain("Bulk export (feature-brief, building)");
    expect(a).toContain("Implementation plan (implementation-plan, draft)");
    expect(a).toContain("Testing plan (testing-plan, draft)");
    expect(a).toContain("Spec (feature-spec, drafting)");
  });
});

describe("implementation-plan render — GitHub-style step checkboxes", () => {
  let tw: ITestWiki;
  let ws: IWorkspaceHandle;
  let plan: PageId;
  let token: string;

  beforeAll(async () => {
    tw = await createTestWiki(featurePageTypes);
    ws = await tw.wiki.createWorkspace({ name: "Acme platform" });
    ({ plan } = await buildBuildingBrief(ws));
    const a = (await ws.mutate(plan, "addStep", { text: "Wire the export endpoint" })).value as {
      stepId: string;
    };
    await ws.mutate(plan, "addStep", { text: "Add the CLI flag" });
    ({ token } = await ws.mutate(plan, "markStepDone", { stepId: a.stepId }));
  });

  afterAll(async () => {
    await tw.stop();
  });

  it("renders steps as `- [x]` / `- [ ]` under ## Steps", async () => {
    const md = await ws.toMarkdown(plan, { consistentWith: token });
    expect(md).toContain("## Steps");
    expect(md).toContain("- [x] Wire the export endpoint");
    expect(md).toContain("- [ ] Add the CLI flag");
  });
});
