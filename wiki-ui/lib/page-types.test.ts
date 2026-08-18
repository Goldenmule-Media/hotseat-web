import { describe, expect, it } from "vitest";
import type { IPageTypeDef } from "wiki";
import { pageTypeOptions } from "./page-types";

/** A minimal def — only the fields pageTypeOptions reads are meaningful. */
function def(partial: Partial<IPageTypeDef> & { type: string }): IPageTypeDef {
  return {
    version: 1,
    initialStatus: "draft",
    statusTransitions: [],
    sections: {},
    commands: {},
    render: {},
    ...partial,
  } as IPageTypeDef;
}

describe("pageTypeOptions", () => {
  it("prefers the declared label and falls back to a title-cased tag", () => {
    const opts = pageTypeOptions([def({ type: "bug-report", label: "Bug report" }), def({ type: "feature-brief" })]);
    expect(opts.map((o) => o.label)).toEqual(["Bug report", "Feature brief"]);
  });

  it("carries description through and omits it when undeclared", () => {
    const [withDesc, without] = pageTypeOptions([
      def({ type: "a-type", description: "What it is for." }),
      def({ type: "b-type" }),
    ]);
    expect(withDesc.description).toBe("What it is for.");
    expect(without).not.toHaveProperty("description");
  });

  it("marks a type auto-created when another type lists it in requiredChildren", () => {
    const opts = pageTypeOptions([
      def({ type: "feature-brief", label: "Feature brief", requiredChildren: ["testing-plan"] }),
      def({ type: "testing-plan", label: "Testing plan" }),
    ]);
    const testing = opts.find((o) => o.type === "testing-plan")!;
    const brief = opts.find((o) => o.type === "feature-brief")!;
    expect(testing.autoCreatedBy).toBe("Feature brief");
    expect(brief).not.toHaveProperty("autoCreatedBy");
    expect(brief.requiredChildren).toEqual(["testing-plan"]);
  });

  it("sorts auto-created types last, each group alphabetically by label", () => {
    const opts = pageTypeOptions([
      def({ type: "testing-plan", label: "Testing plan" }),
      def({ type: "zeta", label: "Zeta" }),
      def({ type: "feature-brief", label: "Feature brief", requiredChildren: ["testing-plan"] }),
      def({ type: "adr", label: "ADR" }),
    ]);
    expect(opts.map((o) => o.label)).toEqual(["ADR", "Feature brief", "Zeta", "Testing plan"]);
  });

  it("defaults requiredChildren to an empty array", () => {
    expect(pageTypeOptions([def({ type: "solo" })])[0].requiredChildren).toEqual([]);
  });

  it("attributes an auto-created type to the first owner when several claim it", () => {
    const opts = pageTypeOptions([
      def({ type: "alpha", label: "Alpha", requiredChildren: ["shared"] }),
      def({ type: "beta", label: "Beta", requiredChildren: ["shared"] }),
      def({ type: "shared", label: "Shared" }),
    ]);
    expect(opts.find((o) => o.type === "shared")!.autoCreatedBy).toBe("Alpha");
  });
});
