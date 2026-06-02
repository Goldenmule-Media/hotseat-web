/**
 * `implementation-checklist` page type (BUILD_NOTES §6). Tracked work items:
 * building → complete, owning `task` items (todo ⇄ done). Pure throughout —
 * ids/time via `ctx.newId`/`ctx.now`, no host clock or RNG; `apply` owns all
 * mutation including item.status.
 */
import type { DomainEvent, IRenderCtx, PageState } from "wiki/authoring";
import { definePageType, t } from "wiki/authoring";
import { zodSchema, z } from "wiki/authoring";
import { bulletList, heading, joinBlocks, placeholder, section, statusBadge } from "wiki/authoring";
import { task } from "./items";

const empty = z.object({}).strict();

type Fields = Record<string, never>;

function applyChecklist(page: PageState<Fields>, event: DomainEvent): PageState<Fields> {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case "ChecklistCompleted":
      page.status = "complete";
      break;
    case "TaskAdded":
      page.items.task.push({ id: p.id as string, text: p.text as string, status: "todo" });
      break;
    case "TaskRemoved":
      page.items.task = page.items.task.filter((tk) => tk.id !== (p.id as string));
      break;
    case "TaskChecked": {
      const tk = page.items.task.find((x) => x.id === (p.id as string));
      if (tk !== undefined) tk.status = "done";
      break;
    }
    case "TaskUnchecked": {
      const tk = page.items.task.find((x) => x.id === (p.id as string));
      if (tk !== undefined) tk.status = "todo";
      break;
    }
  }
  return page;
}

function renderChecklist(page: PageState<Fields>, _ctx: IRenderCtx): string {
  const blocks: string[] = [heading(1, page.title), statusBadge(page.status)];
  const tasks = page.items.task ?? [];
  blocks.push(
    section(
      heading(2, "Tasks"),
      tasks.length === 0
        ? placeholder()
        : bulletList(
            tasks.map((tk) => `[${tk.status === "done" ? "x" : " "}] ${String(tk.text ?? tk.id)}`),
          ),
    ),
  );
  return joinBlocks(blocks);
}

export const ImplementationChecklist = definePageType<Record<string, never>>({
  type: "implementation-checklist",
  initialStatus: "building",
  initialFields: {},
  version: 1,
  items: { task },
  statusTransitions: [
    t("building", "addTask", "building"),
    t("building", "checkTask", "building"),
    t("building", "uncheckTask", "building"),
    t("building", "removeTask", "building"),
    t("building", "markComplete", "complete"),
  ],
  commands: {
    addTask: {
      args: zodSchema(z.object({ text: z.string() })),
      result: zodSchema(z.object({ taskId: z.string() })),
      transition: { level: "page", event: "addTask" },
      produces: (_page, args, ctx) => {
        const id = ctx.newId();
        return {
          events: [{ type: "TaskAdded", payload: { id, text: args.text } }],
          result: { taskId: id },
        };
      },
    },
    checkTask: {
      args: zodSchema(z.object({ taskId: z.string() })),
      transition: { level: "item", itemType: "task", idArg: "taskId", event: "checkTask" },
      produces: (_page, args, _ctx) => ({
        events: [{ type: "TaskChecked", payload: { id: args.taskId } }],
        result: undefined,
      }),
    },
    uncheckTask: {
      args: zodSchema(z.object({ taskId: z.string() })),
      transition: { level: "item", itemType: "task", idArg: "taskId", event: "uncheckTask" },
      produces: (_page, args, _ctx) => ({
        events: [{ type: "TaskUnchecked", payload: { id: args.taskId } }],
        result: undefined,
      }),
    },
    removeTask: {
      args: zodSchema(z.object({ taskId: z.string() })),
      transition: { level: "page", event: "removeTask" },
      produces: (_page, args, _ctx) => ({
        events: [{ type: "TaskRemoved", payload: { id: args.taskId } }],
        result: undefined,
      }),
    },
    markComplete: {
      args: zodSchema(empty),
      transition: { level: "page", event: "markComplete" },
      produces: (_page, _args, _ctx) => ({
        events: [{ type: "ChecklistCompleted", payload: {} }],
        result: undefined,
      }),
    },
  },
  apply: applyChecklist,
  render: renderChecklist,
});
