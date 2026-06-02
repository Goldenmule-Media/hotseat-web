/**
 * `testing-plan` page type (BUILD_NOTES §6). Test cases + results: draft → ready,
 * owning `case` items (planned → passed/failed, failed → passed). Pure throughout —
 * ids/time via `ctx.newId`/`ctx.now`, no host clock or RNG; `apply` owns all
 * mutation including item.status.
 */
import type { DomainEvent, IRenderCtx, PageState } from "wiki/authoring";
import { definePageType, t } from "wiki/authoring";
import { zodSchema, z } from "wiki/authoring";
import { bulletList, heading, joinBlocks, placeholder, section, statusBadge } from "wiki/authoring";
import { testCase } from "./items";

const empty = z.object({}).strict();

type Fields = Record<string, never>;

function applyTestPlan(page: PageState<Fields>, event: DomainEvent): PageState<Fields> {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case "TestPlanMarkedReady":
      page.status = "ready";
      break;
    case "CaseAdded":
      page.items.case.push({ id: p.id as string, text: p.text as string, status: "planned" });
      break;
    case "CasePassed": {
      const c = page.items.case.find((x) => x.id === (p.id as string));
      if (c !== undefined) c.status = "passed";
      break;
    }
    case "CaseFailed": {
      const c = page.items.case.find((x) => x.id === (p.id as string));
      if (c !== undefined) c.status = "failed";
      break;
    }
  }
  return page;
}

function renderTestPlan(page: PageState<Fields>, _ctx: IRenderCtx): string {
  const blocks: string[] = [heading(1, page.title), statusBadge(page.status)];
  const cases = page.items.case ?? [];
  blocks.push(
    section(
      heading(2, "Test cases"),
      cases.length === 0
        ? placeholder()
        : bulletList(cases.map((c) => `${String(c.text ?? c.id)} (${String(c.status ?? "planned")})`)),
    ),
  );
  return joinBlocks(blocks);
}

export const TestingPlan = definePageType<Record<string, never>>({
  type: "testing-plan",
  initialStatus: "draft",
  initialFields: {},
  version: 1,
  items: { case: testCase },
  statusTransitions: [
    t("draft", "addCase", "draft"),
    t("draft", "markCasePassed", "draft"),
    t("draft", "markCaseFailed", "draft"),
    t("draft", "markReady", "ready"),
  ],
  commands: {
    addCase: {
      args: zodSchema(z.object({ text: z.string() })),
      result: zodSchema(z.object({ caseId: z.string() })),
      transition: { level: "page", event: "addCase" },
      produces: (_page, args, ctx) => {
        const id = ctx.newId();
        return {
          events: [{ type: "CaseAdded", payload: { id, text: args.text } }],
          result: { caseId: id },
        };
      },
    },
    markCasePassed: {
      args: zodSchema(z.object({ caseId: z.string() })),
      transition: { level: "item", itemType: "case", idArg: "caseId", event: "markCasePassed" },
      produces: (_page, args, _ctx) => ({
        events: [{ type: "CasePassed", payload: { id: args.caseId } }],
        result: undefined,
      }),
    },
    markCaseFailed: {
      args: zodSchema(z.object({ caseId: z.string() })),
      transition: { level: "item", itemType: "case", idArg: "caseId", event: "markCaseFailed" },
      produces: (_page, args, _ctx) => ({
        events: [{ type: "CaseFailed", payload: { id: args.caseId } }],
        result: undefined,
      }),
    },
    markReady: {
      args: zodSchema(empty),
      transition: { level: "page", event: "markReady" },
      produces: (_page, _args, _ctx) => ({
        events: [{ type: "TestPlanMarkedReady", payload: {} }],
        result: undefined,
      }),
    },
  },
  apply: applyTestPlan,
  render: renderTestPlan,
});
