/**
 * Pure view-model transform for the content-schema inspector (feature: wiki-ui model
 * inspection — schema panel). Maps a page TYPE's declarative definition ({@link IPageTypeDef})
 * plus the open page INSTANCE's current status into a render-agnostic model of its sections and
 * fields, with each section flagged mutable-or-locked in that status:
 *
 *   mutableNow = section.mutableIn === undefined || section.mutableIn.includes(currentStatus)
 *
 * — the exact rule the engine's write-gate uses (wiki/src/core/wiki.ts), so the panel never
 * disagrees with what a mutation would actually allow. An undefined `mutableIn` means the section
 * is writable in every status (no gate). No React here, so it is trivially unit-testable; the
 * <SchemaInspector> component renders this. Deterministic: section/field order is the def's own
 * key order, no clock/RNG.
 */
import type { FieldDecl, IPageTypeDef, SectionDecl } from "wiki";

export type FieldKind = FieldDecl["kind"];

export interface SchemaFieldRow {
  readonly key: string;
  readonly kind: FieldKind;
  /** Must be PRESENT in the materialized field set (presence, not content). */
  readonly required: boolean;
  /** This field must be AUTHORED in the current status (`requiredIn` includes it). */
  readonly requiredInCurrent: boolean;
  /** The statuses in which the field must be authored, when any are declared. */
  readonly requiredIn: readonly string[] | null;
  /** `list` element type. */
  readonly elementType?: string;
  /** `list` ordering. */
  readonly ordered?: boolean;
  /** `ref` permitted target kinds. */
  readonly targetKinds?: readonly string[];
}

export interface SchemaSectionRow {
  readonly key: string;
  readonly name: string;
  readonly description?: string;
  /** Materialized empty at create. */
  readonly required: boolean;
  /** Writable in the current status (see file header). */
  readonly mutableNow: boolean;
  /** The statuses in which writes are allowed, or `null` when unconstrained (always mutable). */
  readonly mutableIn: readonly string[] | null;
  readonly fields: readonly SchemaFieldRow[];
  readonly subsections: readonly SchemaSectionRow[];
}

export interface SchemaModel {
  readonly type: string;
  readonly currentStatus: string;
  readonly sections: readonly SchemaSectionRow[];
}

function fieldRow(key: string, decl: FieldDecl, currentStatus: string): SchemaFieldRow {
  const requiredIn = decl.requiredIn ?? null;
  return {
    key,
    kind: decl.kind,
    required: decl.required === true,
    requiredInCurrent: requiredIn !== null && requiredIn.includes(currentStatus),
    requiredIn,
    ...(decl.kind === "list" ? { elementType: decl.element, ordered: decl.ordered === true } : {}),
    ...(decl.kind === "ref" && decl.targetKinds !== undefined ? { targetKinds: decl.targetKinds } : {}),
  };
}

function sectionRow(key: string, decl: SectionDecl, currentStatus: string): SchemaSectionRow {
  const mutableIn = decl.mutableIn ?? null;
  return {
    key,
    name: decl.name,
    ...(decl.description !== undefined ? { description: decl.description } : {}),
    required: decl.required === true,
    mutableNow: mutableIn === null || mutableIn.includes(currentStatus),
    mutableIn,
    fields: Object.entries(decl.fields).map(([fk, fd]) => fieldRow(fk, fd, currentStatus)),
    subsections: Object.entries(decl.sections ?? {}).map(([sk, sd]) => sectionRow(sk, sd, currentStatus)),
  };
}

/** Build the schema view-model for a page type at a given current status. */
export function buildSchemaModel(def: IPageTypeDef, currentStatus: string): SchemaModel {
  return {
    type: def.type,
    currentStatus,
    sections: Object.entries(def.sections).map(([key, decl]) => sectionRow(key, decl, currentStatus)),
  };
}
