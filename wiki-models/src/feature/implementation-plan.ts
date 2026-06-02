/**
 * `implementation-plan` page type (BUILD_NOTES §6). An ordered plan of attack:
 * draft → ready, owning `step` and `question` items. Pure throughout — ids/time
 * via `ctx.newId`/`ctx.now`, no host clock or RNG; `apply` owns all mutation.
 */
import type { DomainEvent, IRenderCtx, PageState } from "wiki/authoring";
import { definePageType, t } from "wiki/authoring";
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
import { question, step } from "./items";

const empty = z.object({}).strict();

type Fields = Record<string, never>;

function applyPlan(page: PageState<Fields>, event: DomainEvent): PageState<Fields> {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case "PlanMarkedReady":
      page.status = "ready";
      break;
    case "StepAdded":
      page.items.step.push({ id: p.id as string, text: p.text as string });
      break;
    case "StepRemoved":
      page.items.step = page.items.step.filter((s) => s.id !== (p.id as string));
      break;
    case "StepsReordered": {
      const order = (p.orderedStepIds as string[]) ?? [];
      const byId = new Map(page.items.step.map((s) => [s.id, s]));
      const reordered = order.map((id) => byId.get(id)).filter((s): s is NonNullable<typeof s> => s !== undefined);
      // Append any steps not named in the order (defensive), preserving their order.
      for (const s of page.items.step) if (!order.includes(s.id)) reordered.push(s);
      page.items.step = reordered;
      break;
    }
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
  }
  return page;
}

function renderPlan(page: PageState<Fields>, ctx: IRenderCtx): string {
  const blocks: string[] = [heading(1, page.title), statusBadge(page.status)];

  const steps = page.items.step ?? [];
  blocks.push(
    section(
      heading(2, "Steps"),
      steps.length === 0 ? placeholder() : numbered(steps.map((s) => String(s.text ?? s.id))),
    ),
  );

  const questions = page.items.question ?? [];
  const open = questions.filter((q) => q.status !== "resolved");
  const resolved = questions.filter((q) => q.status === "resolved");
  blocks.push(
    section(
      heading(2, "Open questions"),
      open.length === 0 ? placeholder() : bulletList(open.map((q) => `**${String(q.text ?? q.id)}**`)),
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

  return joinBlocks(blocks);
}

export const ImplementationPlan = definePageType<Record<string, never>>({
  type: "implementation-plan",
  initialStatus: "draft",
  initialFields: {},
  version: 1,
  items: { step, question },
  statusTransitions: [
    t("draft", "addStep", "draft"),
    t("draft", "removeStep", "draft"),
    t("draft", "reorderSteps", "draft"),
    t("draft", "askQuestion", "draft"),
    t("draft", "answerQuestion", "draft"),
    t("draft", "markReady", "ready"),
  ],
  commands: {
    addStep: {
      args: zodSchema(z.object({ text: z.string() })),
      result: zodSchema(z.object({ stepId: z.string() })),
      transition: { level: "page", event: "addStep" },
      produces: (_page, args, ctx) => {
        const id = ctx.newId();
        return {
          events: [{ type: "StepAdded", payload: { id, text: args.text } }],
          result: { stepId: id },
        };
      },
    },
    removeStep: {
      args: zodSchema(z.object({ stepId: z.string() })),
      transition: { level: "page", event: "removeStep" },
      produces: (_page, args, _ctx) => ({
        events: [{ type: "StepRemoved", payload: { id: args.stepId } }],
        result: undefined,
      }),
    },
    reorderSteps: {
      args: zodSchema(z.object({ orderedStepIds: z.array(z.string()) })),
      transition: { level: "page", event: "reorderSteps" },
      produces: (_page, args, _ctx) => ({
        events: [{ type: "StepsReordered", payload: { orderedStepIds: args.orderedStepIds } }],
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
        events: [{ type: "QuestionAnswered", payload: { id: args.questionId, answer: args.answer } }],
        result: { questionId: args.questionId },
      }),
    },
    markReady: {
      args: zodSchema(empty),
      transition: { level: "page", event: "markReady" },
      produces: (_page, _args, _ctx) => ({
        events: [{ type: "PlanMarkedReady", payload: {} }],
        result: undefined,
      }),
    },
  },
  apply: applyPlan,
  render: renderPlan,
});
