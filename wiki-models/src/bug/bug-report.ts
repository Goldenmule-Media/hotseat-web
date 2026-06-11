/**
 * `bug-report` page type — a defect as a first-class, FSM-governed wiki page.
 *
 * Shape:
 *  - report — component / platform / version (required scalars; the triage basics).
 *  - summary — what is broken, one prose paragraph (required).
 *  - repro — an ORDERED list of `step` elements (the numbered repro recipe).
 *  - expected / observed — the contract vs. reality, as prose.
 *  - resolution — a list of `commit` elements (sha + message, optional url): the fixes.
 *
 * Lifecycle: `draft` →(open)→ `open` →(close)→ `closed` →(reopen)→ `open`.
 *
 * "Required on creation" is the draft→open gate, DECLARED, not hand-rolled: `createPage`
 * takes no field args, so the page is born in `draft`, and the basics (component /
 * platform / version / summary) carry `requiredIn: ["open", "closed"]` — the ENGINE
 * refuses the forward `open` edge (agency: "agent" — the completeness edge the agent
 * drives itself) while any is unauthored, names the missing `section.field` paths in the
 * unmet reason (so the self-directing loop authors them immediately after create), and
 * also rejects any later write that would blank one while the report is open.
 *
 * CLOSING REFERENCES A COMMIT BY CONSTRUCTION: `close` is ONE declarative command that
 * both records the fix commit (an `addElement` into `resolution`) and fires the page
 * transition — a single atomic op list, so a bug can never be closed without naming the
 * commit that fixed it. `reopen` backs out to `open` (where `resolution` is writable
 * again); a re-close appends a SECOND commit — the list keeps the full fix history.
 * Content sections freeze in `closed` (mutableIn draft/open), so a closed report is a
 * stable record until explicitly reopened.
 */
import type { DeepReadonly, DerivedItem, DerivedList, IField, PageState } from "wiki/authoring";
import { arg, definePageType, t } from "wiki/authoring";
import { z, zodSchema } from "wiki/authoring";

const empty = z.object({});

// The statuses in which the report's content is authorable (closed = frozen).
const editable = ["draft", "open"];

// The statuses in which the report basics must be AUTHORED (the engine's `requiredIn`
// authored-ness gate): entering `open` requires them, and they cannot be blanked while
// the bug is open. `closed` is declarative honesty — content is frozen there anyway.
const requiredOnceOpen = ["open", "closed"];

// ────────────────────────────────────────────────────────────────────────────
// Pure read helpers over folded state (used by the report-rows renderer)
// ────────────────────────────────────────────────────────────────────────────

/** A section's field map (or {} when the section is absent). */
function fieldsOf(page: DeepReadonly<PageState>, sectionKey: string): DeepReadonly<Record<string, IField>> {
  return page.sections.find((s) => s.key === sectionKey)?.fields ?? {};
}

/** A scalar field's string value, or "" (required sections materialize scalars to ""). */
function scalarOf(fields: DeepReadonly<Record<string, IField>>, key: string): string {
  const f = fields[key];
  return f !== undefined && f.kind === "scalar" ? String(f.value) : "";
}

// ────────────────────────────────────────────────────────────────────────────
// Render projection — the report basics as a compact metadata block
// ────────────────────────────────────────────────────────────────────────────

/** One bullet per present report field, empties omitted. Deterministic. */
const reportRows: DerivedList = (page) => {
  const report = fieldsOf(page, "report");
  const rows: DerivedItem[] = [];
  const component = scalarOf(report, "component");
  const platform = scalarOf(report, "platform");
  const version = scalarOf(report, "version");
  if (component.length > 0) rows.push({ id: "component", text: `**Component:** ${component}` });
  if (platform.length > 0) rows.push({ id: "platform", text: `**Platform:** ${platform}` });
  if (version.length > 0) rows.push({ id: "version", text: `**Version:** ${version}` });
  return rows;
};

export const BugReport = definePageType({
  type: "bug-report",
  label: "Bug report",
  version: 1,
  initialStatus: "draft",
  statusTransitions: [
    // The forward completeness edge the agent drives itself (gated by reportComplete).
    t("draft", "open", "open", { agency: "agent" }),
    // close/reopen carry no agency: closing claims a real fix landed — never auto-driven.
    t("open", "close", "closed"),
    t("closed", "reopen", "open"),
  ],
  sections: {
    report: {
      name: "Report",
      required: true,
      mutableIn: editable,
      fields: {
        component: { kind: "scalar", required: true, requiredIn: requiredOnceOpen },
        platform: { kind: "scalar", required: true, requiredIn: requiredOnceOpen },
        version: { kind: "scalar", required: true, requiredIn: requiredOnceOpen },
      },
    },
    summary: {
      name: "Summary",
      required: true,
      mutableIn: editable,
      fields: { body: { kind: "prose", required: true, requiredIn: requiredOnceOpen } },
    },
    repro: {
      name: "Repro steps",
      required: true,
      mutableIn: editable,
      fields: { steps: { kind: "list", element: "step", ordered: true } },
    },
    expected: {
      name: "Expected result",
      required: true,
      mutableIn: editable,
      fields: { body: { kind: "prose", required: true } },
    },
    observed: {
      name: "Observed result",
      required: true,
      mutableIn: editable,
      fields: { body: { kind: "prose", required: true } },
    },
    // Writable ONLY while open — `close` lands its commit here in the same atomic op
    // list as the transition; a reopen→re-close appends another (full fix history).
    resolution: {
      name: "Resolution",
      required: true,
      mutableIn: ["open"],
      fields: { fixCommits: { kind: "list", element: "commit", ordered: true } },
    },
  },
  elements: {
    step: { fields: { text: { kind: "prose", required: true } } },
    commit: {
      fields: {
        sha: { kind: "scalar", required: true },
        message: { kind: "scalar", required: true },
        url: { kind: "scalar" },
      },
    },
  },
  sectionSet: { mode: "closed" },
  derived: {
    "report-rows": reportRows,
  },
  commands: {
    // ── report basics (the create-gate content) ──
    setComponent: {
      args: zodSchema(z.object({ component: z.string() })),
      target: { section: "report", field: "component" },
      set: { component: arg("component") },
    },
    setPlatform: {
      args: zodSchema(z.object({ platform: z.string() })),
      target: { section: "report", field: "platform" },
      set: { platform: arg("platform") },
    },
    setVersion: {
      args: zodSchema(z.object({ version: z.string() })),
      target: { section: "report", field: "version" },
      set: { version: arg("version") },
    },
    setSummary: {
      args: zodSchema(z.object({ text: z.string() })),
      target: { section: "summary", field: "body" },
      set: { body: arg("text") },
    },
    // ── repro steps (ordered) ──
    addReproStep: {
      args: zodSchema(z.object({ text: z.string() })),
      result: zodSchema(z.object({ stepId: z.string() })),
      target: { section: "repro", field: "steps" },
      set: { text: arg("text") },
    },
    removeReproStep: {
      args: zodSchema(z.object({ stepId: z.string() })),
      target: { section: "repro", field: "steps" },
      produces: (_page, args) => [
        { op: "removeElement", section: "repro", field: "steps", id: (args as { stepId: string }).stepId },
      ],
    },
    // ── expected / observed ──
    setExpected: {
      args: zodSchema(z.object({ text: z.string() })),
      target: { section: "expected", field: "body" },
      set: { body: arg("text") },
    },
    setObserved: {
      args: zodSchema(z.object({ text: z.string() })),
      target: { section: "observed", field: "body" },
      set: { body: arg("text") },
    },
    // ── lifecycle ──
    // No preconditions: the engine's `requiredIn` gate refuses `open` until the report
    // basics are authored, naming the missing `section.field` paths.
    open: {
      args: zodSchema(empty),
      transition: { level: "page", event: "open" },
    },
    // ONE command, one atomic op list: record the fix commit AND transition to closed —
    // the args schema makes the sha/message mandatory, so a commit-less close is
    // unrepresentable (no separate set-then-transition batch to forget).
    close: {
      args: zodSchema(z.object({ sha: z.string(), message: z.string(), url: z.string().optional() })),
      result: zodSchema(z.object({ commitId: z.string() })),
      target: { section: "resolution", field: "fixCommits" },
      set: { sha: arg("sha"), message: arg("message"), url: arg("url") },
      transition: { level: "page", event: "close" },
    },
    reopen: { args: zodSchema(empty), transition: { level: "page", event: "reopen" } },
  },
  render: {
    title: "Bug: {title}",
    sections: [
      { derived: "report-rows", heading: "Report", placeholder: "_No report metadata._" },
      { section: "summary", heading: "Summary", field: "body", as: "block", placeholder: "_None._" },
      { section: "repro", heading: "Repro steps", field: "steps", as: "numbered", item: "{text}" },
      { section: "expected", heading: "Expected result", field: "body", as: "block", placeholder: "_None._" },
      { section: "observed", heading: "Observed result", field: "body", as: "block", placeholder: "_None._" },
      { section: "resolution", heading: "Resolution", field: "fixCommits", as: "bullets", item: "`{sha}` {message}" },
    ],
  },
});
