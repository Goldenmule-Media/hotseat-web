/**
 * The spec outline: pure projections of the FLAT ordered section list onto the heading
 * hierarchy it encodes. A `spec-section` carries a 0-based `depth` scalar; a section's
 * children are the run of deeper sections that immediately follows it — exactly how
 * Markdown's own heading levels work. Nothing here mutates; the studio uses these to draw
 * the tree, disable illegal indents, and hide a collapsed section's subtree.
 */
import type { SectionElementSummary } from "./wiki-host-api";

/** A section's 0-based outline depth (missing or malformed reads as top level). */
export function depthOf(el: SectionElementSummary | undefined): number {
  const raw = el?.scalars?.["depth"];
  const n = typeof raw === "number" ? raw : Number(raw ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** The required slot this section fills, or "" when the spec added it itself. */
export function slotOf(el: SectionElementSummary | undefined): string {
  const raw = el?.scalars?.["slot"];
  return typeof raw === "string" ? raw : "";
}

/** The half-open index range of the section at `index` plus its descendants. */
export function subtreeRange(
  elements: readonly SectionElementSummary[],
  index: number,
): { start: number; end: number } {
  const base = depthOf(elements[index]);
  let end = index + 1;
  while (end < elements.length && depthOf(elements[end]) > base) end++;
  return { start: index, end };
}

/** Indices of the section at `index` and every descendant. */
export function subtreeIds(elements: readonly SectionElementSummary[], index: number): string[] {
  const { start, end } = subtreeRange(elements, index);
  return elements.slice(start, end).map((e) => e.id);
}

/** Ids of every ancestor of the section at `index`, outermost first. */
export function ancestorIds(elements: readonly SectionElementSummary[], index: number): string[] {
  const out: string[] = [];
  let want = depthOf(elements[index]) - 1;
  for (let i = index - 1; i >= 0 && want >= 0; i--) {
    if (depthOf(elements[i]) === want) {
      out.unshift(elements[i]!.id);
      want--;
    }
  }
  return out;
}

export function hasChildren(elements: readonly SectionElementSummary[], index: number): boolean {
  return subtreeRange(elements, index).end > index + 1;
}

/**
 * May the section at `index` be indented? Only under a section that is already at or
 * below its own level — otherwise the outline would skip a heading level. A slot section
 * stays top-level, so it never indents.
 */
export function canIndent(elements: readonly SectionElementSummary[], index: number): boolean {
  if (index <= 0) return false;
  if (slotOf(elements[index]).length > 0) return false;
  return depthOf(elements[index - 1]) >= depthOf(elements[index]);
}

export function canOutdent(elements: readonly SectionElementSummary[], index: number): boolean {
  return depthOf(elements[index]) > 0;
}

/**
 * Ids hidden because an ANCESTOR is collapsed. Collapsing a section folds away everything
 * nested under it — the point of collapsing a long spec is to see its top-level shape.
 */
export function hiddenByCollapse(
  elements: readonly SectionElementSummary[],
  collapsed: ReadonlySet<string>,
): Set<string> {
  const hidden = new Set<string>();
  for (let i = 0; i < elements.length; i++) {
    if (!collapsed.has(elements[i]!.id)) continue;
    const { end } = subtreeRange(elements, i);
    for (let j = i + 1; j < end; j++) hidden.add(elements[j]!.id);
  }
  return hidden;
}

/**
 * The section a "move up" should land BEFORE, and the one a "move down" should land
 * AFTER: the previous/next SIBLING at the same depth, so reordering walks the outline
 * rather than dropping a section into someone else's subtree. Returns the target index in
 * the list-with-this-subtree-lifted-out that `moveSection` expects, or null when there is
 * no sibling that way.
 */
export function siblingMoveTarget(
  elements: readonly SectionElementSummary[],
  index: number,
  direction: "up" | "down",
): number | null {
  const depth = depthOf(elements[index]);
  const { start, end } = subtreeRange(elements, index);
  const lifted = elements.filter((_, i) => i < start || i >= end);
  if (direction === "up") {
    for (let i = index - 1; i >= 0; i--) {
      const d = depthOf(elements[i]);
      if (d < depth) return null; // hit the parent — no earlier sibling
      if (d === depth) return lifted.findIndex((e) => e.id === elements[i]!.id);
    }
    return null;
  }
  for (let i = end; i < elements.length; i++) {
    const d = depthOf(elements[i]);
    if (d < depth) return null; // left the parent's subtree
    if (d === depth) {
      const nextEnd = subtreeRange(elements, i).end;
      const after = elements[nextEnd];
      // Land after that sibling's whole subtree: before whatever follows it, or at the end.
      return after === undefined ? lifted.length : lifted.findIndex((e) => e.id === after.id);
    }
  }
  return null;
}
