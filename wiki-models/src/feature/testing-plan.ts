/**
 * `testing-plan` page type — declarative. Test cases + results: draft ⇄ ready
 * (reopen backs out of the sealed state), with `case` list elements
 * (planned → passed/failed, failed → passed).
 */
import { arg, definePageType, t } from "wiki/authoring";
import { z, zodSchema } from "wiki/authoring";

const empty = z.object({});

export const TestingPlan = definePageType({
  type: "testing-plan",
  description:
    "The verification cases for a feature. Auto-created as a child of a `feature-brief` — you do not create " +
    "one directly; author into the one the brief materializes.",
  version: 1,
  initialStatus: "draft",
  // markReady carries no `agency` — driven by the brief's `ship` cascade, not the agent
  // (it is ungated, so surfacing it would invite sealing an empty testing plan).
  statusTransitions: [t("draft", "markReady", "ready"), t("ready", "reopen", "draft")],
  finalize: "markReady",
  sections: {
    cases: {
      name: "Test cases",
      // The case SET is authored in `draft` and frozen once the plan is sealed. The
      // engine gates content edits per OP, so freezing the set here does NOT freeze
      // result-recording: markCasePassed/markCaseFailed are element-FSM transitions
      // (no content op), so they stay legal in `ready` and the brief's `allCasesPassed`
      // ship gate is reachable.
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
    removeCase: {
      args: zodSchema(z.object({ caseId: z.string() })),
      target: { section: "cases", field: "items" },
      produces: (_page, args) => [
        { op: "removeElement", section: "cases", field: "items", id: (args as { caseId: string }).caseId },
      ],
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
    // Back out of the sealed `ready` state to keep editing the case set (`cases` is
    // `mutableIn: ["draft"]`). Mirrors feature-spec's `reopen`.
    reopen: { args: zodSchema(empty), transition: { level: "page", event: "reopen" } },
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
