/**
 * Item type definitions for the worked-example feature pages (BUILD_NOTES §6,
 * DESIGN §13.2). Items live in `page.items[itemType]`; their FSMs gate the
 * item-level commands (e.g. a `question` can't be answered twice). The plain
 * items (`component`, `constraint`, `commit`, `step`) carry no lifecycle.
 *
 * `t()` builds the transitions; `defineItemType` wraps each spec into its
 * registration object. No host clock / RNG here — these are pure declarations.
 */
import { defineItemType, t } from "../../core/define";

/** `question`: open → resolved (answerQuestion). Cannot be answered twice. */
export const question = defineItemType({
  type: "question",
  initialStatus: "open",
  statusTransitions: [t("open", "answerQuestion", "resolved")],
});

/** `task`: todo ⇄ done (checkTask / uncheckTask). */
export const task = defineItemType({
  type: "task",
  initialStatus: "todo",
  statusTransitions: [
    t("todo", "checkTask", "done"),
    t("done", "uncheckTask", "todo"),
  ],
});

/** `case`: planned → passed/failed, and failed → passed (re-run can recover). */
export const testCase = defineItemType({
  type: "case",
  initialStatus: "planned",
  statusTransitions: [
    t("planned", "markCasePassed", "passed"),
    t("planned", "markCaseFailed", "failed"),
    t("failed", "markCasePassed", "passed"),
  ],
});

/** Plain items (no lifecycle FSM). */
export const component = defineItemType({ type: "component" });
export const constraint = defineItemType({ type: "constraint" });
export const commit = defineItemType({ type: "commit" });
export const step = defineItemType({ type: "step" });
