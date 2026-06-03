"use client";

/** Collapsible page-tree sidebar (plan step 5). Renders the engine's `ITreeNode` tree
 *  (ordered by ordinal) as in-app links — the primary navigation surface. */
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ITreeNode, WorkspaceId } from "wiki";
import { pageHref } from "../lib/routes";

function TreeItem({
  node,
  workspaceId,
  activePageId,
}: {
  node: ITreeNode;
  workspaceId: WorkspaceId;
  activePageId: string | null;
}): React.JSX.Element {
  const isActive = node.id === activePageId;
  return (
    <li>
      <Link
        href={pageHref(workspaceId, node.id)}
        className={`tree-link${isActive ? " active" : ""}`}
        title={node.type !== undefined ? `${node.type} · ${node.status ?? ""}` : undefined}
      >
        <span className="tree-title">{node.title}</span>
        {node.status !== undefined && <span className="tree-status">{node.status}</span>}
      </Link>
      {node.children.length > 0 && (
        <ul className="tree-children">
          {node.children.map((child) => (
            <TreeItem key={child.id} node={child} workspaceId={workspaceId} activePageId={activePageId} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function TreeNav({
  tree,
  workspaceId,
}: {
  tree: ITreeNode | null;
  workspaceId: WorkspaceId;
}): React.JSX.Element {
  const pathname = usePathname();
  // active page id is the last decoded path segment, if any
  const segs = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const activePageId = segs.length >= 2 ? segs[1] : null;

  if (tree === null) return <p className="muted">Loading tree…</p>;
  if (tree.children.length === 0) return <p className="muted">No pages in this workspace yet.</p>;

  return (
    <ul className="tree">
      {tree.children.map((node) => (
        <TreeItem key={node.id} node={node} workspaceId={workspaceId} activePageId={activePageId} />
      ))}
    </ul>
  );
}
