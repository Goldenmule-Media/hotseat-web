/**
 * Generic `PageState` readers shared by the model bundles. Deliberately NOT a bundle:
 * this directory has no `index.ts`, because the server's `--models-dir` discovery treats
 * every `src/<dir>/index.ts` as a loadable bundle.
 */
import type { DeepReadonly, IItem, PageState } from "wiki/authoring";

/** The elements of a list field, or `[]` when the section/field is absent or not a list. */
export function listOf(page: DeepReadonly<PageState>, sectionKey: string, fieldKey: string): readonly DeepReadonly<IItem>[] {
  const f = page.sections.find((s) => s.key === sectionKey)?.fields[fieldKey];
  return f !== undefined && f.kind === "list" ? f.elements : [];
}

/** An element's display title, falling back to its id. */
export function titleOf(el: DeepReadonly<IItem>): string {
  const f = el.fields["title"];
  return f !== undefined && f.kind === "prose" && f.value.length > 0 ? f.value : el.id;
}

/** A scalar element field as a string, `""` when absent. */
export function scalarOf(el: DeepReadonly<IItem>, field: string): string {
  const f = el.fields[field];
  return f !== undefined && f.kind === "scalar" ? String(f.value) : "";
}
