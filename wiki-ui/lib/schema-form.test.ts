import { describe, expect, it } from "vitest";
import type { JsonSchema } from "wiki";
import { coerceValues, schemaToFields, type FormField } from "./schema-form";

const byKey = (fields: readonly FormField[], key: string): FormField => fields.find((f) => f.key === key)!;

describe("schemaToFields", () => {
  it("returns [] for an empty (property-less) object schema → confirm-only form", () => {
    expect(schemaToFields({ type: "object", additionalProperties: false })).toEqual([]);
    expect(schemaToFields({ type: "object", properties: {}, required: [] })).toEqual([]);
  });

  it("maps a {sha, message, url?} schema to text fields with the right required flags, in order", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { sha: { type: "string" }, message: { type: "string" }, url: { type: "string" } },
      required: ["sha", "message"],
      additionalProperties: false,
    };
    const fields = schemaToFields(schema);
    expect(fields.map((f) => f.key)).toEqual(["sha", "message", "url"]);
    expect(fields.every((f) => f.kind === "text")).toBe(true);
    expect(byKey(fields, "sha").required).toBe(true);
    expect(byKey(fields, "message").required).toBe(true);
    expect(byKey(fields, "url").required).toBe(false);
    expect(byKey(fields, "sha").label.length).toBeGreaterThan(0);
  });

  it("maps number, integer, boolean, enum and array to the matching kinds", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        ratio: { type: "number" },
        toIndex: { type: "integer", minimum: 0 },
        force: { type: "boolean" },
        computed: { type: "string", enum: ["all-cases-passed"] },
        ids: { type: "array", items: { type: "string" } },
      },
      required: ["toIndex"],
    };
    const fields = schemaToFields(schema);
    expect(byKey(fields, "ratio").kind).toBe("number");
    expect(byKey(fields, "toIndex").kind).toBe("integer");
    expect(byKey(fields, "force").kind).toBe("boolean");
    expect(byKey(fields, "computed").kind).toBe("enum");
    expect(byKey(fields, "computed").enumValues).toEqual(["all-cases-passed"]);
    expect(byKey(fields, "ids").kind).toBe("array");
  });

  it("falls back to a json field for an object/unrecognized property shape", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { meta: { type: "object", properties: {} }, mystery: {} },
    };
    expect(byKey(schemaToFields(schema), "meta").kind).toBe("json");
    expect(byKey(schemaToFields(schema), "mystery").kind).toBe("json");
  });

  it("resolves a top-level $ref into definitions/$defs", () => {
    const schema: JsonSchema = {
      $ref: "#/definitions/Args",
      definitions: {
        Args: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      },
    };
    const fields = schemaToFields(schema);
    expect(fields.map((f) => f.key)).toEqual(["name"]);
    expect(byKey(fields, "name").required).toBe(true);
  });
});

describe("coerceValues", () => {
  const fields = schemaToFields({
    type: "object",
    properties: {
      sha: { type: "string" },
      message: { type: "string" },
      url: { type: "string" },
      count: { type: "integer" },
      force: { type: "boolean" },
      ids: { type: "array", items: { type: "string" } },
    },
    required: ["sha", "count"],
  });

  it("coerces typed values, drops empty optionals, and reports missing required", () => {
    const { args, errors } = coerceValues(fields, {
      sha: "abc123",
      message: "",
      count: "3",
      force: true,
      ids: '["a", "b"]',
    });
    expect(errors).toEqual({});
    expect(args).toEqual({ sha: "abc123", count: 3, force: true, ids: ["a", "b"] });
    // message (optional, empty) is dropped; url (absent) is dropped.
    expect(args).not.toHaveProperty("message");
    expect(args).not.toHaveProperty("url");
    expect(typeof args["count"]).toBe("number");
    expect(args["force"]).toBe(true);
  });

  it("flags a missing required field and a non-numeric number", () => {
    const { args, errors } = coerceValues(fields, { count: "not-a-number" });
    expect(errors["sha"]).toBeDefined(); // required, absent
    expect(errors["count"]).toBeDefined(); // NaN
    expect(args).not.toHaveProperty("count");
  });

  it("reports a malformed array/JSON value as a field error instead of throwing", () => {
    const { errors } = coerceValues(fields, { sha: "x", count: "1", ids: "a, b, c" });
    expect(errors["ids"]).toBeDefined();
  });

  it("rejects a JSON value that parses but is not an array for an array field", () => {
    const { errors } = coerceValues(fields, { sha: "x", count: "1", ids: '{"not":"array"}' });
    expect(errors["ids"]).toBeDefined();
  });
});
