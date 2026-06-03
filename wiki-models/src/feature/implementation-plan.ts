/**
 * `implementation-plan` page type — declarative. An ordered plan of attack:
 * draft → ready, with `step` and `question` list elements.
 */
import type { SectionOp } from "wiki/authoring";
import { arg, definePageType, t } from "wiki/authoring";
import { z, zodSchema } from "wiki/authoring";

const empty = z.object({});

export const ImplementationPlan = definePageType({
  type: "implementation-plan",
  version: 1,
  initialStatus: "draft",
  statusTransitions: [t("draft", "markReady", "ready")],
  sections: {
    steps: { name: "Steps", required: true, mutableIn: ["draft"], fields: { items: { kind: "list", element: "step", ordered: true } } },
    questions: {
      name: "Questions",
      required: true,
      mutableIn: ["draft"],
      fields: { items: { kind: "list", element: "question" } },
    },
  },
  elements: {
    step: { fields: { text: { kind: "prose", required: true } } },
    question: {
      fields: { text: { kind: "prose", required: true }, answer: { kind: "prose" } },
      status: { initial: "open", transitions: [t("open", "answer", "resolved")] },
    },
  },
  sectionSet: { mode: "closed" },
  commands: {
    addStep: {
      args: zodSchema(z.object({ text: z.string() })),
      result: zodSchema(z.object({ stepId: z.string() })),
      target: { section: "steps", field: "items" },
      set: { text: arg("text") },
    },
    removeStep: {
      args: zodSchema(z.object({ stepId: z.string() })),
      target: { section: "steps", field: "items" },
      produces: (_page, args) => [
        { op: "removeElement", section: "steps", field: "items", id: (args as { stepId: string }).stepId },
      ],
    },
    reorderSteps: {
      args: zodSchema(z.object({ orderedStepIds: z.array(z.string()) })),
      target: { section: "steps", field: "items" },
      produces: (_page, args) => {
        const ids = (args as { orderedStepIds: string[] }).orderedStepIds;
        const ops: SectionOp[] = [];
        ids.forEach((id, index) => {
          ops.push({ op: "moveElement", section: "steps", field: "items", id, toIndex: index });
        });
        return ops;
      },
    },
    askQuestion: {
      args: zodSchema(z.object({ text: z.string() })),
      result: zodSchema(z.object({ questionId: z.string() })),
      target: { section: "questions", field: "items" },
      set: { text: arg("text") },
    },
    answerQuestion: {
      args: zodSchema(z.object({ questionId: z.string(), answer: z.string() })),
      result: zodSchema(z.object({ questionId: z.string() })),
      target: { section: "questions", field: "items", element: { idArg: "questionId" } },
      set: { answer: arg("answer") },
      transition: { level: "element", event: "answer" },
    },
    markReady: { args: zodSchema(empty), transition: { level: "page", event: "markReady" } },
  },
  render: {
    title: "{title}",
    sections: [
      { section: "steps", heading: "Steps", field: "items", as: "numbered", item: "{text}" },
      {
        section: "questions",
        heading: "Questions",
        field: "items",
        groupBy: "status",
        groups: [
          { when: "open", heading: "Open questions", item: "**{text}**" },
          { when: "resolved", heading: "Resolved questions", item: "**{text}** → {answer}" },
        ],
      },
    ],
  },
});
