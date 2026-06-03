/**
 * Intra-page section-tree mechanics + invariants (structured-content §2, §6).
 * Pure helpers reused by the reducer (`operations.ts`) and the registry's contract
 * checks. Mirrors the page-tree acyclic/ordering invariants at the section level:
 * unique sibling key, acyclic tree, explicit `order` maintained on insert/move.
 */
import type { ISection, SectionId } from "../api";
import { DuplicateSectionKeyError, SectionContractError, SectionNotFoundError } from "./errors";

/** Resolve a section by key, or throw {@link SectionNotFoundError}. */
export function requireSectionByKey(sections: ISection[], key: string): ISection {
  const s = sections.find((x) => x.key === key);
  if (s === undefined) throw new SectionNotFoundError(key);
  return s;
}

export function findSectionById(sections: ISection[], id: SectionId): ISection | undefined {
  return sections.find((s) => s.id === id);
}

/** Sibling sections (same parent), in explicit `order`. */
export function siblingsOf(sections: ISection[], parentId: SectionId | null): ISection[] {
  return sections.filter((s) => s.parentId === parentId).sort((a, b) => a.order - b.order);
}

/** Is `candidate` `id` itself or a descendant of `id` in the section tree? */
export function isSelfOrDescendantSection(
  sections: ISection[],
  id: SectionId,
  candidate: SectionId,
): boolean {
  if (candidate === id) return true;
  const stack: SectionId[] = sections.filter((s) => s.parentId === id).map((s) => s.id);
  const seen = new Set<SectionId>();
  while (stack.length > 0) {
    const cur = stack.pop() as SectionId;
    if (cur === candidate) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const child of sections.filter((s) => s.parentId === cur)) stack.push(child.id);
  }
  return false;
}

function assertUniqueSiblingKey(
  sections: ISection[],
  parentId: SectionId | null,
  key: string,
  excludeId?: SectionId,
): void {
  for (const s of sections) {
    if (s.id === excludeId) continue;
    if (s.parentId === parentId && s.key === key) {
      throw new DuplicateSectionKeyError(key);
    }
  }
}

/** Renumber the siblings under `parentId` to 0..n in their current sorted order. */
function renumber(sections: ISection[], parentId: SectionId | null): void {
  const sibs = siblingsOf(sections, parentId);
  sibs.forEach((s, i) => {
    s.order = i;
  });
}

/** Insert a new section. Mutates `sections`. Returns the inserted section. */
export function insertSection(
  sections: ISection[],
  next: { id: SectionId; key: string; name: string; description?: string; parentId: SectionId | null },
  index?: number,
): ISection {
  assertUniqueSiblingKey(sections, next.parentId, next.key);
  const sibs = siblingsOf(sections, next.parentId);
  const at = index === undefined ? sibs.length : Math.max(0, Math.min(index, sibs.length));
  const section: ISection = {
    id: next.id,
    key: next.key,
    name: next.name,
    ...(next.description !== undefined ? { description: next.description } : {}),
    order: at,
    parentId: next.parentId,
    fields: {},
  };
  // shift siblings at/after `at` up by one, then push & renumber for safety.
  sections.push(section);
  // place at the requested index by renumbering siblings in target order.
  const ordered = siblingsOf(sections, next.parentId).filter((s) => s.id !== section.id);
  ordered.splice(at, 0, section);
  ordered.forEach((s, i) => {
    s.order = i;
  });
  return section;
}

export function removeSectionByKey(sections: ISection[], key: string): void {
  const target = requireSectionByKey(sections, key);
  // Remove the subtree.
  const toRemove = new Set<SectionId>([target.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of sections) {
      if (s.parentId !== null && toRemove.has(s.parentId) && !toRemove.has(s.id)) {
        toRemove.add(s.id);
        grew = true;
      }
    }
  }
  const parentId = target.parentId;
  for (let i = sections.length - 1; i >= 0; i--) {
    if (toRemove.has(sections[i]!.id)) sections.splice(i, 1);
  }
  renumber(sections, parentId);
}

export function moveSectionByKey(
  sections: ISection[],
  key: string,
  parentSection: SectionId | null,
  toIndex: number,
): void {
  const target = requireSectionByKey(sections, key);
  if (parentSection !== null) {
    if (findSectionById(sections, parentSection) === undefined) {
      throw new SectionNotFoundError(String(parentSection));
    }
    if (isSelfOrDescendantSection(sections, target.id, parentSection)) {
      throw new SectionContractError(`Moving section "${key}" under its own subtree would create a cycle.`);
    }
  }
  assertUniqueSiblingKey(sections, parentSection, target.key, target.id);
  const oldParent = target.parentId;
  target.parentId = parentSection;
  const ordered = siblingsOf(sections, parentSection).filter((s) => s.id !== target.id);
  const at = Math.max(0, Math.min(toIndex, ordered.length));
  ordered.splice(at, 0, target);
  ordered.forEach((s, i) => {
    s.order = i;
  });
  if (oldParent !== parentSection) renumber(sections, oldParent);
}

export function renameSectionByKey(sections: ISection[], key: string, name: string): void {
  requireSectionByKey(sections, key).name = name;
}
