/**
 * Pure schema→form transform (feature: wiki-ui interactive FSM transitions). A clicked
 * transition edge resolves to one command descriptor whose `argsSchema` is the JSON
 * Schema `describeMutations` returns (the shape `zod-to-json-schema` emits:
 * `{ type:"object", properties, required? }`). {@link schemaToFields} maps that to an
 * ordered list of typed field specs the form renders; {@link coerceValues} maps the
 * form's raw string/boolean inputs back to typed command args.
 *
 * No React here, so the field-derivation and coercion rules are unit-tested in isolation
 * (the same pure/component split as {@link buildFsmGraph} / <FsmGraph>). The engine stays
 * the sole validator: coercion is light (shape only); real rejection is the engine's
 * `ValidationError` at commit.
 */
import type { JsonSchema } from "wiki";
import { titleCase } from "wiki";

export type FieldKind = "text" | "number" | "integer" | "boolean" | "enum" | "array" | "json";

export interface FormField {
  /** The argument key (the JSON-Schema property name). */
  readonly key: string;
  /** Friendly label — `titleCase(key)`. */
  readonly label: string;
  readonly kind: FieldKind;
  /** Whether `key` is in the schema's `required` set. */
  readonly required: boolean;
  readonly description?: string;
  /** When `kind === "enum"`, the allowed values. */
  readonly enumValues?: readonly string[];
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * Resolve a top-level `$ref` (zod-to-json-schema occasionally roots the object in
 * `definitions`/`$defs`) into the referenced node. Returns the schema unchanged when
 * there is no resolvable ref — the common inline case.
 */
function resolveRoot(schema: JsonSchema): Record<string, unknown> {
  const ref = typeof schema["$ref"] === "string" ? (schema["$ref"] as string) : undefined;
  if (ref === undefined) return schema;
  const m = /^#\/(definitions|\$defs)\/(.+)$/.exec(ref);
  if (m === null) return schema;
  const bag = asRecord(schema[m[1]]);
  const target = bag !== undefined ? asRecord(bag[m[2]]) : undefined;
  return target ?? schema;
}

/** Map a JSON-Schema `type` (possibly `["string","null"]`) to a field kind. */
function kindOfType(type: unknown): FieldKind {
  const t = Array.isArray(type) ? type.find((x) => x !== "null") : type;
  switch (t) {
    case "string":
      return "text";
    case "integer":
      return "integer";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return "array";
    default:
      // object / unknown / missing → a raw-JSON escape hatch, so the form never fails to
      // render an arg shape it doesn't specifically handle (constraint #1).
      return "json";
  }
}

function toField(key: string, prop: Record<string, unknown>, required: boolean): FormField {
  const description = typeof prop["description"] === "string" ? (prop["description"] as string) : undefined;
  const enumVals = Array.isArray(prop["enum"]) ? (prop["enum"] as unknown[]).map((v) => String(v)) : undefined;
  const base = {
    key,
    label: titleCase(key),
    required,
    ...(description !== undefined ? { description } : {}),
  };
  if (enumVals !== undefined && enumVals.length > 0) {
    return { ...base, kind: "enum", enumValues: enumVals };
  }
  return { ...base, kind: kindOfType(prop["type"]) };
}

/**
 * The ordered fields for a command's args schema. An empty (or property-less) object
 * schema → `[]`, which the form renders as a confirm-and-run step. Property order
 * follows the schema's declaration order.
 */
export function schemaToFields(argsSchema: JsonSchema): readonly FormField[] {
  const root = resolveRoot(argsSchema);
  const props = asRecord(root["properties"]);
  if (props === undefined) return [];
  const required = new Set(
    Array.isArray(root["required"]) ? (root["required"] as unknown[]).filter((x): x is string => typeof x === "string") : [],
  );
  return Object.entries(props).map(([key, raw]) => toField(key, asRecord(raw) ?? {}, required.has(key)));
}

export interface CoerceResult {
  /** The typed command args — present, coerced values only (empty optionals dropped). */
  readonly args: Record<string, unknown>;
  /** Per-field messages: a missing required field or an unparseable number/array/JSON. */
  readonly errors: Record<string, string>;
}

/**
 * Coerce the form's raw inputs (strings, plus booleans from checkboxes) into typed args:
 * number/integer → Number, array/json → JSON.parse, everything else → string. Empty
 * optionals are dropped; a missing required field or a parse failure becomes a per-field
 * error rather than a throw. This is shape coercion only — the engine validates for real.
 */
export function coerceValues(fields: readonly FormField[], raw: Record<string, string | boolean>): CoerceResult {
  const args: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  const required = (key: string): boolean => fields.find((f) => f.key === key)?.required === true;

  for (const f of fields) {
    const v = raw[f.key];
    switch (f.kind) {
      case "boolean": {
        args[f.key] = v === true;
        break;
      }
      case "number":
      case "integer": {
        const s = typeof v === "string" ? v.trim() : "";
        if (s === "") {
          if (required(f.key)) errors[f.key] = "This field is required.";
          break;
        }
        const n = Number(s);
        if (Number.isNaN(n)) {
          errors[f.key] = "Must be a number.";
          break;
        }
        if (f.kind === "integer" && !Number.isInteger(n)) {
          errors[f.key] = "Must be a whole number.";
          break;
        }
        args[f.key] = n;
        break;
      }
      case "array":
      case "json": {
        const s = typeof v === "string" ? v.trim() : "";
        if (s === "") {
          if (required(f.key)) errors[f.key] = "This field is required.";
          break;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(s);
        } catch {
          errors[f.key] = f.kind === "array" ? 'Enter a JSON array, e.g. ["a", "b"].' : "Enter valid JSON.";
          break;
        }
        if (f.kind === "array" && !Array.isArray(parsed)) {
          errors[f.key] = "Must be a JSON array.";
          break;
        }
        args[f.key] = parsed;
        break;
      }
      default: {
        // text, enum
        const s = typeof v === "string" ? v : "";
        if (s.trim() === "") {
          if (required(f.key)) errors[f.key] = "This field is required.";
          break;
        }
        args[f.key] = s;
      }
    }
  }
  return { args, errors };
}
