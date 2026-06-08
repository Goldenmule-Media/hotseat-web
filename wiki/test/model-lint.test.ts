/**
 * Load-time static guards in the registry (the static-analysis-over-structure
 * guardrail). A model whose write-gates or element
 * FSMs encode an unreachable/undrivable state is rejected at REGISTRATION, turning a
 * silent runtime deadlock into a load-time `ValidationError`.
 */
import { describe, expect, it } from "vitest";

import { arg, definePageType, t } from "../src/authoring";
import { z, zodSchema } from "../src/authoring";
import { Registry } from "../src/core/registry";
import { ValidationError } from "../src/core/errors";

const empty = z.object({});

/** Build a registry from one def; throws ValidationError if the def is rejected. */
function register(def: ReturnType<typeof definePageType>): void {
  new Registry([def]);
}

describe("registry load-time static guards", () => {
  it("rejects a write-gate that names a status unreachable from the initial status", () => {
    const def = definePageType({
      type: "dead-gate",
      version: 1,
      initialStatus: "draft",
      // `limbo` is a KNOWN status (a transition source) but nothing transitions INTO
      // it, so it is unreachable from `draft` → a write-gate naming it is dead.
      statusTransitions: [t("draft", "seal", "sealed"), t("limbo", "escape", "sealed")],
      sections: {
        body: { name: "Body", mutableIn: ["draft", "limbo"], fields: { text: { kind: "prose" } } },
      },
      sectionSet: { mode: "closed" },
      commands: { seal: { args: zodSchema(empty), transition: { level: "page", event: "seal" } } },
      render: { title: "{title}", sections: [] },
    } as never);
    expect(() => register(def)).toThrow(ValidationError);
  });

  it("rejects a required section that is never mutable (mutableIn: [])", () => {
    const def = definePageType({
      type: "unfillable",
      version: 1,
      initialStatus: "draft",
      statusTransitions: [],
      sections: {
        body: { name: "Body", required: true, mutableIn: [], fields: { text: { kind: "prose" } } },
      },
      sectionSet: { mode: "closed" },
      commands: {},
      render: { title: "{title}", sections: [] },
    } as never);
    expect(() => register(def)).toThrow(ValidationError);
  });

  it("rejects an element FSM with a state unreachable from its initial status", () => {
    const def = definePageType({
      type: "undrivable-element",
      version: 1,
      initialStatus: "draft",
      statusTransitions: [],
      sections: {
        items: { name: "Items", mutableIn: ["draft"], fields: { list: { kind: "list", element: "thing" } } },
      },
      elements: {
        thing: {
          fields: { text: { kind: "prose", required: true } },
          // `done` is mentioned but nothing transitions INTO it from `todo` → undrivable.
          status: { initial: "todo", transitions: [t("blocked", "finish", "done")] },
        },
      },
      sectionSet: { mode: "closed" },
      commands: {
        add: { args: zodSchema(z.object({ text: z.string() })), target: { section: "items", field: "list" }, set: { text: arg("text") } },
      },
      render: { title: "{title}", sections: [] },
    } as never);
    expect(() => register(def)).toThrow(ValidationError);
  });

  it("accepts a well-formed model (sanity: the guards do not false-positive)", () => {
    const def = definePageType({
      type: "ok",
      version: 1,
      initialStatus: "draft",
      statusTransitions: [t("draft", "seal", "sealed")],
      sections: {
        body: { name: "Body", required: true, mutableIn: ["draft"], fields: { items: { kind: "list", element: "thing" } } },
      },
      elements: {
        thing: {
          fields: { text: { kind: "prose", required: true } },
          status: { initial: "planned", transitions: [t("planned", "pass", "passed"), t("planned", "fail", "failed"), t("failed", "pass", "passed")] },
        },
      },
      sectionSet: { mode: "closed" },
      commands: {
        add: { args: zodSchema(z.object({ text: z.string() })), target: { section: "body", field: "items" }, set: { text: arg("text") } },
        seal: { args: zodSchema(empty), transition: { level: "page", event: "seal" } },
      },
      render: { title: "{title}", sections: [] },
    } as never);
    expect(() => register(def)).not.toThrow();
  });
});
