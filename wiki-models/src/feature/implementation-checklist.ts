/**
 * `implementation-checklist` page type — declarative. Tracked work items:
 * building ⇄ complete (reopen backs out of the sealed state), with `task`
 * list elements (todo ⇄ done).
 *
 * A task may be MANUAL (hand-checked build work) or a GATE-TASK bound to a structural
 * fact via `meta.computed` (feature-review Item 3). A gate-task's checkbox is COMPUTED
 * at render from the named flag below — it cannot be hand-toggled (the engine refuses to
 * drive a computed element's FSM) and so cannot lie. Gate-tasks are pure visibility; the
 * real gate stays on the brief (e.g. `allCasesPassed` on `ship`), and the brief's
 * `checklistComplete` counts only MANUAL tasks.
 */
import type { ComputedFlag, DeepReadonly, DerivedList, IItem, IRenderCtx, PageId } from "wiki/authoring";
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

/**
 * Derived checklist: the implementation-plan's steps (the canonical breakdown) projected
 * onto this checklist, each checked iff THAT STEP'S OWN status is `done`. Done-state lives
 * on the plan step (beside its text), recorded via the plan's `markStepDone` — an element-FSM
 * transition that, like the testing-plan's `markCasePassed`, stays legal after the plan is
 * sealed. The checklist stores ZERO step state, so it cannot drift from the plan and
 * `markComplete` cannot freeze progress (feature-review Item 2). Editing the plan's steps
 * flows through automatically — this is a pure view.
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
  return steps.map((s) => ({ id: s.id, text: text(s, "text"), checked: s.status === "done" }));
};

export const ImplementationChecklist = definePageType({
  type: "implementation-checklist",
  version: 1,
  initialStatus: "building",
  statusTransitions: [t("building", "markComplete", "complete"), t("complete", "reopen", "building")],
  finalize: "markComplete",
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
    markComplete: { args: zodSchema(empty), transition: { level: "page", event: "markComplete" } },
    // Back out of the sealed `complete` state to keep editing tasks (`tasks` is
    // `mutableIn: ["building"]`). Mirrors feature-spec's `reopen`.
    reopen: { args: zodSchema(empty), transition: { level: "page", event: "reopen" } },
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
