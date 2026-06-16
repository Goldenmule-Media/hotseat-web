/**
 * Render-time ordinal references + the `as: "sections"` list render mode.
 *
 * Proves the engine renders rich list elements as numbered H3 subsections, hides
 * status-filtered elements, and resolves an `$ordinal` element-ref to the target's CURRENT
 * render-time ordinal — so the list AND every reference renumber together when an element is
 * resolved/hidden or reordered, degrading to a stable label (the target's title) when the
 * target has no ordinal (filtered out of every rendered group, or cross-page). Schema-
 * agnostic: a tiny fixture type drives it; the engine knows nothing of "findings".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BlockId, IBlock, IWiki, IWorkspaceHandle, PageId, RefTarget, SectionId, SectionOp } from "../src/api";
import { arg, definePageType, t, z, zodSchema } from "../src/authoring";
import { createTestWiki, type ITestWiki } from "../src/testing";

// A finding-like element: a title + an optional `detail` blocks field that can hold an inline
// element-ref to a sibling. Only OPEN findings render (the resolved group is not listed), so
// resolving one hides it and renumbers the rest.
const AuditFixture = definePageType({
  type: "audit-fixture",
  version: 1,
  initialStatus: "open",
  statusTransitions: [t("open", "close", "closed")],
  sections: {
    findings: {
      name: "Findings",
      required: true,
      mutableIn: ["open"],
      fields: { items: { kind: "list", element: "finding" } },
    },
  },
  elements: {
    finding: {
      fields: {
        title: { kind: "prose", required: true },
        detail: { kind: "blocks" },
      },
      status: {
        initial: "open",
        transitions: [t("open", "resolve", "resolved"), t("resolved", "reopen", "open")],
      },
    },
  },
  sectionSet: { mode: "closed" },
  commands: {
    addFinding: {
      args: zodSchema(z.object({ title: z.string() })),
      result: zodSchema(z.object({ findingId: z.string() })),
      target: { section: "findings", field: "items" },
      set: { title: arg("title") },
    },
    // Set `source`'s detail to "see <ref to target>", where the ref renders the target's
    // render-time ordinal (degrading to its title when the target is hidden).
    citeFinding: {
      args: zodSchema(z.object({ sourceId: z.string(), targetId: z.string() })),
      target: { section: "findings", field: "items" },
      produces: (page, args, ctx) => {
        const a = args as { sourceId: string; targetId: string };
        const sec = page.sections.find((s) => s.key === "findings");
        if (sec === undefined) return [];
        const target: RefTarget = {
          kind: "element",
          section: sec.id as SectionId,
          field: "items",
          element: a.targetId,
          labelField: "$ordinal:title",
        };
        return [detailOp(a.sourceId, target, ctx.newId())];
      },
    },
    // Set `source`'s detail to "see <ref>" for an arbitrary caller-built ref target — used to
    // exercise a cross-page ref and a plain (non-$ordinal) labelField.
    citeRaw: {
      args: zodSchema(z.object({ sourceId: z.string(), target: z.any() })),
      target: { section: "findings", field: "items" },
      produces: (_page, args, ctx) => {
        const a = args as { sourceId: string; target: RefTarget };
        return [detailOp(a.sourceId, a.target, ctx.newId())];
      },
    },
    resolveFinding: {
      args: zodSchema(z.object({ findingId: z.string() })),
      target: { section: "findings", field: "items", element: { idArg: "findingId" } },
      transition: { level: "element", event: "resolve" },
    },
    reorderFindings: {
      args: zodSchema(z.object({ orderedIds: z.array(z.string()) })),
      target: { section: "findings", field: "items" },
      produces: (_page, args) => {
        const ids = (args as { orderedIds: string[] }).orderedIds;
        return ids.map(
          (id, index): SectionOp => ({ op: "moveElement", section: "findings", field: "items", id, toIndex: index }),
        );
      },
    },
  },
  render: {
    title: "{title}",
    graphSections: false,
    sections: [
      {
        section: "findings",
        field: "items",
        groupBy: "status",
        groups: [{ when: "open", heading: "Findings" }],
        as: "sections",
        element: { heading: "{title}", body: [{ field: "detail" }] },
      },
    ],
  },
});

/** A `setElementField` op writing `detail` to a single paragraph "see <ref>". */
function detailOp(sourceId: string, target: RefTarget, blockId: string): SectionOp {
  const blocks: IBlock[] = [
    {
      kind: "paragraph",
      id: blockId as BlockId,
      inlines: [
        { kind: "text", value: "see ", marks: [] },
        { kind: "ref", target },
      ],
    },
  ];
  return { op: "setElementField", section: "findings", field: "items", id: sourceId, elementField: "detail", value: { kind: "blocks", blocks } };
}

describe("as: 'sections' render + $ordinal element refs", () => {
  let harness: ITestWiki;
  let wiki: IWiki;
  let ws: IWorkspaceHandle;

  beforeAll(async () => {
    harness = await createTestWiki([AuditFixture]);
    wiki = harness.wiki;
    ws = await wiki.createWorkspace({ name: "Audit" });
  });

  afterAll(async () => {
    await harness.stop();
  });

  let pageSeq = 0;
  /** A fresh page with the given finding titles; returns the page id + each finding id by title. */
  async function page(titles: string[]): Promise<{ id: PageId; ids: Record<string, string> }> {
    const id = (await ws.createPage("audit-fixture", { title: `Audit ${pageSeq++}`, parentId: null })).value;
    const ids: Record<string, string> = {};
    for (const title of titles) {
      const r = await ws.mutate(id, "addFinding", { title });
      ids[title] = (r.value as { findingId: string }).findingId;
    }
    return { id, ids };
  }

  it("renders each open finding as a numbered H3 subsection", async () => {
    const { id } = await page(["Alpha", "Bravo", "Charlie"]);
    const md = await ws.toMarkdown(id);
    expect(md).toContain("## Findings");
    expect(md).toContain("### 1. Alpha");
    expect(md).toContain("### 2. Bravo");
    expect(md).toContain("### 3. Charlie");
    // Deterministic: equal state renders byte-identically.
    expect(await ws.toMarkdown(id)).toBe(md);
  });

  it("resolves an $ordinal ref to the target's current ordinal", async () => {
    const { id, ids } = await page(["Alpha", "Bravo", "Charlie"]);
    await ws.mutate(id, "citeFinding", { sourceId: ids.Charlie, targetId: ids.Alpha });
    const md = await ws.toMarkdown(id);
    // Charlie (ordinal 3) references Alpha (ordinal 1).
    expect(md).toMatch(/### 3\. Charlie\nsee 1\b/);
  });

  it("renumbers the list AND references when an earlier finding is resolved", async () => {
    const { id, ids } = await page(["Alpha", "Bravo", "Charlie", "Delta"]);
    await ws.mutate(id, "citeFinding", { sourceId: ids.Delta, targetId: ids.Charlie });
    expect(await ws.toMarkdown(id)).toMatch(/### 4\. Delta\nsee 3\b/); // Charlie is ordinal 3

    await ws.mutate(id, "resolveFinding", { findingId: ids.Alpha });
    const md = await ws.toMarkdown(id);
    expect(md).not.toContain("Alpha"); // resolved → hidden entirely
    expect(md).toContain("### 1. Bravo");
    expect(md).toContain("### 2. Charlie");
    expect(md).toMatch(/### 3\. Delta\nsee 2\b/); // reference renumbered 3 → 2
  });

  it("degrades a reference to the target's title when the target is resolved/hidden", async () => {
    const { id, ids } = await page(["Alpha", "Bravo", "Charlie", "Delta"]);
    await ws.mutate(id, "citeFinding", { sourceId: ids.Delta, targetId: ids.Charlie });
    await ws.mutate(id, "resolveFinding", { findingId: ids.Charlie });
    const md = await ws.toMarkdown(id);
    expect(md).not.toMatch(/### \d+\. Charlie/); // Charlie no longer a rendered subsection
    expect(md).toContain("see Charlie"); // ref degraded to the title, not a stale number/id
  });

  it("renumbers a reference when findings are reordered", async () => {
    const { id, ids } = await page(["Alpha", "Bravo", "Charlie"]);
    await ws.mutate(id, "citeFinding", { sourceId: ids.Charlie, targetId: ids.Alpha });
    expect(await ws.toMarkdown(id)).toMatch(/see 1\b/); // Alpha is ordinal 1

    await ws.mutate(id, "reorderFindings", { orderedIds: [ids.Bravo, ids.Alpha, ids.Charlie] });
    const md = await ws.toMarkdown(id);
    expect(md).toContain("### 1. Bravo");
    expect(md).toContain("### 2. Alpha");
    expect(md).toMatch(/### 3\. Charlie\nsee 2\b/); // Alpha is now ordinal 2
  });

  it("leaves a plain (non-$ordinal) labelField rendering the stored field", async () => {
    const { id, ids } = await page(["Alpha", "Bravo"]);
    const state = await (await ws.page(id)).state();
    const sectionId = state.sections.find((s) => s.key === "findings")!.id as SectionId;
    const target: RefTarget = { kind: "element", section: sectionId, field: "items", element: ids.Alpha, labelField: "title" };
    await ws.mutate(id, "citeRaw", { sourceId: ids.Bravo, target });
    const md = await ws.toMarkdown(id);
    expect(md).toContain("see Alpha"); // the stored title, never an ordinal
  });

  it("falls back to a stable label for a cross-page $ordinal ref", async () => {
    const a = await page(["Alpha"]);
    const b = await page(["Zulu"]);
    const aState = await (await ws.page(a.id)).state();
    const aSection = aState.sections.find((s) => s.key === "findings")!.id as SectionId;
    // A ref FROM page b's "Zulu" TO page a's "Alpha" with $ordinal — cross-page, so no ordinal.
    const target: RefTarget = { kind: "element", page: a.id, section: aSection, field: "items", element: a.ids.Alpha, labelField: "$ordinal:title" };
    await ws.mutate(b.id, "citeRaw", { sourceId: b.ids.Zulu, target });
    const md = await ws.toMarkdown(b.id);
    expect(md).toContain("see Alpha"); // degraded to the cross-page title, no number, no throw
    expect(md).not.toMatch(/see \d/);
  });
});
