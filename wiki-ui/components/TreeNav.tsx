"use client";

/** Collapsible page-tree sidebar. Renders the engine's `ITreeNode` tree as in-app links — the
 *  primary navigation surface. On top of the engine's canonical order it layers two UI-only
 *  views (both per-workspace, persisted to localStorage):
 *    - archived pages (and their subtree) are hidden unless "Show archived" is on (the durable
 *      `archived` flag is engine state — engine ADR-011 — toggled here via archive/unarchive);
 *    - children can be dragged to reorder among their siblings (a local rearrangement, never
 *      written to the stream).
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import type { ITreeNode, PageId, WorkspaceId } from "wiki";
import { pageHref } from "../lib/routes";
import { useChildOrder, type ChildOrder } from "../lib/useChildOrder";
import { useCollapsed, type CollapsedState } from "../lib/useCollapsed";
import { useShowArchived } from "../lib/useShowArchived";
import { useStructuralMutator, type StructuralMutator } from "../lib/live";

type DragState = { id: string; parentKey: string } | null;

/** Everything the recursive tree rows share, bundled to avoid prop drilling. */
interface TreeCtx {
  workspaceId: WorkspaceId;
  activePageId: string | null;
  collapse: CollapsedState;
  order: ChildOrder;
  showArchived: boolean;
  structural: StructuralMutator;
  drag: DragState;
  setDrag: (d: DragState) => void;
  overId: string | null;
  setOverId: (id: string | null) => void;
}

/** True if any node in the forest (at any depth) is archived. */
function anyArchived(nodes: readonly ITreeNode[]): boolean {
  return nodes.some((n) => n.archived === true || anyArchived(n.children));
}

/** One level of siblings: applies the user's order + archived filter, and owns sibling reordering. */
function TreeChildren({
  parentKey,
  siblings,
  ctx,
  top = false,
}: {
  parentKey: string;
  siblings: readonly ITreeNode[];
  ctx: TreeCtx;
  top?: boolean;
}): React.JSX.Element | null {
  const ordered = ctx.order.applyOrder(parentKey, siblings);
  const visible = ordered.filter((n) => ctx.showArchived || n.archived !== true);
  if (visible.length === 0) return null;

  // Reorder within this parent. Direction-aware so an item can be dragged to either end:
  // dropping below its origin inserts AFTER the target, above inserts BEFORE. Reorders the
  // full `ordered` list (incl. hidden archived siblings) so their stored slots are preserved.
  const reorder = (draggedId: string, targetId: string): void => {
    if (draggedId === targetId) return;
    const ids = ordered.map((n) => String(n.id));
    const from = ids.indexOf(draggedId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    ids.splice(from, 1);
    const insertAt = from < to ? ids.indexOf(targetId) + 1 : ids.indexOf(targetId);
    ids.splice(insertAt, 0, draggedId);
    ctx.order.setOrder(parentKey, ids);
  };

  return (
    <ul className={top ? "tree" : "tree-children"}>
      {visible.map((child) => (
        <TreeItem key={child.id} node={child} parentKey={parentKey} reorder={reorder} ctx={ctx} />
      ))}
    </ul>
  );
}

function TreeItem({
  node,
  parentKey,
  reorder,
  ctx,
}: {
  node: ITreeNode;
  parentKey: string;
  reorder: (draggedId: string, targetId: string) => void;
  ctx: TreeCtx;
}): React.JSX.Element {
  const id = String(node.id);
  const isActive = id === ctx.activePageId;
  const hasChildren = node.children.length > 0;
  const collapsed = hasChildren && ctx.collapse.isCollapsed(id);
  const archived = node.archived === true;
  const isDragging = ctx.drag?.id === id;
  const isOver = ctx.overId === id && ctx.drag !== null && ctx.drag.parentKey === parentKey && ctx.drag.id !== id;

  const rowClass =
    "tree-row" +
    (isDragging ? " dragging" : "") +
    (isOver ? " drag-over" : "") +
    (archived ? " archived" : "");

  return (
    <li>
      <div
        className={rowClass}
        draggable
        onDragStart={(e) => {
          ctx.setDrag({ id, parentKey });
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", id); // required for Firefox to start a drag
        }}
        onDragEnd={() => {
          ctx.setDrag(null);
          ctx.setOverId(null);
        }}
        onDragOver={(e) => {
          if (ctx.drag !== null && ctx.drag.parentKey === parentKey && ctx.drag.id !== id) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (ctx.overId !== id) ctx.setOverId(id);
          }
        }}
        onDragLeave={() => {
          if (ctx.overId === id) ctx.setOverId(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (ctx.drag !== null && ctx.drag.parentKey === parentKey) reorder(ctx.drag.id, id);
          ctx.setDrag(null);
          ctx.setOverId(null);
        }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="tree-caret"
            aria-label={collapsed ? "Expand" : "Collapse"}
            aria-expanded={!collapsed}
            onClick={() => ctx.collapse.toggle(id)}
          >
            <span className={`caret${collapsed ? "" : " open"}`} aria-hidden="true">
              ▶
            </span>
          </button>
        ) : (
          <span className="tree-caret tree-caret-empty" aria-hidden="true" />
        )}
        <Link
          href={pageHref(ctx.workspaceId, node.id)}
          className={`tree-link${isActive ? " active" : ""}`}
          title={node.type !== undefined ? `${node.type} · ${node.status ?? ""}` : undefined}
          draggable={false}
        >
          <span className="tree-title">{node.title}</span>
          <span className="tree-meta">
            {archived && <span className="tree-badge">archived</span>}
            {node.status !== undefined && <span className="tree-status">{node.status}</span>}
          </span>
        </Link>
        <button
          type="button"
          className="tree-archive"
          aria-label={archived ? "Unarchive page" : "Archive page"}
          title={archived ? "Unarchive — restore to the sidebar" : "Archive — hide from the sidebar"}
          disabled={ctx.structural.pending}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (archived) void ctx.structural.unarchive(node.id as PageId);
            else void ctx.structural.archive(node.id as PageId);
          }}
        >
          {archived ? "unarchive" : "archive"}
        </button>
      </div>
      {hasChildren && !collapsed && <TreeChildren parentKey={id} siblings={node.children} ctx={ctx} />}
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
  const order = useChildOrder(workspaceId);
  const archivedView = useShowArchived(workspaceId);
  const structural = useStructuralMutator(workspaceId);
  const [drag, setDrag] = useState<DragState>(null);
  const [overId, setOverId] = useState<string | null>(null);

  if (tree === null) return <p className="muted">Loading tree…</p>;
  if (tree.children.length === 0) return <p className="muted">No pages in this workspace yet.</p>;

  const ctx: TreeCtx = {
    workspaceId,
    activePageId,
    collapse,
    order,
    showArchived: archivedView.show,
    structural,
    drag,
    setDrag,
    overId,
    setOverId,
  };
  const hasArchived = anyArchived(tree.children);

  return (
    <div className="tree-wrap">
      {(hasArchived || archivedView.show) && (
        <div className="tree-toolbar">
          <button
            type="button"
            className="tree-toggle-archived"
            aria-pressed={archivedView.show}
            onClick={archivedView.toggle}
          >
            {archivedView.show ? "Hide archived" : "Show archived"}
          </button>
        </div>
      )}
      {structural.error !== null && (
        <p className="tree-error" role="alert">
          {structural.error}
        </p>
      )}
      <TreeChildren parentKey={String(tree.id)} siblings={tree.children} ctx={ctx} top />
    </div>
  );
}
