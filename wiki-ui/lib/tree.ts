/** Small read-only helpers over the engine's `ITreeNode` (no presentation logic). */
import type { ITreeNode, PageId } from "wiki";

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

/** One choice in the create-page parent picker: a page the new page can be created under. */
export interface ParentOption {
  readonly id: PageId;
  readonly title: string;
  /** Nesting depth from the root's children (0 = top level), for indenting the option text. */
  readonly depth: number;
}

/**
 * The tree flattened depth-first into parent choices. Archived pages are skipped along with
 * their whole subtree — the engine rejects creating under an archived parent
 * (`ParentNotFoundError`), so offering one would only produce an error. The root itself is not
 * an option; "top level" is `parentId: null` and the caller supplies that entry.
 */
export function parentOptions(root: ITreeNode | null): readonly ParentOption[] {
  const out: ParentOption[] = [];
  const walk = (nodes: readonly ITreeNode[], depth: number): void => {
    for (const n of nodes) {
      if (n.archived === true) continue;
      out.push({ id: n.id as PageId, title: n.displayTitle ?? n.title, depth });
      walk(n.children, depth + 1);
    }
  };
  walk(root?.children ?? [], 0);
  return out;
}
