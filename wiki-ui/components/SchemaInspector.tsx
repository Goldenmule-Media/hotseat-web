"use client";

/**
 * The content-schema panel of the model-inspection view (feature: wiki-ui model inspection —
 * schema panel). Renders a page TYPE's schema as a type-signature: each section (and each `list`
 * element type) is a `{ }` block of `name: type` fields, a `list` field reads as the generic
 * `list<element>`, and a section is badged mutable / locked for the open page INSTANCE's current
 * status. The data-type behind each `type` token is explained on HOVER (its title), not inline.
 * Read-only: it authors nothing — the FSM graph beside it owns the interactive surface. The
 * classification is the pure {@link buildSchemaModel}; this component only lays it out.
 */
import { useMemo } from "react";
import type { IPageTypeDef } from "wiki";
import { buildSchemaModel, type SchemaFieldRow, type SchemaSectionRow } from "../lib/schema-inspector";

/** The field's data-type rendered as a token (`prose`, `list<component>`, `ref<page>`), with its
 *  plain-language meaning on hover. */
function TypeToken({ field }: { field: SchemaFieldRow }): React.JSX.Element {
  let text: string;
  if (field.kind === "list") text = `list<${field.elementType ?? "?"}>`;
  else if (field.kind === "ref" && field.targetKinds !== undefined && field.targetKinds.length > 0)
    text = `ref<${field.targetKinds.join(", ")}>`;
  else text = field.kind;
  return (
    <span className="schema-type" title={field.hint}>
      {text}
    </span>
  );
}

/** A trailing authored-ness marker (`*`), explained on hover; amber when it applies right now. */
function RequiredMark({ field }: { field: SchemaFieldRow }): React.JSX.Element | null {
  if (field.requiredInCurrent) return <span className="schema-req now" title="Must be authored in the current status">*</span>;
  if (field.required) return <span className="schema-req" title="Required — present at create">*</span>;
  if (field.requiredIn !== null && field.requiredIn.length > 0)
    return <span className="schema-req" title={`Must be authored in: ${field.requiredIn.join(", ")}`}>*</span>;
  return null;
}

function FieldLine({ field }: { field: SchemaFieldRow }): React.JSX.Element {
  const line = (
    <div className="schema-line">
      <span className="schema-key">{field.key}</span>
      <span className="schema-punct">: </span>
      <TypeToken field={field} />
      <RequiredMark field={field} />
      {field.kind === "list" && field.element != null && (
        <>
          <span className="schema-brace"> {"{"}</span>
          {field.element.states != null && (
            <span className="schema-states muted"> // {field.element.states.join(" → ")}</span>
          )}
        </>
      )}
    </div>
  );
  // A resolved list element expands to its own `{ }` block of fields, indented under the line.
  if (field.kind === "list" && field.element != null) {
    return (
      <>
        {line}
        <div className="schema-block-body">
          {field.element.fields.map((f) => (
            <FieldLine key={f.key} field={f} />
          ))}
        </div>
        <div className="schema-brace">{"}"}</div>
      </>
    );
  }
  return line;
}

function SectionBlock({ section }: { section: SchemaSectionRow }): React.JSX.Element {
  const gate =
    section.mutableIn === null
      ? "Writable in every status"
      : section.mutableIn.length === 0
        ? "Never writable"
        : `Writable in: ${section.mutableIn.join(", ")}`;
  const title = section.description !== undefined ? `${section.name} — ${section.description}` : section.name;
  return (
    <div className={`schema-block ${section.mutableNow ? "is-mutable" : "is-locked"}`}>
      <div className="schema-block-head">
        <span className="schema-name" title={title}>
          {section.key}
        </span>
        <span className="schema-brace"> {"{"}</span>
        <span className={`schema-mutability ${section.mutableNow ? "mutable" : "locked"}`} title={gate}>
          {section.mutableNow ? "mutable now" : "🔒 locked"}
        </span>
      </div>
      <div className="schema-block-body">
        {section.fields.map((f) => (
          <FieldLine key={f.key} field={f} />
        ))}
        {section.subsections.map((s) => (
          <SectionBlock key={s.key} section={s} />
        ))}
      </div>
      <div className="schema-brace">{"}"}</div>
    </div>
  );
}

export function SchemaInspector({
  def,
  currentStatus,
}: {
  def: IPageTypeDef;
  currentStatus: string;
}): React.JSX.Element {
  const model = useMemo(() => buildSchemaModel(def, currentStatus), [def, currentStatus]);
  return (
    <section className="schema-inspector" aria-label="Page schema">
      <p className="schema-head">
        Schema of <code>{model.type}</code> — sections writable in <strong>{currentStatus}</strong> are marked{" "}
        <span className="schema-mutability mutable">mutable now</span>. Hover a type for what it holds.
      </p>
      <div className="schema-tree">
        {model.sections.map((s) => (
          <SectionBlock key={s.key} section={s} />
        ))}
      </div>
    </section>
  );
}
