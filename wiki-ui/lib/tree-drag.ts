/**
 * Pure geometry + legality for the sidebar's drag-and-drop (see `TreeNav`).
 *
 * A row is three drop bands: the outer quarters place the dragged page as a SIBLING before /
 * after it, the middle half makes it a CHILD of it. Sibling drops within one parent are a
 * local rearrangement (see `useChildOrder`); everything else is a real `reparent` on the
 * stream. Legality is exactly the engine's two structural rules — no cycles, and a pinned
 * page never leaves its owner — checked here so an illegal drop shows no drop affordance
 * rather than failing after the fact.
 */
import type { ITreeNode } from "wiki";

export type DropZone = "before" | "inside" | "after";

/** The band `offsetY` falls in for a row of `height` pixels. */
export function zoneAt(offsetY: number, height: number): DropZone {
  if (height <= 0) return "inside";
  const ratio = offsetY / height;
  if (ratio < 0.25) return "before";
  if (ratio > 0.75) return "after";
  return "inside";
}

/** Every id in `node`'s subtree, itself included. */
export function subtreeIds(node: ITreeNode): ReadonlySet<string> {
  const out = new Set<string>();
  const walk = (n: ITreeNode): void => {
    out.add(String(n.id));
    for (const c of n.children) walk(c);
  };
  walk(node);
  return out;
}

export interface DropAnchor {
  readonly id: string;
  readonly side: "before" | "after";
}

/** Where a drop puts the dragged page: under `parentKey`, next to `anchor` (or appended). */
export interface MoveIntent {
  readonly parentKey: string;
  readonly anchor?: DropAnchor;
}

export interface DragSource {
  readonly id: string;
  readonly parentKey: string;
  readonly pinned: boolean;
  /** `id` plus every descendant — a drop into any of these would cycle. */
  readonly subtree: ReadonlySet<string>;
}

/** The move a drop on `targetId` means, or `null` when the engine would refuse it. */
export function resolveDrop(
  drag: DragSource,
  target: { readonly id: string; readonly parentKey: string },
  zone: DropZone,
): MoveIntent | null {
  // Self or own descendant. A sibling drop is covered too: if the target's PARENT were in the
  // subtree the target itself would be as well.
  if (drag.subtree.has(target.id)) return null;
  const intent: MoveIntent =
    zone === "inside"
      ? { parentKey: target.id }
      : { parentKey: target.parentKey, anchor: { id: target.id, side: zone } };
  if (drag.pinned && intent.parentKey !== drag.parentKey) return null;
  return intent;
}

/** A drop on the "top level" strip: append to the root, unless the page is pinned. */
export function resolveRootDrop(drag: DragSource, rootKey: string): MoveIntent | null {
  if (drag.pinned && drag.parentKey !== rootKey) return null;
  return { parentKey: rootKey };
}

/** `siblingIds` with `dragId` (re)placed at `anchor`, or appended when there is none. */
export function placeAt(siblingIds: readonly string[], dragId: string, anchor?: DropAnchor): string[] {
  const ids = siblingIds.filter((id) => id !== dragId);
  const at = anchor === undefined ? -1 : ids.indexOf(anchor.id);
  if (at === -1) ids.push(dragId);
  else ids.splice(anchor?.side === "before" ? at : at + 1, 0, dragId);
  return ids;
}
