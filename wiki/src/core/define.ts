/**
 * Authoring helper (structured-content §9). `definePageType` wraps a declarative
 * page-type spec into the opaque registration object the registry consumes
 * (`{ __def }`). It performs light shape validation only — the heavy lifting
 * (declaration validation, FSM guard, Zod arg-validation) is done at registry
 * build / command time. `t` is re-exported so authors can build transition tables.
 */
import type { IPageType, IPageTypeDef } from "../api";
import { ValidationError } from "./errors";

export { t } from "./guard";

/** Wrap a page-type spec into its opaque registration object. */
export function definePageType<Status extends string = string>(
  def: IPageTypeDef<Status>,
): IPageType<Status> {
  const issues: { path: (string | number)[]; message: string }[] = [];
  if (typeof def.type !== "string" || def.type.length === 0) {
    issues.push({ path: ["type"], message: "required non-empty string" });
  }
  if (def.sections === undefined || typeof def.sections !== "object") {
    issues.push({ path: ["sections"], message: "required section declarations" });
  }
  if (def.commands === undefined || typeof def.commands !== "object") {
    issues.push({ path: ["commands"], message: "required command declarations" });
  }
  if (def.render === undefined || typeof def.render !== "object") {
    issues.push({ path: ["render"], message: "required render config" });
  }
  if (issues.length > 0) {
    throw new ValidationError("definePageType: invalid page type spec.", issues);
  }
  return { __def: def };
}

/** `arg("name")` sugar — maps a command arg to a field value (§9.8). */
export function arg(name: string): { readonly __arg: string } {
  return { __arg: name };
}
