/**
 * `IPageView.renderElement` — render ONE list element exactly as the full page render
 * presents it: the numbered H3 subsection for `as: "sections"` (ordinal from current
 * state), the single item line for bullets/numbered/checklist, the documented fallback
 * for an element filtered out of every rendered group, and the missing-target errors.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IWorkspaceHandle, PageId } from "../src/api";
import { arg, definePageType, t, z, zodSchema } from "../src/authoring";
import { ItemNotFoundError, SectionNotFoundError } from "../src/core/errors";
import { createTestWiki, type ITestWiki } from "../src/testing";

const Fixture = definePageType({
  type: "re-fixture",
  version: 1,
  initialStatus: "open",
  statusTransitions: [t("open", "close", "closed")],
  sections: {
    findings: { name: "Findings", required: true, fields: { items: { kind: "list", element: "finding" } } },
    remarks: { name: "Remarks", required: true, fields: { items: { kind: "list", element: "finding" } } },
    tasks: { name: "Tasks", required: true, fields: { items: { kind: "list", element: "task" } } },
    steps: { name: "Steps", required: true, fields: { items: { kind: "list", element: "step" } } },
  },
  elements: {
    finding: {
      fields: { title: { kind: "prose", required: true }, detail: { kind: "prose" } },
      status: { initial: "open", transitions: [t("open", "resolve", "resolved")] },
    },
    task: {
      fields: { text: { kind: "prose", required: true } },
      status: { initial: "todo", transitions: [t("todo", "finish", "done")] },
    },
    step: { fields: { text: { kind: "prose", required: true } } },
  },
  sectionSet: { mode: "closed" },
  commands: {
    addFinding: {
      args: zodSchema(z.object({ title: z.string(), detail: z.string().optional() })),
      result: zodSchema(z.object({ findingId: z.string() })),
      target: { section: "findings", field: "items" },
      set: { title: arg("title"), detail: arg("detail") },
    },
    resolveFinding: {
      args: zodSchema(z.object({ findingId: z.string() })),
      target: { section: "findings", field: "items", element: { idArg: "findingId" } },
      transition: { level: "element", event: "resolve" },
    },
    addRemark: {
      args: zodSchema(z.object({ title: z.string(), detail: z.string().optional() })),
      result: zodSchema(z.object({ remarkId: z.string() })),
      target: { section: "remarks", field: "items" },
      set: { title: arg("title"), detail: arg("detail") },
    },
    addTask: {
      args: zodSchema(z.object({ text: z.string() })),
      result: zodSchema(z.object({ taskId: z.string() })),
      target: { section: "tasks", field: "items" },
      set: { text: arg("text") },
    },
    finishTask: {
      args: zodSchema(z.object({ taskId: z.string() })),
      target: { section: "tasks", field: "items", element: { idArg: "taskId" } },
      transition: { level: "element", event: "finish" },
    },
    addStep: {
      args: zodSchema(z.object({ text: z.string() })),
      result: zodSchema(z.object({ stepId: z.string() })),
      target: { section: "steps", field: "items" },
      set: { text: arg("text") },
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
        groups: [{ when: "open", heading: "Open findings" }],
        as: "sections",
        element: { heading: "{title}", body: [{ label: "Detail", field: "detail" }] },
      },
      {
        section: "remarks",
        field: "items",
        as: "sections",
        numbered: false,
        element: { heading: "{title}", body: [{ label: "Detail", field: "detail" }] },
      },
      { section: "tasks", field: "items", as: "checklist", item: "{text}", checkedWhen: "done" },
      { section: "steps", field: "items", as: "numbered", item: "{text}" },
    ],
  },
});

describe("IPageView.renderElement", () => {
  let harness: ITestWiki;
  let ws: IWorkspaceHandle;

  beforeAll(async () => {
    harness = await createTestWiki([Fixture]);
    ws = await harness.wiki.createWorkspace({ name: "RenderElement" });
  });

  afterAll(async () => {
    await harness.stop();
  });

  let seq = 0;
  async function makePage(): Promise<PageId> {
    return (await ws.createPage("re-fixture", { title: `Page ${seq++}`, parentId: null })).value;
  }

  it("renders an as:'sections' element as its numbered H3 subsection, matching the full render", async () => {
    const id = await makePage();
    await ws.mutate(id, "addFinding", { title: "Alpha", detail: "first detail" });
    const bravo = (await ws.mutate(id, "addFinding", { title: "Bravo", detail: "second detail" })).value as {
      findingId: string;
    };
    const view = await ws.page(id);
    const fragment = await view.renderElement("findings", bravo.findingId);
    expect(fragment).toBe("### 2. Bravo\n**Detail:** second detail");
    expect(await ws.toMarkdown(id)).toContain(fragment);
  });

  it("renders an as:'sections' element UNNUMBERED under numbered: false, matching the full render", async () => {
    const id = await makePage();
    await ws.mutate(id, "addRemark", { title: "Alpha", detail: "first detail" });
    const bravo = (await ws.mutate(id, "addRemark", { title: "Bravo", detail: "second detail" })).value as {
      remarkId: string;
    };
    const view = await ws.page(id);
    const fragment = await view.renderElement("remarks", bravo.remarkId);
    expect(fragment).toBe("### Bravo\n**Detail:** second detail");
    expect(await ws.toMarkdown(id)).toContain(fragment);
  });

  it("recomputes the ordinal from current state (renumbers after a resolve)", async () => {
    const id = await makePage();
    const alpha = (await ws.mutate(id, "addFinding", { title: "Alpha" })).value as { findingId: string };
    const bravo = (await ws.mutate(id, "addFinding", { title: "Bravo", detail: "d" })).value as { findingId: string };
    await ws.mutate(id, "resolveFinding", { findingId: alpha.findingId });
    const view = await ws.page(id);
    const fragment = await view.renderElement("findings", bravo.findingId);
    expect(fragment).toBe("### 1. Bravo\n**Detail:** d"); // Alpha hidden → Bravo renumbered 2 → 1
    expect(await ws.toMarkdown(id)).toContain(fragment);
  });

  it("still renders an element filtered out of every group, with its stored position as the ordinal", async () => {
    // DOCUMENTED CHOICE: a resolved finding has no rendered group (only `open` is listed),
    // so the FULL render omits it — but renderElement still renders it via the base
    // config's element template, falling back to its 1-based stored-order position.
    const id = await makePage();
    const alpha = (await ws.mutate(id, "addFinding", { title: "Alpha", detail: "hidden detail" })).value as {
      findingId: string;
    };
    await ws.mutate(id, "addFinding", { title: "Bravo" });
    await ws.mutate(id, "resolveFinding", { findingId: alpha.findingId });
    const view = await ws.page(id);
    const fragment = await view.renderElement("findings", alpha.findingId);
    expect(fragment).toBe("### 1. Alpha\n**Detail:** hidden detail");
    expect(await ws.toMarkdown(id)).not.toContain("Alpha"); // the full render filters it out
  });

  it("renders a checklist element as its item line, tracking its status", async () => {
    const id = await makePage();
    const a = (await ws.mutate(id, "addTask", { text: "write tests" })).value as { taskId: string };
    const view = await ws.page(id);
    expect(await view.renderElement("tasks", a.taskId)).toBe("- [ ] write tests");
    await ws.mutate(id, "finishTask", { taskId: a.taskId });
    const line = await view.renderElement("tasks", a.taskId);
    expect(line).toBe("- [x] write tests");
    expect(await ws.toMarkdown(id)).toContain(line);
  });

  it("renders a numbered element as its ordinal line, matching the full render", async () => {
    const id = await makePage();
    await ws.mutate(id, "addStep", { text: "first" });
    const b = (await ws.mutate(id, "addStep", { text: "second" })).value as { stepId: string };
    const view = await ws.page(id);
    const line = await view.renderElement("steps", b.stepId);
    expect(line).toBe("2. second");
    expect(await ws.toMarkdown(id)).toContain(line);
  });

  it("throws the engine's missing-target errors for an unknown section or element", async () => {
    const id = await makePage();
    const a = (await ws.mutate(id, "addStep", { text: "only" })).value as { stepId: string };
    const view = await ws.page(id);
    await expect(view.renderElement("nope", a.stepId)).rejects.toThrow(SectionNotFoundError);
    await expect(view.renderElement("steps", "no-such-element")).rejects.toThrow(ItemNotFoundError);
  });
});
