/**
 * `implementation-checklist` page type — declarative. Tracked work items:
 * building → complete, with `task` list elements (todo ⇄ done).
 *
 * A task may be MANUAL (hand-checked build work) or a GATE-TASK bound to a structural
 * fact via `meta.computed` (feature-review Item 3). A gate-task's checkbox is COMPUTED
 * at render from the named flag below — it cannot be hand-toggled (the engine refuses to
 * drive a computed element's FSM) and so cannot lie. Gate-tasks are pure visibility; the
 * real gate stays on the brief (e.g. `allCasesPassed` on `ship`), and the brief's
 * `checklistComplete` counts only MANUAL tasks.
 */
import type { ComputedFlag, DeepReadonly, DerivedList, IItem, IRenderCtx, PageId, PageState } from "wiki/authoring";
import { arg, definePageType, t } from "wiki/authoring";
import { z, zodSchema } from "wiki/authoring";

const empty = z.object({});

/** A prose/scalar field's string value, or "". */
function text(el: DeepReadonly<IItem>, key: string): string {
  const f = el.fields[key];
  return f !== undefined && (f.kind === "prose" || f.kind === "scalar") ? String(f.value) : "";
}

/** Computed flag: are all of the sibling testing-plan's cases passed? Reads the sibling
 *  via the render ctx (parent brief → children → testing-plan → cases), deterministically. */
const allTestingPlanCasesPassed: ComputedFlag = (page, ctx: IRenderCtx) => {
  const briefId = page.parentId as unknown as PageId | null;
  if (briefId === null) return false;
  let testPlanId: PageId | undefined;
  for (const sib of ctx.childrenOf(briefId)) {
    if (ctx.typeOf(sib) === "testing-plan") {
      testPlanId = sib;
      break;
    }
  }
  if (testPlanId === undefined) return false;
  const testPlan = ctx.pageState(testPlanId);
  const f = testPlan?.sections.find((s) => s.key === "cases")?.fields["items"];
  if (f === undefined || f.kind !== "list") return false;
  return f.elements.length >= 1 && f.elements.every((c) => c.status === "passed");
};

/** Done-step ids recorded locally on this checklist (a `doneStep` element id IS the stepId). */
function doneStepIds(page: DeepReadonly<PageState>): Set<string> {
  const f = page.sections.find((s) => s.key === "stepProgress")?.fields["done"];
  return new Set(f !== undefined && f.kind === "list" ? f.elements.map((e) => e.id) : []);
}

/**
 * Derived checklist: the implementation-plan's steps (the canonical breakdown) projected
 * onto this checklist, each checked iff its step id is recorded done locally. The plan
 * stays the single source of the step list — no hand-duplication; adding/removing/editing
 * a plan step flows through automatically (feature-review Item 2).
 */
const planSteps: DerivedList = (page, ctx: IRenderCtx) => {
  const briefId = page.parentId as unknown as PageId | null;
  if (briefId === null) return [];
  let planId: PageId | undefined;
  for (const sib of ctx.childrenOf(briefId)) {
    if (ctx.typeOf(sib) === "implementation-plan") {
      planId = sib;
      break;
    }
  }
  const plan = planId !== undefined ? ctx.pageState(planId) : undefined;
  const stepsF = plan?.sections.find((s) => s.key === "steps")?.fields["items"];
  const steps = stepsF !== undefined && stepsF.kind === "list" ? stepsF.elements : [];
  const done = doneStepIds(page);
  return steps.map((s) => ({ id: s.id, text: text(s, "text"), checked: done.has(s.id) }));
};

export const ImplementationChecklist = definePageType({
  type: "implementation-checklist",
  version: 1,
  initialStatus: "building",
  statusTransitions: [t("building", "markComplete", "complete")],
  finalize: "markComplete",
  sections: {
    tasks: {
      name: "Tasks",
      required: true,
      mutableIn: ["building"],
      fields: { items: { kind: "list", element: "task" } },
    },
    // Local per-step progress for the DERIVED "Plan steps" view (Item 2). The step text
    // lives on the plan (canonical); this section stores only which step ids are done —
    // a `doneStep` element's id IS the plan step id it marks complete.
    stepProgress: {
      name: "Step progress",
      required: true,
      mutableIn: ["building"],
      fields: { done: { kind: "list", element: "doneStep" } },
    },
  },
  elements: {
    task: {
      fields: { text: { kind: "prose", required: true } },
      status: { initial: "todo", transitions: [t("todo", "check", "done"), t("done", "uncheck", "todo")] },
    },
    doneStep: { fields: { stepId: { kind: "scalar", required: true } } },
  },
  sectionSet: { mode: "closed" },
  computed: { "all-cases-passed": allTestingPlanCasesPassed },
  derived: { "plan-steps": planSteps },
  commands: {
    addTask: {
      args: zodSchema(z.object({ text: z.string() })),
      result: zodSchema(z.object({ taskId: z.string() })),
      target: { section: "tasks", field: "items" },
      set: { text: arg("text") },
    },
    /**
     * Add a GATE-TASK whose checkbox is COMPUTED from a named flag (not hand-toggled).
     * Bound via the element's `meta.computed`; the engine renders the box from the flag
     * and rejects any attempt to check/uncheck it (Item 3).
     */
    addGateTask: {
      args: zodSchema(z.object({ text: z.string(), computed: z.enum(["all-cases-passed"]) })),
      result: zodSchema(z.object({ taskId: z.string() })),
      target: { section: "tasks", field: "items" },
      produces: (_page, args, ctx) => {
        const a = args as { text: string; computed: string };
        return [
          {
            op: "addElement",
            section: "tasks",
            field: "items",
            id: ctx.newId(),
            fields: { text: { kind: "prose", value: a.text } },
            meta: { computed: a.computed },
          },
        ];
      },
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
    // Record/clear progress on a DERIVED plan step (idempotent; the doneStep id == stepId).
    markStepDone: {
      args: zodSchema(z.object({ stepId: z.string() })),
      target: { section: "stepProgress", field: "done" },
      produces: (page, args) => {
        const stepId = (args as { stepId: string }).stepId;
        if (doneStepIds(page).has(stepId)) return [];
        return [
          { op: "addElement", section: "stepProgress", field: "done", id: stepId, fields: { stepId: { kind: "scalar", value: stepId } } },
        ];
      },
    },
    markStepTodo: {
      args: zodSchema(z.object({ stepId: z.string() })),
      target: { section: "stepProgress", field: "done" },
      produces: (page, args) => {
        const stepId = (args as { stepId: string }).stepId;
        if (!doneStepIds(page).has(stepId)) return [];
        return [{ op: "removeElement", section: "stepProgress", field: "done", id: stepId }];
      },
    },
    markComplete: { args: zodSchema(empty), transition: { level: "page", event: "markComplete" } },
  },
  render: {
    title: "{title}",
    graphSections: false,
    sections: [
      // Derived from the plan's steps (the canonical breakdown) + local progress — Item 2.
      { derived: "plan-steps", heading: "Plan steps", placeholder: "_No plan steps yet._" },
      { section: "tasks", heading: "Tasks", field: "items", as: "checklist", checkedWhen: "done", item: "{text}" },
    ],
  },
});
