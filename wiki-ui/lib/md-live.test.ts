import { describe, expect, it } from "vitest";

import { ownLinePadding } from "./md-live";

describe("ownLinePadding", () => {
  it("adds nothing on an empty line", () => {
    expect(ownLinePadding("", "")).toEqual({ lead: "", trail: "" });
  });

  it("breaks out of a line that already has words on it", () => {
    expect(ownLinePadding("as the paper puts it: ", "")).toEqual({ lead: "\n", trail: "" });
  });

  it("pushes the rest of the line down when pasting mid-sentence", () => {
    expect(ownLinePadding("before ", " after")).toEqual({ lead: "\n", trail: "\n" });
  });

  it("treats indentation as empty — a list item's marker is not words", () => {
    expect(ownLinePadding("   ", "  ")).toEqual({ lead: "", trail: "" });
  });
});
