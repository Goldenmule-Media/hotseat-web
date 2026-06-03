/** Small read-only helpers over the engine's `ITreeNode` (no presentation logic). */
import type { ITreeNode } from "wiki";

/** Depth-first search for a node by id. */
export function findNode(root: ITreeNode | null, id: string): ITreeNode | null {
  if (root === null) return null;
  if (root.id === id) return root;
  for (const child of root.children) {
    const hit = findNode(child, id);
    if (hit !== null) return hit;
  }
  return null;
}
