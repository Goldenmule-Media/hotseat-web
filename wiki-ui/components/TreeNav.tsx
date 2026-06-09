"use client";

/** Collapsible page-tree sidebar. Renders the engine's `ITreeNode` tree as in-app links — the
 *  primary navigation surface. Two UI-only layers sit on top (per-workspace, localStorage):
 *    - children can be dragged to reorder among their siblings (a local rearrangement, never
 *      written to the stream — see `useChildOrder`);
 *    - archived pages (the durable `archived` flag, engine ADR-011) are kept OUT of the main
 *      tree and surfaced in a collapsible "Archived" section at the foot, from which they can be
 *      opened or unarchived. Archiving itself lives on the page content (see PageView).
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import type { ITreeNode, PageId, WorkspaceId } from "wiki";
import { pageHref } from "../lib/routes";
import { useChildOrder, type ChildOrder } from "../lib/useChildOrder";
import { useCollapsed, type CollapsedState } from "../lib/useCollapsed";
import { useShowArchived } from "../lib/useShowArchived";
import { useStructuralMutator } from "../lib/live";
import { isTerminalNodeStatus } from "../lib/terminal";

/** The status chip next to a sidebar title — visually distinct when the status is terminal
 *  (sealed/final), so finished pages read differently at a glance. */
function StatusChip({ node }: { node: ITreeNode }): React.JSX.Element | null {
  if (node.status === undefined) return null;
  const terminal = isTerminalNodeStatus(node.type, node.status);
  return <span className={`tree-status${terminal ? " tree-status-terminal" : ""}`}>{node.status}</span>;
}

type DragState = { id: string; parentKey: string } | null;

/** Everything the recursive tree rows share, bundled to avoid prop drilling. */
interface TreeCtx {
  workspaceId: WorkspaceId;
  activePageId: string | null;
  collapse: CollapsedState;
  order: ChildOrder;
  drag: DragState;
  setDrag: (d: DragState) => void;
  overId: string | null;
  setOverId: (id: string | null) => void;
}

/** The top-most archived page of every branch (does not descend into an archived subtree —
 *  unarchiving the top node restores the whole branch), newest-archived first. An archived page
 *  is frozen, so its `updatedAt` is the moment it was archived — exactly what we sort by. */
function collectArchived(nodes: readonly ITreeNode[]): ITreeNode[] {
  const out: ITreeNode[] = [];
  const walk = (ns: readonly ITreeNode[]): void => {
    for (const n of ns) {
      if (n.archived === true) out.push(n);
      else walk(n.children);
    }
  };
  walk(nodes);
  // ISO timestamps sort lexicographically; newest (largest) first, title as a stable tiebreak.
  out.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.title.localeCompare(b.title));
  return out;
}

/** One level of siblings: applies the user's order + drops archived pages, and owns reordering. */
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
  const visible = ordered.filter((n) => n.archived !== true);
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
  const router = useRouter();
  const id = String(node.id);
  const isActive = id === ctx.activePageId;
  const hasChildren = node.children.length > 0;
  const collapsed = hasChildren && ctx.collapse.isCollapsed(id);
  const isDragging = ctx.drag?.id === id;
  const isOver = ctx.overId === id && ctx.drag !== null && ctx.drag.parentKey === parentKey && ctx.drag.id !== id;
  const href = pageHref(ctx.workspaceId, node.id);

  // The WHOLE row is one click target (no separate caret hit area): a row that isn't the
  // current page just SELECTS it; a row that already is toggles its expand/collapse.
  const activate = (): void => {
    if (!isActive) router.push(href);
    else if (hasChildren) ctx.collapse.toggle(id);
  };

  return (
    <li>
      <div
        className={`tree-row${isActive ? " active" : ""}${isDragging ? " dragging" : ""}${isOver ? " drag-over" : ""}`}
        role="link"
        tabIndex={0}
        aria-current={isActive ? "page" : undefined}
        aria-expanded={hasChildren ? !collapsed : undefined}
        title={node.type !== undefined ? `${node.type} · ${node.status ?? ""}` : undefined}
        draggable
        onClick={(e) => {
          // Modified / middle clicks open in a new tab, mirroring an anchor.
          if (e.metaKey || e.ctrlKey || e.shiftKey) {
            window.open(href, "_blank", "noopener");
            return;
          }
          activate();
        }}
        onAuxClick={(e) => {
          if (e.button === 1) {
            e.preventDefault();
            window.open(href, "_blank", "noopener");
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activate();
          }
        }}
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
        <span className="tree-caret" aria-hidden="true">
          {hasChildren && (
            <span className={`caret${collapsed ? "" : " open"}`}>▶</span>
          )}
        </span>
        <span className="tree-link">
          <span className="tree-title">{node.displayTitle ?? node.title}</span>
          <StatusChip node={node} />
        </span>
      </div>
      {hasChildren && !collapsed && <TreeChildren parentKey={id} siblings={node.children} ctx={ctx} />}
    </li>
  );
}

/** Collapsible "Archived (N)" list at the foot of the sidebar — the place to see archived pages
 *  and restore them. Hidden entirely when nothing is archived. */
function ArchivedSection({
  tree,
  workspaceId,
  expanded,
  onToggle,
}: {
  tree: ITreeNode;
  workspaceId: WorkspaceId;
  expanded: boolean;
  onToggle: () => void;
}): React.JSX.Element | null {
  const structural = useStructuralMutator(workspaceId);
  const archived = collectArchived(tree.children);
  if (archived.length === 0) return null;

  return (
    <div className="tree-archived">
      <button type="button" className="tree-archived-head" aria-expanded={expanded} onClick={onToggle}>
        <span className={`caret${expanded ? " open" : ""}`} aria-hidden="true">
          ▶
        </span>
        Archived <span className="muted">({archived.length})</span>
      </button>
      {expanded && (
        <ul className="tree-archived-list">
          {archived.map((n) => (
            <li key={n.id} className="tree-archived-item">
              <Link href={pageHref(workspaceId, n.id)} className="tree-link">
                <span className="tree-title">{n.displayTitle ?? n.title}</span>
                <StatusChip node={n} />
              </Link>
              <button
                type="button"
                className="tree-archive"
                aria-label="Unarchive page"
                title="Unarchive — restore to the sidebar"
                disabled={structural.pending}
                onClick={() => void structural.unarchive(n.id as PageId)}
              >
                unarchive
              </button>
            </li>
          ))}
        </ul>
      )}
      {structural.error !== null && (
        <p className="tree-error" role="alert">
          {structural.error}
        </p>
      )}
    </div>
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
  const [drag, setDrag] = useState<DragState>(null);
  const [overId, setOverId] = useState<string | null>(null);

  if (tree === null) return <p className="muted">Loading tree…</p>;
  if (tree.children.length === 0) return <p className="muted">No pages in this workspace yet.</p>;

  const ctx: TreeCtx = { workspaceId, activePageId, collapse, order, drag, setDrag, overId, setOverId };

  return (
    <div className="tree-wrap">
      <TreeChildren parentKey={String(tree.id)} siblings={tree.children} ctx={ctx} top />
      <ArchivedSection
        tree={tree}
        workspaceId={workspaceId}
        expanded={archivedView.show}
        onToggle={archivedView.toggle}
      />
    </div>
  );
}
