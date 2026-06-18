/**
 * `security-review` page type. A living security/architecture audit document: a scope, a
 * list of typed `finding` items, and an optional summary. Findings are numbered at RENDER
 * time, so resolving one (the fix is done) HIDES it from the emitted Markdown and renumbers
 * the rest — including every internal cross-reference, which is authored as an `$ordinal`
 * element-ref ("see Finding 2") that degrades to the target's title once it is hidden.
 *
 * Declarative: sections + the `finding` element + lifecycle FSM + commands + render config.
 * The two `blocks`-field commands (`setFindingDetail`, `citeFinding`) use `produces` because
 * the declarative `set:` sugar covers scalar/prose/ref but not blocks; `parseInline` reifies
 * a Markdown string into canonical inline runs so authors write normal Markdown.
 */
import type { BlockId, IBlock, ICommandContext, IItem, PageState, SectionId, SectionOp } from "wiki/authoring";
import { arg, definePageType, parseInline, t, z, zodSchema } from "wiki/authoring";

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
const severityArg = z.enum(SEVERITIES);

const empty = z.object({});

/** The `findings` section id + its list elements on a page state. */
function findingsList(page: PageState): { sectionId: SectionId; elements: readonly IItem[] } | undefined {
  const sec = page.sections.find((s) => s.key === "findings");
  const f = sec?.fields["items"];
  if (sec === undefined || f === undefined || f.kind !== "list") return undefined;
  return { sectionId: sec.id, elements: f.elements };
}

/** Build a `setElementField` op writing `detail` to a blocks value. */
function writeDetail(findingId: string, blocks: IBlock[]): SectionOp {
  return { op: "setElementField", section: "findings", field: "items", id: findingId, elementField: "detail", value: { kind: "blocks", blocks } };
}

/** Markdown string → one paragraph block per blank-line-separated chunk (inline Markdown reified). */
function paragraphs(markdown: string, ctx: ICommandContext): IBlock[] {
  return markdown
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p): IBlock => ({ kind: "paragraph", id: ctx.newId() as BlockId, inlines: parseInline(p) }));
}

export const SecurityReview = definePageType({
  type: "security-review",
  label: "Security review",
  description:
    "Captures a security assessment of existing code or a change — scope, findings (with severity), and their " +
    "disposition — from review through sign-off. Use it for an adversarial/risk pass over what exists, not to " +
    "describe the system (`architecture`) or to plan a build (`feature`).",
  version: 1,
  initialStatus: "open",
  statusTransitions: [
    // The review is a living document while open; closing it (a human sign-off) freezes it.
    t("open", "close", "closed", { agency: "human" }),
    t("closed", "reopen", "open"),
  ],
  sections: {
    scope: {
      name: "Scope",
      required: true,
      mutableIn: ["open"],
      fields: { body: { kind: "prose", required: true } },
    },
    findings: {
      name: "Findings",
      required: true,
      mutableIn: ["open"],
      fields: { items: { kind: "list", element: "finding" } },
    },
    summary: {
      name: "Summary",
      required: true,
      mutableIn: ["open"],
      fields: { body: { kind: "prose" } },
    },
  },
  elements: {
    finding: {
      fields: {
        title: { kind: "prose", required: true },
        severity: { kind: "scalar", required: true, schema: zodSchema(severityArg) },
        category: { kind: "scalar" },
        // The narrative; may carry inline `$ordinal:title` refs to sibling findings.
        detail: { kind: "blocks" },
        impact: { kind: "prose" },
        recommendation: { kind: "prose" },
        // How it was fixed / why it was accepted or dismissed — set when the finding closes.
        resolution: { kind: "prose" },
      },
      status: {
        // Every closed disposition leaves the rendered "open" group, so the finding is hidden.
        initial: "open",
        transitions: [
          t("open", "resolve", "resolved"),
          t("open", "accept", "accepted"),
          t("open", "dismiss", "false-positive"),
          t("resolved", "reopen", "open"),
          t("accepted", "reopen", "open"),
          t("false-positive", "reopen", "open"),
        ],
      },
    },
  },
  sectionSet: { mode: "closed" },
  commands: {
    setScope: {
      args: zodSchema(z.object({ text: z.string() })),
      target: { section: "scope", field: "body" },
      set: { body: arg("text") },
    },
    setSummary: {
      args: zodSchema(z.object({ text: z.string() })),
      target: { section: "summary", field: "body" },
      set: { body: arg("text") },
    },
    addFinding: {
      args: zodSchema(z.object({ title: z.string(), severity: severityArg, category: z.string().optional() })),
      result: zodSchema(z.object({ findingId: z.string() })),
      target: { section: "findings", field: "items" },
      set: { title: arg("title"), severity: arg("severity"), category: arg("category") },
    },
    // Replace a finding's narrative with `markdown` (inline Markdown is reified to runs).
    setFindingDetail: {
      args: zodSchema(z.object({ findingId: z.string(), markdown: z.string() })),
      target: { section: "findings", field: "items" },
      produces: (_page, args, ctx) => {
        const a = args as { findingId: string; markdown: string };
        return [writeDetail(a.findingId, paragraphs(a.markdown, ctx))];
      },
    },
    // Append "Related: <ref>" to a finding's narrative, where the ref renders the target
    // finding's CURRENT ordinal (degrading to its title once the target is resolved/hidden).
    citeFinding: {
      args: zodSchema(z.object({ findingId: z.string(), targetFindingId: z.string() })),
      target: { section: "findings", field: "items" },
      produces: (page, args, ctx) => {
        const a = args as { findingId: string; targetFindingId: string };
        const list = findingsList(page as PageState);
        if (list === undefined) return [];
        const src = list.elements.find((e) => e.id === a.findingId);
        const existing = src?.fields["detail"];
        const current: IBlock[] = existing !== undefined && existing.kind === "blocks" ? (structuredClone(existing.blocks) as IBlock[]) : [];
        const para: IBlock = {
          kind: "paragraph",
          id: ctx.newId() as BlockId,
          inlines: [
            { kind: "text", value: "Related: ", marks: [] },
            { kind: "ref", target: { kind: "element", section: list.sectionId, field: "items", element: a.targetFindingId, labelField: "$ordinal:title" } },
          ],
        };
        return [writeDetail(a.findingId, [...current, para])];
      },
    },
    setImpact: {
      args: zodSchema(z.object({ findingId: z.string(), text: z.string() })),
      target: { section: "findings", field: "items", element: { idArg: "findingId" } },
      set: { impact: arg("text") },
    },
    setRecommendation: {
      args: zodSchema(z.object({ findingId: z.string(), text: z.string() })),
      target: { section: "findings", field: "items", element: { idArg: "findingId" } },
      set: { recommendation: arg("text") },
    },
    setSeverity: {
      args: zodSchema(z.object({ findingId: z.string(), severity: severityArg })),
      target: { section: "findings", field: "items", element: { idArg: "findingId" } },
      set: { severity: arg("severity") },
    },
    resolveFinding: {
      args: zodSchema(z.object({ findingId: z.string(), resolution: z.string() })),
      target: { section: "findings", field: "items", element: { idArg: "findingId" } },
      set: { resolution: arg("resolution") },
      transition: { level: "element", event: "resolve" },
    },
    acceptRisk: {
      args: zodSchema(z.object({ findingId: z.string(), rationale: z.string() })),
      target: { section: "findings", field: "items", element: { idArg: "findingId" } },
      set: { resolution: arg("rationale") },
      transition: { level: "element", event: "accept" },
    },
    dismissFinding: {
      args: zodSchema(z.object({ findingId: z.string(), rationale: z.string() })),
      target: { section: "findings", field: "items", element: { idArg: "findingId" } },
      set: { resolution: arg("rationale") },
      transition: { level: "element", event: "dismiss" },
    },
    reopenFinding: {
      args: zodSchema(z.object({ findingId: z.string() })),
      target: { section: "findings", field: "items", element: { idArg: "findingId" } },
      transition: { level: "element", event: "reopen" },
    },
    removeFinding: {
      args: zodSchema(z.object({ findingId: z.string() })),
      target: { section: "findings", field: "items" },
      produces: (_page, args) => [
        { op: "removeElement", section: "findings", field: "items", id: (args as { findingId: string }).findingId },
      ],
    },
    reorderFindings: {
      args: zodSchema(z.object({ orderedIds: z.array(z.string()) })),
      target: { section: "findings", field: "items" },
      produces: (_page, args) => {
        const ids = (args as { orderedIds: string[] }).orderedIds;
        return ids.map((id, index): SectionOp => ({ op: "moveElement", section: "findings", field: "items", id, toIndex: index }));
      },
    },
    close: { args: zodSchema(empty), transition: { level: "page", event: "close" } },
    reopen: { args: zodSchema(empty), transition: { level: "page", event: "reopen" } },
  },
  render: {
    title: "{title}",
    graphSections: false,
    sections: [
      { section: "scope", heading: "Scope", field: "body", as: "block" },
      {
        section: "findings",
        field: "items",
        // Only OPEN findings render — resolved/accepted/false-positive disappear and the rest
        // renumber. Each renders as a numbered H3 subsection.
        groupBy: "status",
        groups: [{ when: "open", heading: "Findings" }],
        as: "sections",
        element: {
          heading: "{title} ({severity})",
          body: [
            { field: "detail" },
            { label: "Impact", field: "impact" },
            { label: "Recommendation", field: "recommendation" },
          ],
        },
      },
      { section: "summary", heading: "Summary", field: "body", as: "block" },
    ],
  },
});
