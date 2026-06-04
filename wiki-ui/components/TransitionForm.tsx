"use client";

/**
 * The transition runner (feature: wiki-ui interactive FSM transitions). Rendered in the
 * model view's inspector column when an edge is clicked. Given the clicked edge's
 * {@link TransitionTarget}, it renders a form generated from the command's `argsSchema`
 * (pure {@link schemaToFields}) and, on submit, coerces the inputs and runs the mutation
 * through {@link usePageMutator}. Behaviour by class:
 *
 *   - available + no fields → a confirm-and-run step (today's empty-args transitions, Q6);
 *   - available + fields    → typed inputs, coerced then submitted;
 *   - blocked               → fields read-only, run disabled, the unmet reason shown (Q1).
 *
 * The engine is the sole validator (Q4): client-side we only coerce shape and surface the
 * engine's `ValidationError` verbatim. On a successful commit the modal closes; the live
 * tail repaints the graph at the new state.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PageId, WorkspaceId } from "wiki";
import type { TransitionTarget } from "../lib/fsm-graph";
import { usePageMutator } from "../lib/live";
import { coerceValues, schemaToFields, type FormField } from "../lib/schema-form";

type RawValue = string | boolean;

function FieldRow({
  field,
  value,
  disabled,
  error,
  onChange,
}: {
  field: FormField;
  value: RawValue | undefined;
  disabled: boolean;
  error?: string;
  onChange: (v: RawValue) => void;
}): React.JSX.Element {
  const id = `tf-${field.key}`;
  const str = typeof value === "string" ? value : "";
  let control: ReactNode;
  switch (field.kind) {
    case "boolean":
      control = (
        <input id={id} type="checkbox" disabled={disabled} checked={value === true} onChange={(e) => onChange(e.target.checked)} />
      );
      break;
    case "enum":
      control = (
        <select id={id} disabled={disabled} value={str} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {field.enumValues?.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      );
      break;
    case "number":
    case "integer":
      control = (
        <input
          id={id}
          type="number"
          step={field.kind === "integer" ? 1 : "any"}
          disabled={disabled}
          value={str}
          onChange={(e) => onChange(e.target.value)}
        />
      );
      break;
    case "array":
    case "json":
      control = (
        <textarea
          id={id}
          rows={3}
          disabled={disabled}
          placeholder={field.kind === "array" ? '["a", "b"]' : "{ }"}
          value={str}
          onChange={(e) => onChange(e.target.value)}
        />
      );
      break;
    default:
      control = <input id={id} type="text" disabled={disabled} value={str} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <div className={`tf-field tf-field-${field.kind}`}>
      <label htmlFor={id}>
        {field.label}
        {field.required && <span className="tf-req"> *</span>}
      </label>
      {control}
      {field.description !== undefined && <p className="muted tf-desc">{field.description}</p>}
      {error !== undefined && <p className="error tf-error">{error}</p>}
    </div>
  );
}

export function TransitionForm({
  workspaceId,
  pageId,
  target,
  onClose,
}: {
  workspaceId: WorkspaceId;
  pageId: PageId;
  target: TransitionTarget;
  onClose: () => void;
}): React.JSX.Element {
  const { descriptor, from, to, available, unmet } = target;
  const fields = useMemo(() => schemaToFields(descriptor.argsSchema), [descriptor.argsSchema]);
  const { run, pending, error } = usePageMutator(workspaceId, pageId);
  const [raw, setRaw] = useState<Record<string, RawValue>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const formRef = useRef<HTMLFormElement>(null);

  // Focus the first input when the panel populates (the parent re-keys this form per
  // transition, so this runs once per selection); fall back to the run button when the
  // transition has no arguments.
  useEffect(() => {
    const f = formRef.current;
    const first = f?.querySelector<HTMLElement>("input, textarea, select") ?? f?.querySelector<HTMLElement>('button[type="submit"]');
    first?.focus();
  }, []);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!available) return;
    const { args, errors } = coerceValues(fields, raw);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    if (await run(descriptor.name, args)) onClose();
  }

  const runLabel = pending ? "Running…" : fields.length === 0 ? `Run ${descriptor.name}` : "Run transition";

  return (
    <form ref={formRef} className="transition-form" onSubmit={onSubmit}>
      <header className="tf-header">
        <h2 id="transition-form-title" className="tf-title">
          <code>{descriptor.name}</code>
        </h2>
        <p className="tf-arrow muted">
          <strong>{from}</strong> → <strong>{to}</strong>
        </p>
      </header>

      {descriptor.description !== undefined && <p className="muted tf-cmd-desc">{descriptor.description}</p>}

      {!available && unmet !== undefined && <div className="notice tf-blocked">🔒 Blocked: {unmet}</div>}

      {fields.length === 0 ? (
        <p className="muted tf-confirm">
          {available
            ? `This transition takes no arguments — run it to move from ${from} to ${to}.`
            : "This transition takes no arguments."}
        </p>
      ) : (
        <div className="tf-fields">
          {fields.map((f) => (
            <FieldRow
              key={f.key}
              field={f}
              value={raw[f.key]}
              disabled={!available || pending}
              error={fieldErrors[f.key]}
              onChange={(v) => setRaw((r) => ({ ...r, [f.key]: v }))}
            />
          ))}
        </div>
      )}

      {error !== null && <div className="notice error tf-run-error">{error}</div>}

      <footer className="tf-actions">
        <button type="button" className="tf-btn tf-btn-secondary" onClick={onClose} disabled={pending}>
          Cancel
        </button>
        <button type="submit" className="tf-btn tf-btn-primary" disabled={!available || pending}>
          {runLabel}
        </button>
      </footer>
    </form>
  );
}
