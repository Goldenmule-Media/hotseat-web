/**
 * `as: "stack"` — the render mode for a list whose items ARE rich text.
 *
 * `as: "sections"` cannot express this: it always emits a heading, and an empty
 * heading template produces a bare `###` with trailing whitespace, which the
 * canonical Markdown contract forbids. These tests pin that difference down.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IWorkspaceHandle, PageId } from "../src/api";
import { definePageType, parseBlocks, t, z, zodSchema } from "../src/authoring";
import { createTestWiki, type ITestWiki } from "../src/testing";

const Notes = definePageType({
  type: "stack-fixture",
  version: 1,
  initialStatus: "open",
  statusTransitions: [t("open", "close", "closed")],
  sections: {
    notes: { name: "Notes", required: true, fields: { items: { kind: "list", element: "note", ordered: true } } },
  },
  elements: { note: { fields: { body: { kind: "blocks", required: true } } } },
  sectionSet: { mode: "closed" },
  commands: {
    addNote: {
      args: zodSchema(z.object({ markdown: z.string() })),
      result: zodSchema(z.object({ noteId: z.string() })),
      target: { section: "notes", field: "items" },
      produces: (_page, args, ctx) => [
        {
          op: "addElement",
          section: "notes",
          field: "items",
          id: ctx.newId(),
          fields: { body: { kind: "blocks", blocks: parseBlocks((args as { markdown: string }).markdown, ctx.newId) } },
        },
      ],
    },
  },
  render: {
    title: "Notes: {title}",
    graphSections: false,
    sections: [
      {
        section: "notes",
        heading: "Notes",
        field: "items",
        as: "stack",
        placeholder: "_No notes yet._",
        element: { body: [{ field: "body" }] },
      },
    ],
  },
});

describe("as: stack", () => {
  let tw: ITestWiki;
  let ws: IWorkspaceHandle;
  let pageId: PageId;

  beforeAll(async () => {
    tw = await createTestWiki([Notes]);
    ws = await tw.wiki.createWorkspace({ name: "Stack" });
    pageId = (await ws.createPage("stack-fixture", { title: "Reading", parentId: null })).value;
  });
  afterAll(async () => tw.stop());

  const md = (): Promise<string> => ws.toMarkdown(pageId);

  it("renders the declared placeholder while the list is empty", async () => {
    expect(await md()).toContain("_No notes yet._");
  });

  it("stacks each element's body as top-level blocks, with no heading or ordinal", async () => {
    await ws.mutate(pageId, "addNote", { markdown: "First thought." });
    await ws.mutate(pageId, "addNote", { markdown: "## A heading inside a note\n\nSecond thought." });
    const body = await md();
    expect(body).toContain("First thought.");
    expect(body).toContain("Second thought.");
    // The element's OWN heading survives; the renderer adds none of its own, and in
    // particular never emits the bare `###` an empty `as: "sections"` template would.
    expect(body).toContain("## A heading inside a note");
    expect(body).not.toMatch(/^#{3}\s*$/m);
    expect(body).not.toMatch(/^###\s+1\./m);
  });

  it("keeps the canonical Markdown contract — no trailing whitespace, no blank runs", async () => {
    const body = await md();
    expect(body).not.toMatch(/[ \t]+$/m);
    expect(body).not.toMatch(/\n{3,}/);
    expect(body.endsWith("\n")).toBe(true);
  });

  it("renders images inside a stacked note", async () => {
    const ref = `attachment:${"a".repeat(64)}`;
    await ws.mutate(pageId, "addNote", { markdown: `![A screenshot](${ref})` });
    expect(await md()).toContain(`![A screenshot](${ref})`);
  });

  it("renders one element the same way on its own", async () => {
    const { value } = await ws.mutate(pageId, "addNote", { markdown: "Standalone." });
    const view = await ws.page(pageId);
    expect(await view.renderElement("notes", (value as { noteId: string }).noteId)).toBe("Standalone.");
  });
});
