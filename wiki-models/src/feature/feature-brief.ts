/**
 * `feature-brief` page type (BUILD_NOTES §6, DESIGN §13). The brief drives a
 * feature from draft → planning → building → review → shipped (+ abandoned),
 * mandates three child pages (created atomically), owns four item types
 * (`component`, `constraint`, `question`, `commit`), and enforces two cross-page
 * gates atomically via `ctx.related`:
 *   - beginImplementation: plan ≥1 step AND testing-plan ≥1 case.
 *   - ship: checklist 100% done (≥1 task), all cases passed (≥1 case), zero open questions.
 *
 * Everything here is pure: ids/time arrive via `ctx.newId`/`ctx.now`; no host
 * clock or RNG. `apply` owns ALL mutation (page.status + items + fields). `render`
 * matches DESIGN §13.5 byte-for-byte.
 */
import type {
  DomainEvent,
  IItemRecord,
  IRelatedReader,
  IRenderCtx,
  PageId,
  PageState,
} from "wiki/authoring";
import { definePageType, t } from "wiki/authoring";
import { InvariantViolationError } from "wiki/authoring";
import { zodSchema, z } from "wiki/authoring";
import {
  bulletList,
  heading,
  joinBlocks,
  numbered,
  placeholder,
  section,
  statusBadge,
} from "wiki/authoring";
import { commit, component, constraint, question } from "./items";

// ────────────────────────────────────────────────────────────────────────────
// Fields (scalars only — items live in `page.items`)
// ────────────────────────────────────────────────────────────────────────────

export interface FeatureBriefFields {
  summary?: string;
}

const empty = z.object({}).strict();

// ────────────────────────────────────────────────────────────────────────────
// Cross-page gate helpers (read sibling/child state via ctx.related)
// ────────────────────────────────────────────────────────────────────────────

/** First child of `self` whose page type is `type`, or undefined. */
function childOfType(
  related: IRelatedReader,
  self: PageId,
  type: string,
): ReturnType<IRelatedReader["page"]> | undefined {
  for (const childId of related.childrenOf(self)) {
    const child = related.page(childId);
    if (child !== undefined && child.type === type) return child;
  }
  return undefined;
}

function itemsOf(
  page: ReturnType<IRelatedReader["page"]> | undefined,
  itemType: string,
): readonly IItemRecord[] {
  if (page === undefined) return [];
  const byType = page.items as unknown as Record<string, readonly IItemRecord[]>;
  return byType[itemType] ?? [];
}

// ────────────────────────────────────────────────────────────────────────────
// Render (DESIGN §13.5)
// ────────────────────────────────────────────────────────────────────────────

function renderBrief(page: PageState<FeatureBriefFields>, ctx: IRenderCtx): string {
  const blocks: string[] = [
    heading(1, `Feature: ${page.title}`),
    statusBadge(page.status),
  ];

  // Summary
  const summary = page.fields.summary;
  blocks.push(
    section(
      heading(2, "Summary"),
      typeof summary === "string" && summary.length > 0 ? summary : placeholder(),
    ),
  );

  // Components affected
  const components = page.items.component ?? [];
  blocks.push(
    section(
      heading(2, "Components affected"),
      components.length === 0
        ? placeholder()
        : bulletList(components.map((c) => String(c.name ?? c.id))),
    ),
  );

  // Design constraints (numbered)
  const constraints = page.items.constraint ?? [];
  blocks.push(
    section(
      heading(2, "Design constraints"),
      constraints.length === 0
        ? placeholder()
        : numbered(constraints.map((c) => String(c.text ?? c.id))),
    ),
  );

  // Questions: Open / Resolved split
  const questions = page.items.question ?? [];
  const open = questions.filter((q) => q.status !== "resolved");
  const resolved = questions.filter((q) => q.status === "resolved");
  blocks.push(
    section(
      heading(2, "Open questions"),
      open.length === 0
        ? placeholder()
        : bulletList(open.map((q) => `**${String(q.text ?? q.id)}**`)),
    ),
  );
  blocks.push(
    section(
      heading(2, "Resolved questions"),
      resolved.length === 0
        ? placeholder()
        : bulletList(
            resolved.map((q) => {
              const answer = typeof q.answer === "string" ? q.answer : "";
              return `**${String(q.text ?? q.id)}** → ${answer}`;
            }),
          ),
    ),
  );

  // References (graph links)
  const links = ctx.linksOf(page.id);
  blocks.push(
    section(
      heading(2, "References"),
      links.length === 0
        ? placeholder()
        : bulletList(links.map((l) => `${l.role} → ${ctx.titleOf(l.to) ?? l.to}`)),
    ),
  );

  // Child pages (tree order)
  const children = ctx.childrenOf(page.id);
  blocks.push(
    section(
      heading(2, "Child pages"),
      children.length === 0
        ? placeholder()
        : bulletList(children.map((id) => ctx.titleOf(id) ?? id)),
    ),
  );

  // Commits
  const commits = page.items.commit ?? [];
  blocks.push(
    section(
      heading(2, "Commits"),
      commits.length === 0
        ? placeholder()
        : bulletList(commits.map((c) => `\`${String(c.sha ?? "")}\` ${String(c.message ?? "")}`)),
    ),
  );

  return joinBlocks(blocks);
}

// ────────────────────────────────────────────────────────────────────────────
// Apply (owns page.status + items + fields)
// ────────────────────────────────────────────────────────────────────────────

function applyBrief(
  page: PageState<FeatureBriefFields>,
  event: DomainEvent,
): PageState<FeatureBriefFields> {
  const p = event.payload as Record<string, unknown>;
  switch (event.type) {
    // ── status transitions ──
    case "PlanningBegan":
      page.status = "planning";
      break;
    case "ImplementationBegan":
      page.status = "building";
      break;
    case "PlanningReopened":
      page.status = "planning";
      break;
    case "SubmittedForReview":
      page.status = "review";
      break;
    case "ChangesRequested":
      page.status = "building";
      break;
    case "Shipped":
      page.status = "shipped";
      break;
    case "Abandoned":
      page.status = "abandoned";
      break;

    // ── content: fields ──
    case "SummarySet":
      page.fields.summary = p.text as string;
      break;

    // ── content: components ──
    case "ComponentAdded":
      page.items.component.push({ id: p.id as string, name: p.name as string });
      break;
    case "ComponentRemoved":
      page.items.component = page.items.component.filter((c) => c.id !== (p.id as string));
      break;

    // ── content: constraints ──
    case "ConstraintAdded":
      page.items.constraint.push({ id: p.id as string, text: p.text as string });
      break;
    case "ConstraintRemoved":
      page.items.constraint = page.items.constraint.filter((c) => c.id !== (p.id as string));
      break;

    // ── content: questions ──
    case "QuestionAsked":
      page.items.question.push({ id: p.id as string, text: p.text as string, status: "open" });
      break;
    case "QuestionAnswered": {
      const q = page.items.question.find((x) => x.id === (p.id as string));
      if (q !== undefined) {
        q.status = "resolved";
        q.answer = p.answer as string;
      }
      break;
    }

    // ── content: commits ──
    case "CommitRecorded":
      page.items.commit.push({
        id: p.id as string,
        sha: p.sha as string,
        message: p.message as string,
        ...(p.url !== undefined ? { url: p.url as string } : {}),
      });
      break;
  }
  return page;
}

// ────────────────────────────────────────────────────────────────────────────
// Page type
// ────────────────────────────────────────────────────────────────────────────

export const FeatureBrief = definePageType<FeatureBriefFields>({
  type: "feature-brief",
  initialStatus: "draft",
  initialFields: {},
  version: 1,
  requiredChildren: ["implementation-plan", "implementation-checklist", "testing-plan"],
  items: { component, constraint, question, commit },
  statusTransitions: [
    // draft self-transitions
    t("draft", "setSummary", "draft"),
    t("draft", "addComponent", "draft"),
    t("draft", "removeComponent", "draft"),
    t("draft", "addConstraint", "draft"),
    t("draft", "removeConstraint", "draft"),
    t("draft", "askQuestion", "draft"),
    t("draft", "answerQuestion", "draft"),
    t("draft", "beginPlanning", "planning"),
    t("draft", "abandon", "abandoned"),
    // planning self-transitions
    t("planning", "addConstraint", "planning"),
    t("planning", "removeConstraint", "planning"),
    t("planning", "askQuestion", "planning"),
    t("planning", "answerQuestion", "planning"),
    t("planning", "beginImplementation", "building"),
    t("planning", "abandon", "abandoned"),
    // building self-transitions
    t("building", "addConstraint", "building"),
    t("building", "askQuestion", "building"),
    t("building", "answerQuestion", "building"),
    t("building", "recordCommit", "building"),
    t("building", "reopenPlanning", "planning"),
    t("building", "submitForReview", "review"),
    t("building", "abandon", "abandoned"),
    // review self-transitions
    t("review", "recordCommit", "review"),
    t("review", "requestChanges", "building"),
    t("review", "ship", "shipped"),
    t("review", "abandon", "abandoned"),
  ],
  commands: {
    setSummary: {
      args: zodSchema(z.object({ text: z.string() })),
      transition: { level: "page", event: "setSummary" },
      produces: (_page, args, _ctx) => ({
        events: [{ type: "SummarySet", payload: { text: args.text } }],
        result: undefined,
      }),
    },

    addComponent: {
      args: zodSchema(z.object({ name: z.string() })),
      result: zodSchema(z.object({ componentId: z.string() })),
      transition: { level: "page", event: "addComponent" },
      produces: (_page, args, ctx) => {
        const id = ctx.newId();
        return {
          events: [{ type: "ComponentAdded", payload: { id, name: args.name } }],
          result: { componentId: id },
        };
      },
    },

    removeComponent: {
      args: zodSchema(z.object({ componentId: z.string() })),
      transition: { level: "page", event: "removeComponent" },
      produces: (_page, args, _ctx) => ({
        events: [{ type: "ComponentRemoved", payload: { id: args.componentId } }],
        result: undefined,
      }),
    },

    addConstraint: {
      args: zodSchema(z.object({ text: z.string() })),
      result: zodSchema(z.object({ constraintId: z.string() })),
      transition: { level: "page", event: "addConstraint" },
      produces: (_page, args, ctx) => {
        const id = ctx.newId();
        return {
          events: [{ type: "ConstraintAdded", payload: { id, text: args.text } }],
          result: { constraintId: id },
        };
      },
    },

    removeConstraint: {
      args: zodSchema(z.object({ constraintId: z.string() })),
      transition: { level: "page", event: "removeConstraint" },
      produces: (_page, args, _ctx) => ({
        events: [{ type: "ConstraintRemoved", payload: { id: args.constraintId } }],
        result: undefined,
      }),
    },

    askQuestion: {
      args: zodSchema(z.object({ text: z.string() })),
      result: zodSchema(z.object({ questionId: z.string() })),
      transition: { level: "page", event: "askQuestion" },
      produces: (_page, args, ctx) => {
        const id = ctx.newId();
        return {
          events: [{ type: "QuestionAsked", payload: { id, text: args.text } }],
          result: { questionId: id },
        };
      },
    },

    answerQuestion: {
      args: zodSchema(z.object({ questionId: z.string(), answer: z.string() })),
      result: zodSchema(z.object({ questionId: z.string() })),
      transition: {
        level: "item",
        itemType: "question",
        idArg: "questionId",
        event: "answerQuestion",
      },
      produces: (_page, args, _ctx) => ({
        events: [
          { type: "QuestionAnswered", payload: { id: args.questionId, answer: args.answer } },
        ],
        result: { questionId: args.questionId },
      }),
    },

    recordCommit: {
      args: zodSchema(
        z.object({ sha: z.string(), message: z.string(), url: z.string().optional() }),
      ),
      result: zodSchema(z.object({ commitId: z.string() })),
      transition: { level: "page", event: "recordCommit" },
      produces: (_page, args, ctx) => {
        const id = ctx.newId();
        return {
          events: [
            {
              type: "CommitRecorded",
              payload: {
                id,
                sha: args.sha,
                message: args.message,
                ...(args.url !== undefined ? { url: args.url } : {}),
              },
            },
          ],
          result: { commitId: id },
        };
      },
    },

    beginPlanning: {
      args: zodSchema(empty),
      transition: { level: "page", event: "beginPlanning" },
      produces: (_page, _args, _ctx) => ({
        events: [{ type: "PlanningBegan", payload: {} }],
        result: undefined,
      }),
    },

    beginImplementation: {
      args: zodSchema(empty),
      transition: { level: "page", event: "beginImplementation" },
      produces: (_page, _args, ctx) => {
        const { related } = ctx;
        const plan = childOfType(related, related.self, "implementation-plan");
        const testPlan = childOfType(related, related.self, "testing-plan");
        const steps = itemsOf(plan, "step");
        const cases = itemsOf(testPlan, "case");
        const missing: string[] = [];
        if (steps.length < 1) missing.push("≥1 implementation-plan step");
        if (cases.length < 1) missing.push("≥1 testing-plan case");
        if (missing.length > 0) {
          throw new InvariantViolationError(
            `Cannot begin implementation: needs ${missing.join(" and ")}.`,
          );
        }
        return {
          events: [{ type: "ImplementationBegan", payload: {} }],
          result: undefined,
        };
      },
    },

    reopenPlanning: {
      args: zodSchema(empty),
      transition: { level: "page", event: "reopenPlanning" },
      produces: (_page, _args, _ctx) => ({
        events: [{ type: "PlanningReopened", payload: {} }],
        result: undefined,
      }),
    },

    submitForReview: {
      args: zodSchema(empty),
      transition: { level: "page", event: "submitForReview" },
      produces: (_page, _args, _ctx) => ({
        events: [{ type: "SubmittedForReview", payload: {} }],
        result: undefined,
      }),
    },

    requestChanges: {
      args: zodSchema(empty),
      transition: { level: "page", event: "requestChanges" },
      produces: (_page, _args, _ctx) => ({
        events: [{ type: "ChangesRequested", payload: {} }],
        result: undefined,
      }),
    },

    ship: {
      args: zodSchema(empty),
      transition: { level: "page", event: "ship" },
      produces: (page, _args, ctx) => {
        const { related } = ctx;
        const checklist = childOfType(related, related.self, "implementation-checklist");
        const testPlan = childOfType(related, related.self, "testing-plan");
        const tasks = itemsOf(checklist, "task");
        const cases = itemsOf(testPlan, "case");
        const openQuestions = (page.items.question ?? []).filter((q) => q.status !== "resolved");

        const missing: string[] = [];
        if (tasks.length < 1) {
          missing.push("≥1 implementation-checklist task");
        } else if (tasks.some((task) => task.status !== "done")) {
          missing.push("all implementation-checklist tasks done");
        }
        if (cases.length < 1) {
          missing.push("≥1 testing-plan case");
        } else if (cases.some((c) => c.status !== "passed")) {
          missing.push("all testing-plan cases passed");
        }
        if (openQuestions.length > 0) {
          missing.push("zero open questions on the brief");
        }
        if (missing.length > 0) {
          throw new InvariantViolationError(`Cannot ship: needs ${missing.join(" and ")}.`);
        }
        return {
          events: [{ type: "Shipped", payload: {} }],
          result: undefined,
        };
      },
    },

    abandon: {
      args: zodSchema(empty),
      transition: { level: "page", event: "abandon" },
      produces: (_page, _args, _ctx) => ({
        events: [{ type: "Abandoned", payload: {} }],
        result: undefined,
      }),
    },
  },
  apply: applyBrief,
  render: renderBrief,
});
