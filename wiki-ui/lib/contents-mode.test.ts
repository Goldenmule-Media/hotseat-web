/**
 * The contents-mode detector reads a page type's own declarations — it must find the toggle
 * on `toc` without naming it, and find nothing on a type that has no such mode.
 */
import { describe, expect, it } from "vitest";

import { contentsModeOf, isInline } from "./contents-mode";
import { defOf } from "./models";

describe("contentsModeOf", () => {
  it("discovers the toggle on the type that declares one", () => {
    const mode = contentsModeOf(defOf("toc"));
    expect(mode).not.toBeNull();
    expect(mode).toEqual({ command: "setContentsMode", arg: "mode", inline: "inline", links: "links" });
  });

  it("returns null for a type with no inline-children section", () => {
    expect(contentsModeOf(defOf("document"))).toBeNull();
    expect(contentsModeOf(defOf("bug-report"))).toBeNull();
  });

  it("returns null for an unknown type", () => {
    expect(contentsModeOf(defOf("no-such-type"))).toBeNull();
    expect(contentsModeOf(null)).toBeNull();
  });

  it("reads the current mode off the page's own field, defaulting to not-inline", () => {
    const def = defOf("toc");
    const mode = contentsModeOf(def);
    // Unset — a freshly created page — is the link list, not the feed.
    expect(isInline(def, mode, () => undefined)).toBe(false);
    expect(isInline(def, mode, () => "")).toBe(false);
    expect(isInline(def, mode, () => "links")).toBe(false);
    expect(isInline(def, mode, () => "inline")).toBe(true);
  });

  it("asks for the field the render actually gates on", () => {
    const def = defOf("toc");
    const asked: string[] = [];
    isInline(def, contentsModeOf(def), (section, field) => {
      asked.push(`${section}.${field}`);
      return "inline";
    });
    expect(asked).toEqual(["display.contents"]);
  });
});
