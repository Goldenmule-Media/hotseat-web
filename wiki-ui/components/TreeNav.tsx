"use client";

/** Collapsible page-tree sidebar (plan step 5). Renders the engine's `ITreeNode` tree
 *  (ordered by ordinal) as in-app links — the primary navigation surface. Nodes with
 *  children get a caret toggle; the collapsed set is persisted per workspace (see
 *  `useCollapsed`). */
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ITreeNode, WorkspaceId } from "wiki";
import { pageHref } from "../lib/routes";
import { useCollapsed, type CollapsedState } from "../lib/useCollapsed";

function TreeItem({
  node,
  workspaceId,
  activePageId,
  collapse,
}: {
  node: ITreeNode;
  workspaceId: WorkspaceId;
  activePageId: string | null;
  collapse: CollapsedState;
}): React.JSX.Element {
  const isActive = node.id === activePageId;
  const hasChildren = node.children.length > 0;
  const collapsed = hasChildren && collapse.isCollapsed(node.id);
  return (
    <li>
      <div className="tree-row">
        {hasChildren ? (
          <button
            type="button"
            className="tree-caret"
            aria-label={collapsed ? "Expand" : "Collapse"}
            aria-expanded={!collapsed}
            onClick={() => collapse.toggle(node.id)}
          >
            <span className={`caret${collapsed ? "" : " open"}`} aria-hidden="true">
              ▶
            </span>
          </button>
        ) : (
          <span className="tree-caret tree-caret-empty" aria-hidden="true" />
        )}
        <Link
          href={pageHref(workspaceId, node.id)}
          className={`tree-link${isActive ? " active" : ""}`}
          title={node.type !== undefined ? `${node.type} · ${node.status ?? ""}` : undefined}
        >
          <span className="tree-title">{node.title}</span>
          {node.status !== undefined && <span className="tree-status">{node.status}</span>}
        </Link>
      </div>
      {hasChildren && !collapsed && (
        <ul className="tree-children">
          {node.children.map((child) => (
            <TreeItem
              key={child.id}
              node={child}
              workspaceId={workspaceId}
              activePageId={activePageId}
              collapse={collapse}
            />
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
  const collapse = useCollapsed(workspaceId);

  if (tree === null) return <p className="muted">Loading tree…</p>;
  if (tree.children.length === 0) return <p className="muted">No pages in this workspace yet.</p>;

  return (
    <ul className="tree">
      {tree.children.map((node) => (
        <TreeItem key={node.id} node={node} workspaceId={workspaceId} activePageId={activePageId} collapse={collapse} />
      ))}
    </ul>
  );
}
