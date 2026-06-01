/**
 * Authoring helpers (DESIGN §10.5 / BUILD_NOTES §8).
 *
 * `definePageType` / `defineItemType` wrap a plain spec into the opaque
 * registration object the registry consumes (`{ __def }`). They perform light
 * shape validation only — the heavy lifting (FSM guard, Zod arg-validation) is
 * done at registry build / command time. `t` is re-exported so page authors
 * can build transition tables without reaching into `core/guard`.
 */
import type {
  CommandMap,
  DomainEvent,
  IItemType,
  IItemTypeDef,
  IPageType,
  IPageTypeDef,
} from "../api";
import { ValidationError } from "./errors";

export { t } from "./guard";

/** Wrap a page-type spec into its opaque registration object. */
export function definePageType<
  State = unknown,
  Status extends string = string,
  Cmds extends CommandMap = CommandMap,
  Ev extends DomainEvent = DomainEvent,
>(def: IPageTypeDef<State, Status, Cmds, Ev>): IPageType<State, Status, Cmds, Ev> {
  if (typeof def.type !== "string" || def.type.length === 0) {
    throw new ValidationError("definePageType: `type` must be a non-empty string.", [
      { path: ["type"], message: "required non-empty string" },
    ]);
  }
  return { __def: def };
}

/** Wrap an item-type spec into its opaque registration object. */
export function defineItemType<Status extends string = never>(
  def: IItemTypeDef<Status>,
): IItemType<Status> {
  if (typeof def.type !== "string" || def.type.length === 0) {
    throw new ValidationError("defineItemType: `type` must be a non-empty string.", [
      { path: ["type"], message: "required non-empty string" },
    ]);
  }
  return { __def: def };
}
