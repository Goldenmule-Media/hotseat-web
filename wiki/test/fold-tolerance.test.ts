/**
 * Fold tolerance under schema evolution (the registry-swap incident).
 *
 * SUBTRACTIVE: a page type's section decl is DELETED after history recorded writes to
 * it. Re-folding the same durable stream under the new registry must load cleanly —
 * every orphaned op (setField / element ops / block ops / applyTextEdits / setMeta /
 * renameSection) skips as a no-op — while the surviving content folds and renders.
 * ADDITIVE twin: a decl that GAINS sections after old pages were created renders them
 * as placeholders (required sections re-materialize at the PageCreated replay from the
 * CURRENT registry; non-required ones are simply absent → placeholder).
 * DECIDE STAYS LOUD: a NEW write targeting a nonexistent section still rejects with
 * SectionNotFoundError — tolerance is fold-only (`ApplyOpsCtx.tolerant`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BlockId, IWiki, PageId, WorkspaceId } from "../src/api";
import { definePageType, t, z, zodSchema } from "../src/authoring";
import { SectionNotFoundError } from "../src/core/errors";
import { createTestWiki, wikiOn, type ITestWiki } from "../src/testing";

/** V1: `overview` holds prose + list + blocks + code; `notes` holds prose. */
const V1 = definePageType({
  type: "evo-fixture",
  version: 1,
  initialStatus: "draft",
  statusTransitions: [t("draft", "seal", "sealed")],
  sections: {
    overview: {
      name: "Overview",
      required: true,
      fields: {
        body: { kind: "prose" },
        items: { kind: "list", element: "note" },
        doc: { kind: "blocks" },
        src: { kind: "code" },
      },
    },
    notes: { name: "Notes", required: true, fields: { body: { kind: "prose" } } },
  },
  elements: { note: { fields: { text: { kind: "prose" } } } },
  sectionSet: { mode: "closed" },
  commands: {
    // Records the op families the generated commands can't emit: addBlock,
    // renameSection, setMeta — all targeting the section V2 deletes.
    touchOverview: {
      args: zodSchema(z.object({})),
      target: { section: "overview" },
      produces: (_page, _args, ctx) => [
        {
          op: "addBlock",
          section: "overview",
          field: "doc",
          block: { kind: "paragraph", id: ctx.newId() as BlockId, inlines: [{ kind: "text", value: "hello", marks: [] }] },
        },
        { op: "renameSection", section: "overview", name: "Overview (renamed)" },
        { op: "setMeta", section: "overview", path: ["k"], value: "v" },
      ],
    },
  },
  render: {
    title: "{title}",
    graphSections: false,
    sections: [
      { section: "overview", field: "body" },
      { section: "notes", field: "body" },
    ],
  },
});

/** V2: `overview` DELETED; `extras` (non-required) and `summary` (required) GAINED. */
const V2 = definePageType({
  type: "evo-fixture",
  version: 1,
  initialStatus: "draft",
  statusTransitions: [t("draft", "seal", "sealed")],
  sections: {
    notes: { name: "Notes", required: true, fields: { body: { kind: "prose" } } },
    extras: { name: "Extras", fields: { body: { kind: "prose" } } },
    summary: { name: "Summary", required: true, fields: { body: { kind: "prose" } } },
  },
  sectionSet: { mode: "closed" },
  commands: {
    writeGhost: {
      args: zodSchema(z.object({})),
      target: { section: "ghost" },
      produces: () => [{ op: "setField", section: "ghost", field: "body", value: { kind: "prose", value: "x" } }],
    },
  },
  render: {
    title: "{title}",
    graphSections: false,
    sections: [
      { section: "notes", field: "body" },
      { section: "extras", field: "body", heading: "Extras" },
      { section: "summary", field: "body" },
    ],
  },
});

describe("fold tolerance across a registry swap", () => {
  let harness: ITestWiki;
  let wiki2: IWiki;
  let wsId: WorkspaceId;
  let pageId: PageId;

  beforeAll(async () => {
    harness = await createTestWiki([V1]);
    const ws = await harness.wiki.createWorkspace({ name: "Evo" });
    wsId = ws.id;
    pageId = (await ws.createPage("evo-fixture", { title: "Page", parentId: null })).value;
    // Record one op of every family against `overview` (generated + produces paths).
    await ws.mutate(pageId, "setOverviewBody", { value: { kind: "prose", value: "legacy" } });
    const added = (await ws.mutate(pageId, "addOverviewItemsElement", {
      fields: { text: { kind: "prose", value: "n1" } },
    })).value as { id: string };
    await ws.mutate(pageId, "setOverviewItemsText", { id: added.id, value: { kind: "prose", value: "n2" } });
    await ws.mutate(pageId, "moveOverviewItemsElement", { id: added.id, toIndex: 0 });
    await ws.mutate(pageId, "setOverviewSrc", { value: { kind: "code", lang: "ts", source: "let a = 1;", hash: "" } });
    await ws.mutate(pageId, "applyOverviewSrcEdits", { edits: [{ start: 4, end: 5, replacement: "b" }] });
    await ws.mutate(pageId, "touchOverview", {});
    await ws.mutate(pageId, "setNotesBody", { value: { kind: "prose", value: "keep me" } });
    // THE SWAP: same durable stream, a fresh engine whose registry dropped `overview` —
    // mirroring a model-bundle reload. The old engine closes; the new one re-folds.
    await harness.wiki.close();
    wiki2 = wikiOn(harness.url, [V2]);
  });

  afterAll(async () => {
    await wiki2.close();
    await harness.server.stop();
  });

  it("re-folds the same stream cleanly: orphaned ops skip, surviving content folds", async () => {
    const ws2 = await wiki2.openWorkspace(wsId); // the incident: this threw SectionNotFoundError
    const state = await (await ws2.page(pageId)).state();
    expect([...state.sections.map((s) => s.key)].sort()).toEqual(["notes", "summary"]);
    expect(state.sections.find((s) => s.key === "notes")!.fields["body"]).toEqual({
      kind: "prose",
      value: "keep me",
    });
  });

  it("renders the re-folded page: kept content, placeholders for GAINED sections (additive twin)", async () => {
    const ws2 = await wiki2.openWorkspace(wsId);
    const md = await ws2.toMarkdown(pageId);
    expect(md).toContain("## Notes\nkeep me");
    // `summary` (gained, required) is re-materialized empty by the PageCreated replay;
    // `extras` (gained, non-required) never materializes on the old page — BOTH render
    // as placeholders, never a SectionNotFoundError on the every-commit render path.
    expect(md).toContain("## Summary\n_None._");
    expect(md).toContain("## Extras\n_None._");
  });

  it("still accepts new writes after the swap", async () => {
    const ws2 = await wiki2.openWorkspace(wsId);
    const { token } = await ws2.mutate(pageId, "setNotesBody", { value: { kind: "prose", value: "post-swap" } });
    expect(await ws2.toMarkdown(pageId, { consistentWith: token })).toContain("## Notes\npost-swap");
  });

  it("decide stays loud: a produces op targeting a nonexistent section rejects", async () => {
    const ws2 = await wiki2.openWorkspace(wsId);
    await expect(ws2.mutate(pageId, "writeGhost", {})).rejects.toThrow(SectionNotFoundError);
  });

  it("decide stays loud: a generated command on a declared-but-unmaterialized section rejects", async () => {
    const ws2 = await wiki2.openWorkspace(wsId);
    await expect(
      ws2.mutate(pageId, "setExtrasBody", { value: { kind: "prose", value: "x" } }),
    ).rejects.toThrow(SectionNotFoundError);
  });
});
