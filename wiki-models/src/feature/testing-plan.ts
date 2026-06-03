/**
 * `testing-plan` page type — declarative. Test cases + results: draft → ready,
 * with `case` list elements (planned → passed/failed, failed → passed).
 */
import { arg, definePageType, t } from "wiki/authoring";
import { z, zodSchema } from "wiki/authoring";

const empty = z.object({});

export const TestingPlan = definePageType({
  type: "testing-plan",
  version: 1,
  initialStatus: "draft",
  statusTransitions: [t("draft", "markReady", "ready")],
  sections: {
    cases: {
      name: "Test cases",
      required: true,
      mutableIn: ["draft"],
      fields: { items: { kind: "list", element: "case" } },
    },
  },
  elements: {
    case: {
      fields: { text: { kind: "prose", required: true } },
      status: {
        initial: "planned",
        transitions: [
          t("planned", "pass", "passed"),
          t("planned", "fail", "failed"),
          t("failed", "pass", "passed"),
        ],
      },
    },
  },
  sectionSet: { mode: "closed" },
  commands: {
    addCase: {
      args: zodSchema(z.object({ text: z.string() })),
      result: zodSchema(z.object({ caseId: z.string() })),
      target: { section: "cases", field: "items" },
      set: { text: arg("text") },
    },
    markCasePassed: {
      args: zodSchema(z.object({ caseId: z.string() })),
      target: { section: "cases", field: "items", element: { idArg: "caseId" } },
      transition: { level: "element", event: "pass" },
    },
    markCaseFailed: {
      args: zodSchema(z.object({ caseId: z.string() })),
      target: { section: "cases", field: "items", element: { idArg: "caseId" } },
      transition: { level: "element", event: "fail" },
    },
    markReady: { args: zodSchema(empty), transition: { level: "page", event: "markReady" } },
  },
  render: {
    title: "{title}",
    sections: [
      {
        section: "cases",
        heading: "Test cases",
        field: "items",
        groupBy: "status",
        groups: [
          { when: "planned", heading: "Planned", item: "{text}" },
          { when: "passed", heading: "Passed", item: "{text}" },
          { when: "failed", heading: "Failed", item: "{text}" },
        ],
      },
    ],
  },
});
