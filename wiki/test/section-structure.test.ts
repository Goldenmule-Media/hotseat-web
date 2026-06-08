/**
 * Section-tree structural invariants: unique sibling key, acyclic tree,
 * required-section non-removal, and the engine errors they raise.
 */
import { describe, expect, it } from "vitest";

import type { ISection, SectionId } from "../src/api";
import {
  insertSection,
  isSelfOrDescendantSection,
  moveSectionByKey,
  removeSectionByKey,
} from "../src/core/section-structure";
import { DuplicateSectionKeyError, SectionContractError, SectionNotFoundError } from "../src/core/errors";

function sec(key: string, parentId: SectionId | null = null, order = 0): ISection {
  return { id: `sec:${key}` as SectionId, key, name: key, order, parentId, fields: {} };
}

describe("section structure", () => {
  it("rejects a duplicate sibling key", () => {
    const sections = [sec("a")];
    expect(() => insertSection(sections, { id: "sec:a2" as SectionId, key: "a", name: "A", parentId: null })).toThrow(DuplicateSectionKeyError);
  });

  it("maintains explicit order on insert at an index", () => {
    const sections = [sec("a", null, 0), sec("b", null, 1)];
    insertSection(sections, { id: "sec:c" as SectionId, key: "c", name: "C", parentId: null }, 1);
    const ordered = sections.filter((s) => s.parentId === null).sort((x, y) => x.order - y.order).map((s) => s.key);
    expect(ordered).toEqual(["a", "c", "b"]);
  });

  it("detects a cycle (self or descendant)", () => {
    const sections = [sec("a"), sec("b", "sec:a" as SectionId)];
    expect(isSelfOrDescendantSection(sections, "sec:a" as SectionId, "sec:b" as SectionId)).toBe(true);
    expect(() => moveSectionByKey(sections, "a", "sec:b" as SectionId, 0)).toThrow(SectionContractError);
  });

  it("removes a section subtree", () => {
    const sections = [sec("a"), sec("b", "sec:a" as SectionId)];
    removeSectionByKey(sections, "a");
    expect(sections.map((s) => s.key)).toEqual([]);
  });

  it("throws SectionNotFound for an unknown key", () => {
    expect(() => removeSectionByKey([sec("a")], "zzz")).toThrow(SectionNotFoundError);
  });
});
