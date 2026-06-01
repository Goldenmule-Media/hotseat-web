/**
 * Zod adapter (BUILD_NOTES §8, DESIGN §8). Wraps a `z.ZodType` as an {@link ISchema}:
 * `parse()` validates and throws {@link ValidationError} on failure (issues mapped from
 * Zod's `error.issues`); `toJsonSchema()` exports a JSON Schema for LLM/tooling surfaces.
 * Re-exports `z` so page authors can build their command/field schemas from one import.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { ISchema, JsonSchema } from "../api";
import { ValidationError, type SchemaIssue } from "../core/errors";

/** Wrap a Zod schema as an {@link ISchema}. */
export function zodSchema<T>(schema: z.ZodType<T>): ISchema<T> {
  return {
    parse(input: unknown): T {
      const r = schema.safeParse(input);
      if (!r.success) {
        const issues: SchemaIssue[] = r.error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        }));
        const message =
          issues.length === 0
            ? "Validation failed."
            : issues
                .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
                .join("; ");
        throw new ValidationError(message, issues);
      }
      return r.data;
    },
    toJsonSchema(): JsonSchema {
      return zodToJsonSchema(schema) as JsonSchema;
    },
  };
}

export { z };
