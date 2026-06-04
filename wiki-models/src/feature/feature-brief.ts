/**
 * `feature-brief` page type (structured-content §13). Declarative: sections +
 * elements + lifecycle FSM + declarative commands + render config. No author
 * apply/render/produces. The two cross-page gates (beginImplementation, ship)
 * are pure `Precondition`s reading siblings via `related`.
 */
import type { DeepReadonly, IItem, IRelatedReader, PageId, PageState, Precondition } from "wiki/authoring";
import { arg, definePageType, t } from "wiki/authoring";
import { z, zodSchema } from "wiki/authoring";

// ────────────────────────────────────────────────────────────────────────────
// Cross-page gate helpers (read sibling/child state via `related`)
// ────────────────────────────────────────────────────────────────────────────

function childOfType(related: IRelatedReader, self: PageId, type: string): DeepReadonly<PageState> | undefined {
  for (const childId of related.childrenOf(self)) {
    const child = related.page(childId);
    if (child !== undefined && child.type === type) return child;
  }
  return undefined;
}

function listElements(
  page: DeepReadonly<PageState> | undefined,
  sectionKey: string,
  fieldKey: string,
): readonly DeepReadonly<IItem>[] {
  if (page === undefined) return [];
  const sec = page.sections.find((s) => s.key === sectionKey);
  const f = sec?.fields[fieldKey];
  if (f !== undefined && f.kind === "list") return f.elements;
  return [];
}

const planHasStep: Precondition = (page, related) => {
  const plan = childOfType(related, related.self, "implementation-plan");
  return listElements(plan, "steps", "items").length >= 1 ? true : { unmet: "needs ≥1 implementation-plan step" };
};

const testPlanHasCase: Precondition = (page, related) => {
  const testPlan = childOfType(related, related.self, "testing-plan");
  return listElements(testPlan, "cases", "items").length >= 1 ? true : { unmet: "needs ≥1 testing-plan case" };
};

const planHasDataModel: Precondition = (page, related) => {
  const plan = childOfType(related, related.self, "implementation-plan");
  const f = plan?.sections.find((s) => s.key === "dataModels")?.fields["models"];
  const n = f !== undefined && f.kind === "blocks" ? f.blocks.filter((b) => b.kind === "code").length : 0;
  return n >= 1 ? true : { unmet: "needs ≥1 implementation-plan data-model/interface code block" };
};

const checklistComplete: Precondition = (page, related) => {
  const checklist = childOfType(related, related.self, "implementation-checklist");
  const tasks = listElements(checklist, "tasks", "items");
  if (tasks.length < 1) return { unmet: "needs ≥1 implementation-checklist task" };
  if (tasks.some((tk) => tk.status !== "done")) return { unmet: "all implementation-checklist tasks must be done" };
  return true;
};

const allCasesPassed: Precondition = (page, related) => {
  const testPlan = childOfType(related, related.self, "testing-plan");
  const cases = listElements(testPlan, "cases", "items");
  if (cases.length < 1) return { unmet: "needs ≥1 testing-plan case" };
  if (cases.some((c) => c.status !== "passed")) return { unmet: "all testing-plan cases must be passed" };
  return true;
};

const noOpenQuestions: Precondition = (page) => {
  const open = listElements(page, "questions", "items").filter((q) => q.status !== "resolved");
  return open.length === 0 ? true : { unmet: "zero open questions on the brief" };
};

const empty = z.object({});

export const FeatureBrief = definePageType({
  type: "feature-brief",
  version: 1,
  initialStatus: "draft",
  statusTransitions: [
    t("draft", "beginPlanning", "planning"),
    t("planning", "beginImplementation", "building"),
    t("building", "reopenPlanning", "planning"),
    t("building", "submitForReview", "review"),
    t("review", "requestChanges", "building"),
    t("review", "ship", "shipped"),
    t("draft", "abandon", "abandoned"),
    t("planning", "abandon", "abandoned"),
    t("building", "abandon", "abandoned"),
    t("review", "abandon", "abandoned"),
  ],
  sections: {
    summary: {
      name: "Summary",
      required: true,
      mutableIn: ["draft", "planning"],
      fields: { body: { kind: "prose", required: true } },
    },
    components: {
      name: "Components affected",
      required: true,
      mutableIn: ["draft", "planning", "building"],
      fields: { items: { kind: "list", element: "component" } },
    },
    constraints: {
      name: "Design constraints",
      required: true,
      mutableIn: ["draft", "planning", "building"],
      fields: { items: { kind: "list", element: "constraint", ordered: true } },
    },
    questions: {
      name: "Questions",
      required: true,
      mutableIn: ["draft", "planning", "building", "review"],
      fields: { items: { kind: "list", element: "question" } },
    },
    commits: {
      name: "Commits",
      required: true,
      mutableIn: ["building", "review"],
      fields: { items: { kind: "list", element: "commit" } },
    },
  },
  elements: {
    component: { fields: { name: { kind: "scalar", required: true } } },
    constraint: { fields: { text: { kind: "prose", required: true } } },
    question: {
      fields: { text: { kind: "prose", required: true }, answer: { kind: "prose" } },
      status: { initial: "open", transitions: [t("open", "answer", "resolved")] },
    },
    commit: {
      fields: {
        sha: { kind: "scalar", required: true },
        message: { kind: "scalar", required: true },
        url: { kind: "scalar" },
      },
    },
  },
  sectionSet: { mode: "closed" },
  requiredChildren: ["implementation-plan", "implementation-checklist", "testing-plan", "feature-spec"],
  commands: {
    setSummary: {
      args: zodSchema(z.object({ text: z.string() })),
      target: { section: "summary", field: "body" },
      set: { body: arg("text") },
    },
    addComponent: {
      args: zodSchema(z.object({ name: z.string() })),
      result: zodSchema(z.object({ componentId: z.string() })),
      target: { section: "components", field: "items" },
      set: { name: arg("name") },
    },
    removeComponent: {
      args: zodSchema(z.object({ componentId: z.string() })),
      target: { section: "components", field: "items" },
      produces: (_page, args) => [
        { op: "removeElement", section: "components", field: "items", id: (args as { componentId: string }).componentId },
      ],
    },
    addConstraint: {
      args: zodSchema(z.object({ text: z.string() })),
      result: zodSchema(z.object({ constraintId: z.string() })),
      target: { section: "constraints", field: "items" },
      set: { text: arg("text") },
    },
    removeConstraint: {
      args: zodSchema(z.object({ constraintId: z.string() })),
      target: { section: "constraints", field: "items" },
      produces: (_page, args) => [
        { op: "removeElement", section: "constraints", field: "items", id: (args as { constraintId: string }).constraintId },
      ],
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
    recordCommit: {
      args: zodSchema(z.object({ sha: z.string(), message: z.string(), url: z.string().optional() })),
      result: zodSchema(z.object({ commitId: z.string() })),
      target: { section: "commits", field: "items" },
      set: { sha: arg("sha"), message: arg("message"), url: arg("url") },
    },
    beginPlanning: { args: zodSchema(empty), transition: { level: "page", event: "beginPlanning" } },
    beginImplementation: {
      args: zodSchema(empty),
      transition: { level: "page", event: "beginImplementation" },
      preconditions: [planHasStep, planHasDataModel, testPlanHasCase],
    },
    submitForReview: { args: zodSchema(empty), transition: { level: "page", event: "submitForReview" } },
    reopenPlanning: { args: zodSchema(empty), transition: { level: "page", event: "reopenPlanning" } },
    requestChanges: { args: zodSchema(empty), transition: { level: "page", event: "requestChanges" } },
    ship: {
      args: zodSchema(empty),
      transition: { level: "page", event: "ship" },
      preconditions: [checklistComplete, allCasesPassed, noOpenQuestions],
    },
    abandon: { args: zodSchema(empty), transition: { level: "page", event: "abandon" } },
  },
  render: {
    title: "Feature: {title}",
    graphSections: false,
    sections: [
      { section: "summary", heading: "Summary", field: "body", as: "block", placeholder: "_None._" },
      { section: "components", heading: "Components affected", field: "items", as: "bullets", item: "{name}" },
      { section: "constraints", heading: "Design constraints", field: "items", as: "numbered", item: "{text}" },
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
      { section: "@references", heading: "References" },
      { section: "@children", heading: "Child pages" },
      { section: "commits", heading: "Commits", field: "items", as: "bullets", item: "`{sha}` {message}" },
    ],
  },
});
