import { describe, expect, it } from "vitest";
import type { ElementDecl, IPageTypeDef, SectionDecl } from "wiki";
import { defOf } from "./models";
import { buildSchemaModel, FIELD_KIND_HINT, type FieldKind } from "./schema-inspector";

/** Minimal def carrying just the bits buildSchemaModel reads (type + sections + elements). */
function def(
  sections: Record<string, SectionDecl>,
  elements: Record<string, ElementDecl> = {},
  type = "t",
): IPageTypeDef {
  return { type, sections, elements } as unknown as IPageTypeDef;
}

const section = (over: Partial<SectionDecl> = {}): SectionDecl => ({ name: "S", fields: {}, ...over });

describe("buildSchemaModel — section mutability", () => {
  const d = def({
    summary: section({ name: "Summary", mutableIn: ["draft", "planning", "building"] }),
  });

  it("a gated section is mutableNow only in a listed status", () => {
    expect(buildSchemaModel(d, "draft").sections[0].mutableNow).toBe(true);
    expect(buildSchemaModel(d, "shipped").sections[0].mutableNow).toBe(false);
  });

  it("an undeclared mutableIn means always mutable (mutableIn=null)", () => {
    const open = def({ s: section() });
    expect(buildSchemaModel(open, "anything").sections[0].mutableNow).toBe(true);
    expect(buildSchemaModel(open, "anything").sections[0].mutableIn).toBeNull();
  });
});

describe("buildSchemaModel — fields", () => {
  it("maps every field kind to the correct row kind", () => {
    const kinds = ["scalar", "prose", "code", "attachment-ref", "ref", "blocks", "serial"] as const;
    const fields = Object.fromEntries(kinds.map((k) => [k, { kind: k }]));
    const rows = buildSchemaModel(def({ s: section({ fields: fields as SectionDecl["fields"] }) }), "x").sections[0]
      .fields;
    expect(rows.map((r) => r.kind).sort()).toEqual([...kinds].sort());
  });

  it("surfaces list element/ordered and ref targetKinds", () => {
    const d = def({
      s: section({
        fields: {
          items: { kind: "list", element: "step", ordered: true },
          link: { kind: "ref", targetKinds: ["page"] },
        },
      }),
    });
    const [items, link] = buildSchemaModel(d, "x").sections[0].fields;
    expect(items).toMatchObject({ kind: "list", elementType: "step", ordered: true });
    expect(link).toMatchObject({ kind: "ref", targetKinds: ["page"] });
  });

  it("requiredInCurrent is true exactly when requiredIn includes the current status", () => {
    const d = def({ s: section({ fields: { body: { kind: "prose", requiredIn: ["open", "closed"] } } }) });
    expect(buildSchemaModel(d, "open").sections[0].fields[0].requiredInCurrent).toBe(true);
    expect(buildSchemaModel(d, "draft").sections[0].fields[0].requiredInCurrent).toBe(false);
  });
});

describe("buildSchemaModel — nesting & order", () => {
  it("recurses into nested subsections", () => {
    const d = def({
      parent: section({ name: "Parent", sections: { child: section({ name: "Child" }) } }),
    });
    const top = buildSchemaModel(d, "x").sections[0];
    expect(top.subsections).toHaveLength(1);
    expect(top.subsections[0].name).toBe("Child");
  });

  it("preserves the def's section key order deterministically", () => {
    const d = def({ b: section(), a: section(), c: section() });
    expect(buildSchemaModel(d, "x").sections.map((s) => s.key)).toEqual(["b", "a", "c"]);
  });
});

describe("buildSchemaModel — field-kind hints", () => {
  it("every FieldKind has a plain-language hint, and rows carry it (shown on hover)", () => {
    const kinds: FieldKind[] = ["scalar", "prose", "code", "attachment-ref", "ref", "blocks", "list", "serial"];
    for (const k of kinds) expect(FIELD_KIND_HINT[k]).toBeTruthy();
    const d = def({ s: section({ fields: { body: { kind: "prose" } } }) });
    expect(buildSchemaModel(d, "x").sections[0].fields[0].hint).toBe(FIELD_KIND_HINT.prose);
  });
});

describe("buildSchemaModel — list element resolution", () => {
  it("resolves a list field's element type to its own fields", () => {
    const d = def(
      { components: section({ fields: { items: { kind: "list", element: "component" } } }) },
      { component: { fields: { name: { kind: "scalar", required: true } } } },
    );
    const items = buildSchemaModel(d, "x").sections[0].fields[0];
    expect(items.element).not.toBeNull();
    expect(items.element!.type).toBe("component");
    expect(items.element!.fields.map((f) => f.key)).toEqual(["name"]);
    expect(items.element!.fields[0].kind).toBe("scalar");
  });

  it("surfaces an element type's lifecycle states when it declares an FSM", () => {
    const d = def(
      { questions: section({ fields: { items: { kind: "list", element: "question" } } }) },
      {
        question: {
          fields: { text: { kind: "prose" } },
          status: { initial: "open", transitions: [{ fromState: "open", event: "answer", toState: "resolved" }] },
        } as unknown as ElementDecl,
      },
    );
    expect(buildSchemaModel(d, "x").sections[0].fields[0].element!.states).toEqual(["open", "resolved"]);
  });

  it("leaves element null (no infinite recursion) when the element type is unknown or self-referential", () => {
    const unknown = def({ s: section({ fields: { items: { kind: "list", element: "missing" } } }) }, {});
    expect(buildSchemaModel(unknown, "x").sections[0].fields[0].element).toBeNull();

    const selfRef = def(
      { s: section({ fields: { items: { kind: "list", element: "node" } } }) },
      { node: { fields: { kids: { kind: "list", element: "node" } } } },
    );
    const top = buildSchemaModel(selfRef, "x").sections[0].fields[0];
    expect(top.element!.type).toBe("node");
    // the nested self-reference stops resolving
    expect(top.element!.fields[0].element).toBeNull();
  });
});

describe("defOf", () => {
  it("returns the def for a bundled type and null for unknown/undefined", () => {
    const fb = defOf("feature-brief");
    expect(fb).not.toBeNull();
    expect(fb!.type).toBe("feature-brief");
    expect(defOf("not-a-real-type")).toBeNull();
    expect(defOf(undefined)).toBeNull();
  });

  it("a real bundle's gated section locks outside its mutableIn (end-to-end with buildSchemaModel)", () => {
    const fb = defOf("feature-brief")!;
    const summary = buildSchemaModel(fb, "shipped").sections.find((s) => s.key === "summary")!;
    expect(summary.mutableNow).toBe(false); // summary.mutableIn = ["draft","planning"]
    expect(buildSchemaModel(fb, "draft").sections.find((s) => s.key === "summary")!.mutableNow).toBe(true);
  });
});
