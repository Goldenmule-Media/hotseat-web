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
 * is writable in every status (no gate). A `list` field's element type is RESOLVED against
 * `def.elements` so the panel can show the item's real fields, not just the element's name. No
 * React here, so it is trivially unit-testable; the <SchemaInspector> component renders this.
 * Deterministic: section/field order is the def's own key order, no clock/RNG.
 */
import type { ElementDecl, FieldDecl, IPageTypeDef, SectionDecl } from "wiki";

export type FieldKind = FieldDecl["kind"];

/** Plain-language description of each field-kind — the data type a `kind` label stands for. */
export const FIELD_KIND_HINT: Record<FieldKind, string> = {
  scalar: "a single value (text, number, or boolean)",
  prose: "freeform Markdown text",
  code: "a fenced code block (language + source)",
  "attachment-ref": "a reference to an uploaded file",
  ref: "a cross-page reference (link to another page)",
  blocks: "a structured document of blocks (paragraphs, code, refs)",
  list: "a repeating collection of items",
  serial: "an engine-assigned sequence number",
};

/** A `list` field's element type, resolved to its own fields (and lifecycle states, if any). */
export interface SchemaElementType {
  readonly type: string;
  readonly fields: readonly SchemaFieldRow[];
  /** The element's own status states, when it declares an element-level FSM. */
  readonly states: readonly string[] | null;
}

export interface SchemaFieldRow {
  readonly key: string;
  readonly kind: FieldKind;
  /** Plain-language description of {@link kind}. */
  readonly hint: string;
  /** Must be PRESENT in the materialized field set (presence, not content). */
  readonly required: boolean;
  /** This field must be AUTHORED in the current status (`requiredIn` includes it). */
  readonly requiredInCurrent: boolean;
  /** The statuses in which the field must be authored, when any are declared. */
  readonly requiredIn: readonly string[] | null;
  /** `list` element type name. */
  readonly elementType?: string;
  /** `list` ordering. */
  readonly ordered?: boolean;
  /** `list` element type resolved to its own fields (null if unresolved/recursive). */
  readonly element?: SchemaElementType | null;
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

type Elements = Readonly<Record<string, ElementDecl>>;

/** Distinct status states an element type can occupy, in declaration order; null if no FSM. */
function statesOf(el: ElementDecl): readonly string[] | null {
  if (el.status === undefined) return null;
  const states: string[] = [el.status.initial];
  for (const tr of el.status.transitions) {
    if (!states.includes(tr.fromState)) states.push(tr.fromState);
    if (!states.includes(tr.toState)) states.push(tr.toState);
  }
  return states;
}

function fieldRow(
  key: string,
  decl: FieldDecl,
  currentStatus: string,
  elements: Elements,
  seen: ReadonlySet<string>,
): SchemaFieldRow {
  const requiredIn = decl.requiredIn ?? null;
  const base = {
    key,
    kind: decl.kind,
    hint: FIELD_KIND_HINT[decl.kind],
    required: decl.required === true,
    requiredInCurrent: requiredIn !== null && requiredIn.includes(currentStatus),
    requiredIn,
  };
  if (decl.kind === "list") {
    // Resolve the element type to its fields. Guard against a self-referential element type
    // (an element whose field lists its own type) so recursion always terminates.
    const el = elements[decl.element];
    const element: SchemaElementType | null =
      el === undefined || seen.has(decl.element)
        ? null
        : {
            type: decl.element,
            fields: Object.entries(el.fields).map(([k, d]) =>
              fieldRow(k, d, currentStatus, elements, new Set(seen).add(decl.element)),
            ),
            states: statesOf(el),
          };
    return { ...base, elementType: decl.element, ordered: decl.ordered === true, element };
  }
  if (decl.kind === "ref" && decl.targetKinds !== undefined) {
    return { ...base, targetKinds: decl.targetKinds };
  }
  return base;
}

function sectionRow(key: string, decl: SectionDecl, currentStatus: string, elements: Elements): SchemaSectionRow {
  const mutableIn = decl.mutableIn ?? null;
  return {
    key,
    name: decl.name,
    ...(decl.description !== undefined ? { description: decl.description } : {}),
    required: decl.required === true,
    mutableNow: mutableIn === null || mutableIn.includes(currentStatus),
    mutableIn,
    fields: Object.entries(decl.fields).map(([fk, fd]) => fieldRow(fk, fd, currentStatus, elements, new Set())),
    subsections: Object.entries(decl.sections ?? {}).map(([sk, sd]) => sectionRow(sk, sd, currentStatus, elements)),
  };
}

/** Build the schema view-model for a page type at a given current status. */
export function buildSchemaModel(def: IPageTypeDef, currentStatus: string): SchemaModel {
  const elements = def.elements ?? {};
  return {
    type: def.type,
    currentStatus,
    sections: Object.entries(def.sections).map(([key, decl]) => sectionRow(key, decl, currentStatus, elements)),
  };
}

/** The distinct field-kinds present anywhere in the model — drives the inspector's glossary. */
export function kindsInModel(model: SchemaModel): readonly FieldKind[] {
  const kinds = new Set<FieldKind>();
  const visitFields = (fields: readonly SchemaFieldRow[]): void => {
    for (const f of fields) {
      kinds.add(f.kind);
      if (f.element != null) visitFields(f.element.fields);
    }
  };
  const visitSection = (s: SchemaSectionRow): void => {
    visitFields(s.fields);
    s.subsections.forEach(visitSection);
  };
  model.sections.forEach(visitSection);
  // Stable order: the canonical kind order from the hint map.
  return (Object.keys(FIELD_KIND_HINT) as FieldKind[]).filter((k) => kinds.has(k));
}
