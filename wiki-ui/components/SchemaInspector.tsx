"use client";

/**
 * The content-schema panel of the model-inspection view (feature: wiki-ui model inspection —
 * schema panel). Renders a page TYPE's sections and fields from its declarative definition, with
 * each section badged mutable / locked for the open page INSTANCE's current status. Read-only: it
 * authors nothing and issues no commands — the FSM graph beside it owns the interactive surface.
 * The classification is the pure {@link buildSchemaModel}; this component only lays it out.
 */
import { useMemo } from "react";
import type { IPageTypeDef } from "wiki";
import { buildSchemaModel, type SchemaFieldRow, type SchemaSectionRow } from "../lib/schema-inspector";

function FieldRow({ field }: { field: SchemaFieldRow }): React.JSX.Element {
  const meta: string[] = [];
  if (field.elementType !== undefined) meta.push(`of ${field.elementType}${field.ordered === true ? ", ordered" : ""}`);
  if (field.targetKinds !== undefined && field.targetKinds.length > 0) meta.push(`→ ${field.targetKinds.join(", ")}`);
  if (field.requiredIn !== null && field.requiredIn.length > 0) meta.push(`required in ${field.requiredIn.join(", ")}`);
  return (
    <li className="schema-field">
      <code className="schema-field-key">{field.key}</code>
      <span className="schema-kind-chip">{field.kind}</span>
      {field.required && <span className="schema-required" title="Must be present">required</span>}
      {field.requiredInCurrent && (
        <span className="schema-required-now" title="Must be authored in the current status">
          author now
        </span>
      )}
      {meta.length > 0 && <span className="schema-field-meta muted">{meta.join(" · ")}</span>}
    </li>
  );
}

function SectionRow({ section }: { section: SchemaSectionRow }): React.JSX.Element {
  const gate =
    section.mutableIn === null
      ? "Writable in every status"
      : section.mutableIn.length === 0
        ? "Never writable"
        : `Writable in: ${section.mutableIn.join(", ")}`;
  return (
    <li className={`schema-section ${section.mutableNow ? "is-mutable" : "is-locked"}`}>
      <div className="schema-section-head">
        <span className="schema-section-name">{section.name}</span>
        <code className="schema-section-key">{section.key}</code>
        {section.required && <span className="schema-required" title="Materialized at create">required</span>}
        <span
          className={`schema-mutability ${section.mutableNow ? "mutable" : "locked"}`}
          title={gate}
        >
          {section.mutableNow ? "mutable now" : "🔒 locked"}
        </span>
      </div>
      {section.description !== undefined && <p className="schema-section-desc muted">{section.description}</p>}
      {section.fields.length > 0 && (
        <ul className="schema-fields">
          {section.fields.map((f) => (
            <FieldRow key={f.key} field={f} />
          ))}
        </ul>
      )}
      {section.subsections.length > 0 && (
        <ul className="schema-subsections">
          {section.subsections.map((s) => (
            <SectionRow key={s.key} section={s} />
          ))}
        </ul>
      )}
    </li>
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
        <span className="schema-mutability mutable">mutable now</span>.
      </p>
      <ul className="schema-sections">
        {model.sections.map((s) => (
          <SectionRow key={s.key} section={s} />
        ))}
      </ul>
    </section>
  );
}
