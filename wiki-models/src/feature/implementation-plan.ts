/**
 * `implementation-plan` page type — declarative. An ordered plan of attack:
 * draft ⇄ ready (reopen backs out of the sealed state), with `step` and
 * `question` list elements.
 */
import type { BlockId, DeepReadonly, PageState, Precondition, SectionOp } from "wiki/authoring";
import { arg, definePageType, t } from "wiki/authoring";
import { z, zodSchema } from "wiki/authoring";

const empty = z.object({});

/** Count `code` blocks in the plan's "Data models & interfaces" section. */
function dataModelCodeBlocks(page: DeepReadonly<PageState>): number {
  const f = page.sections.find((s) => s.key === "dataModels")?.fields["models"];
  return f !== undefined && f.kind === "blocks" ? f.blocks.filter((b) => b.kind === "code").length : 0;
}

/** A plan is not ready until it shows ≥1 major data model / interface as a code block. */
const planHasDataModel: Precondition = (page) =>
  dataModelCodeBlocks(page) >= 1 ? true : { unmet: "needs ≥1 data-model/interface code block" };

export const ImplementationPlan = definePageType({
  type: "implementation-plan",
  description:
    "The step-by-step build plan for a feature. Auto-created as a child of a `feature-brief` — you do not " +
    "create one directly; author into the one the brief materializes.",
  version: 1,
  initialStatus: "draft",
  // markReady carries no `agency`: a child is finalized by the brief's `ship` cascade
  // (whose preconditions check child content), not driven independently by the agent —
  // surfacing it would invite sealing an incomplete child.
  statusTransitions: [t("draft", "markReady", "ready"), t("ready", "reopen", "draft")],
  finalize: "markReady",
  sections: {
    steps: { name: "Steps", required: true, mutableIn: ["draft"], fields: { items: { kind: "list", element: "step", ordered: true } } },
    dataModels: {
      name: "Data models & interfaces",
      required: true,
      mutableIn: ["draft"],
      fields: { models: { kind: "blocks" } },
    },
    questions: {
      name: "Questions",
      required: true,
      mutableIn: ["draft"],
      fields: { items: { kind: "list", element: "question" } },
    },
  },
  elements: {
    // Each step owns its done-state (todo ⇄ done) and renders as a checkbox. markStepDone/
    // markStepTodo are element-FSM transitions carrying no content op, so — like the
    // testing-plan's markCasePassed — they stay legal after the step SET is frozen (`steps` is
    // `mutableIn: ["draft"]`) and after the plan is sealed (`ready`): progress is checked off as
    // work ships, and the brief's `ship` gate reads these statuses directly.
    step: {
      fields: { text: { kind: "prose", required: true } },
      status: { initial: "todo", transitions: [t("todo", "markDone", "done"), t("done", "reopen", "todo")] },
    },
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
    // Per-step progress — element-FSM transitions (no content op), so they remain legal after
    // `markReady` seals the plan, exactly like the testing-plan's markCasePassed. These check
    // off the step's box and feed the brief's `ship` gate.
    markStepDone: {
      args: zodSchema(z.object({ stepId: z.string() })),
      target: { section: "steps", field: "items", element: { idArg: "stepId" } },
      transition: { level: "element", event: "markDone" },
    },
    markStepTodo: {
      args: zodSchema(z.object({ stepId: z.string() })),
      target: { section: "steps", field: "items", element: { idArg: "stepId" } },
      transition: { level: "element", event: "reopen" },
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
    addDataModel: {
      args: zodSchema(z.object({ language: z.string(), source: z.string() })),
      result: zodSchema(z.object({ blockId: z.string() })),
      target: { section: "dataModels", field: "models" },
      produces: (_page, args, ctx) => {
        const a = args as { language: string; source: string };
        const id = ctx.newId() as BlockId;
        return [
          {
            op: "addBlock",
            section: "dataModels",
            field: "models",
            block: { kind: "code", id, lang: a.language, source: a.source, hash: "" },
          },
        ];
      },
    },
    removeDataModel: {
      args: zodSchema(z.object({ blockId: z.string() })),
      target: { section: "dataModels", field: "models" },
      produces: (_page, args) => [
        {
          op: "removeBlock",
          section: "dataModels",
          field: "models",
          block: (args as { blockId: string }).blockId as BlockId,
        },
      ],
    },
    markReady: {
      args: zodSchema(empty),
      transition: { level: "page", event: "markReady" },
      preconditions: [planHasDataModel],
    },
    // Back out of the sealed `ready` state to keep editing the plan (sections are
    // `mutableIn: ["draft"]`). Re-running `markReady` re-checks `planHasDataModel`.
    // Mirrors feature-spec's `reopen`.
    reopen: { args: zodSchema(empty), transition: { level: "page", event: "reopen" } },
  },
  render: {
    title: "{title}",
    sections: [
      { section: "steps", heading: "Steps", field: "items", as: "checklist", checkedWhen: "done", item: "{text}" },
      { section: "dataModels", heading: "Data models & interfaces", field: "models", as: "blocks", placeholder: "_None yet._" },
      {
        section: "questions",
        heading: "Questions",
        field: "items",
        // Numbered so each open question is referenceable by index when answering.
        as: "numbered",
        groupBy: "status",
        groups: [
          { when: "open", heading: "Open questions", item: "**{text}**" },
          { when: "resolved", heading: "Resolved questions", item: "**{text}** — _{answer}_" },
        ],
      },
    ],
  },
});
