/**
 * `implementation-checklist` page type — declarative. Tracked work items:
 * building → complete, with `task` list elements (todo ⇄ done).
 */
import { arg, definePageType, t } from "wiki/authoring";
import { z, zodSchema } from "wiki/authoring";

const empty = z.object({});

export const ImplementationChecklist = definePageType({
  type: "implementation-checklist",
  version: 1,
  initialStatus: "building",
  statusTransitions: [t("building", "markComplete", "complete")],
  sections: {
    tasks: {
      name: "Tasks",
      required: true,
      mutableIn: ["building"],
      fields: { items: { kind: "list", element: "task" } },
    },
  },
  elements: {
    task: {
      fields: { text: { kind: "prose", required: true } },
      status: { initial: "todo", transitions: [t("todo", "check", "done"), t("done", "uncheck", "todo")] },
    },
  },
  sectionSet: { mode: "closed" },
  commands: {
    addTask: {
      args: zodSchema(z.object({ text: z.string() })),
      result: zodSchema(z.object({ taskId: z.string() })),
      target: { section: "tasks", field: "items" },
      set: { text: arg("text") },
    },
    checkTask: {
      args: zodSchema(z.object({ taskId: z.string() })),
      target: { section: "tasks", field: "items", element: { idArg: "taskId" } },
      transition: { level: "element", event: "check" },
    },
    uncheckTask: {
      args: zodSchema(z.object({ taskId: z.string() })),
      target: { section: "tasks", field: "items", element: { idArg: "taskId" } },
      transition: { level: "element", event: "uncheck" },
    },
    removeTask: {
      args: zodSchema(z.object({ taskId: z.string() })),
      target: { section: "tasks", field: "items" },
      produces: (_page, args) => [
        { op: "removeElement", section: "tasks", field: "items", id: (args as { taskId: string }).taskId },
      ],
    },
    markComplete: { args: zodSchema(empty), transition: { level: "page", event: "markComplete" } },
  },
  render: {
    title: "{title}",
    sections: [
      {
        section: "tasks",
        heading: "Tasks",
        field: "items",
        groupBy: "status",
        groups: [
          { when: "todo", heading: "To do", item: "{text}" },
          { when: "done", heading: "Done", item: "{text}" },
        ],
      },
    ],
  },
});
