/**
 * The page-type picker's options (feature: create pages from the sidebar), derived from the
 * statically-imported bundles in {@link ./models}. Pure and React-free so the ordering and the
 * auto-created classification are unit-tested in isolation — the same pure/component split as
 * {@link schemaToFields} / <TransitionForm>.
 *
 * Creation itself takes NO per-type arguments: the engine's structural handler reads only
 * type/title/parentId, and the registry lints against a type gating a field on its own initial
 * status (pages are born empty). So a type contributes only its identity, its prose, and what
 * else it drags into the commit — there is no create-arg schema to render.
 */
import type { IPageTypeDef } from "wiki";
import { titleCase } from "wiki";

export interface PageTypeOption {
  /** The page-type tag passed to `createPage` (e.g. "feature-brief"). */
  readonly type: string;
  /** `label`, else a deterministic title-cased tag — the same fallback the engine uses. */
  readonly label: string;
  /** What the type is for / when to reach for it, when the model declares it. */
  readonly description?: string;
  /** Types `createPage` auto-materializes as pinned children in the SAME commit. */
  readonly requiredChildren: readonly string[];
  /**
   * Set when this type appears in some OTHER type's `requiredChildren` — i.e. it is normally
   * spawned automatically, and creating one standalone is the unusual choice. Holds the
   * owning type's LABEL, for a "usually created with X" hint. Derived generically by scanning
   * every def, so no type name is hardcoded here.
   */
  readonly autoCreatedBy?: string;
}

function labelOf(def: IPageTypeDef): string {
  return def.label ?? titleCase(def.type);
}

/**
 * Every registered type as a picker option, primary types first (alphabetical by label) and
 * auto-created ones last — a `feature-brief` is a thing you choose, its `testing-plan` is a
 * thing that arrives with it.
 */
export function pageTypeOptions(defs: readonly IPageTypeDef[]): readonly PageTypeOption[] {
  const owner = new Map<string, string>();
  for (const def of defs) {
    for (const child of def.requiredChildren ?? []) {
      if (!owner.has(child)) owner.set(child, labelOf(def));
    }
  }

  const options = defs.map((def): PageTypeOption => {
    const description = def.description;
    const auto = owner.get(def.type);
    return {
      type: def.type,
      label: labelOf(def),
      ...(description !== undefined ? { description } : {}),
      requiredChildren: def.requiredChildren ?? [],
      ...(auto !== undefined ? { autoCreatedBy: auto } : {}),
    };
  });

  return [...options].sort((a, b) => {
    const autoA = a.autoCreatedBy !== undefined ? 1 : 0;
    const autoB = b.autoCreatedBy !== undefined ? 1 : 0;
    return autoA - autoB || a.label.localeCompare(b.label);
  });
}
