import { describe, expect, it } from "vitest";

import { isBlockImage, ownLinePadding, parseImageSource } from "./md-live";

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

describe("parseImageSource", () => {
  it("reads a pasted attachment image", () => {
    expect(parseImageSource(`![screenshot](attachment:${"d".repeat(64)})`)).toEqual({
      alt: "screenshot",
      ref: `attachment:${"d".repeat(64)}`,
    });
  });

  it("reads an ordinary URL, title and all", () => {
    expect(parseImageSource('![](https://example.com/a.png "A")')).toEqual({ alt: "", ref: "https://example.com/a.png" });
  });

  it("is null for the upload placeholder, which has no ref yet", () => {
    expect(parseImageSource("![uploading a.png… #1]()")).toBeNull();
  });

  it("is null for a link, which is not an image", () => {
    expect(parseImageSource("[a](https://example.com)")).toBeNull();
  });
});

describe("isBlockImage", () => {
  it("is a block image alone on its line", () => {
    expect(isBlockImage("", "")).toBe(true);
    expect(isBlockImage("   ", "  ")).toBe(true);
  });

  it("is a block image under a quote or a list marker — block-md strips those", () => {
    expect(isBlockImage("> ", "")).toBe(true);
    expect(isBlockImage(">> ", "")).toBe(true);
    expect(isBlockImage("- ", "")).toBe(true);
    expect(isBlockImage("  1. ", "")).toBe(true);
  });

  it("is not one when it shares the line with words", () => {
    expect(isBlockImage("as shown here: ", "")).toBe(false);
    expect(isBlockImage("", " — and that is that")).toBe(false);
  });
});
