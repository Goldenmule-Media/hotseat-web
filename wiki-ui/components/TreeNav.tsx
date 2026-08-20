"use client";

/** Collapsible page-tree sidebar. Renders the engine's `ITreeNode` tree as in-app links — the
 *  primary navigation surface, and the place the tree's SHAPE is edited.
 *
 *  Rows are draggable, and a row is three drop bands (see `lib/tree-drag`): its outer quarters
 *  place the dragged page as a sibling before / after it, its middle half makes it a CHILD of
 *  it. A sibling drop within one parent is a UI-only rearrangement (per-workspace localStorage
 *  — see `useChildOrder`); any drop that changes the parent is a real `reparent` on the stream,
 *  so it reaches every client. Illegal moves — into the page's own subtree, or a pinned page out
 *  of its owner — offer no drop affordance at all rather than failing after the fact.
 *
 *  Archived pages (the durable `archived` flag, engine ADR-011) are kept OUT of the main tree
 *  and surfaced in a collapsible "Archived" section at the foot, from which they can be opened
 *  or unarchived. Archiving itself lives on the page content (see PageView).
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { ITreeNode, PageId, WorkspaceId } from "wiki";
import { pageHref } from "../lib/routes";
import { useChildOrder, type ChildOrder } from "../lib/useChildOrder";
import { useCollapsed, type CollapsedState } from "../lib/useCollapsed";
import { useShowArchived } from "../lib/useShowArchived";
import { useStructuralMutator, type StructuralMutator } from "../lib/live";
import { isDoneNodeStatus, isTerminalNodeStatus } from "../lib/terminal";
import {
  placeAt,
  resolveDrop,
  resolveRootDrop,
  subtreeIds,
  zoneAt,
  type DragSource,
  type DropZone,
  type MoveIntent,
} from "../lib/tree-drag";
import { CreatePageModal } from "./CreatePageModal";

/** How long the pointer must rest on a collapsed row before it opens to let the drag in. */
const HOVER_EXPAND_MS = 600;

/** The status chip next to a sidebar title — visually distinct when the status is terminal
 *  (sealed/final) or one the model calls DONE, so finished pages read differently at a glance. */
function StatusChip({ node }: { node: ITreeNode }): React.JSX.Element | null {
  if (node.status === undefined) return null;
  const terminal = isTerminalNodeStatus(node.type, node.status);
  const done = isDoneNodeStatus(node.type, node.status);
  return (
    <span className={`tree-status${terminal ? " tree-status-terminal" : ""}${done ? " tree-status-done" : ""}`}>
      {done && <span aria-hidden="true">✓ </span>}
      {node.status}
    </span>
  );
}

/** The row the pointer is currently over, and which of its bands. */
type OverState = { id: string; zone: DropZone } | null;

/** Everything the recursive tree rows share, bundled to avoid prop drilling. */
interface TreeCtx {
  workspaceId: WorkspaceId;
  /** The ROOT sentinel's id — the parent key of a top-level page. */
  rootKey: string;
  activePageId: string | null;
  /** Open the new-page modal with this row preselected as the parent. */
  createUnder: (pageId: PageId) => void;
  collapse: CollapsedState;
  order: ChildOrder;
  drag: DragSource | null;
  setDrag: (d: DragSource | null) => void;
  over: OverState;
  setOver: (o: OverState) => void;
  /** Carry out a resolved drop. `destIds` is the destination parent's current child order. */
  commit: (drag: DragSource, intent: MoveIntent, destIds: readonly string[]) => void;
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

/** One level of siblings: applies the user's order + drops archived pages. */
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

  // Positions are computed over the FULL ordered list (archived siblings included) so their
  // stored slots survive a rearrangement of the visible ones.
  const orderedIds = ordered.map((n) => String(n.id));

  return (
    <ul className={top ? "tree" : "tree-children"}>
      {visible.map((child) => (
        <TreeItem key={child.id} node={child} parentKey={parentKey} siblingIds={orderedIds} ctx={ctx} />
      ))}
    </ul>
  );
}

function TreeItem({
  node,
  parentKey,
  siblingIds,
  ctx,
}: {
  node: ITreeNode;
  parentKey: string;
  siblingIds: readonly string[];
  ctx: TreeCtx;
}): React.JSX.Element {
  const router = useRouter();
  const id = String(node.id);
  const isActive = id === ctx.activePageId;
  const hasChildren = node.children.length > 0;
  const collapsed = hasChildren && ctx.collapse.isCollapsed(id);
  const isDragging = ctx.drag?.id === id;
  const href = pageHref(ctx.workspaceId, node.id);

  // The move the pointer's current band would make — `null` both when this row isn't the drop
  // target and when the engine would refuse the move, so it drives the affordance directly.
  const zone = ctx.over?.id === id ? ctx.over.zone : null;
  const intent =
    ctx.drag !== null && zone !== null ? resolveDrop(ctx.drag, { id, parentKey }, zone) : null;

  // Resting on a collapsed row opens it, so a drag can reach pages nested inside.
  const hoveringInside = intent !== null && zone === "inside" && collapsed;
  useEffect(() => {
    if (!hoveringInside) return;
    const t = setTimeout(() => ctx.collapse.expand(id), HOVER_EXPAND_MS);
    return () => clearTimeout(t);
  }, [hoveringInside, id, ctx.collapse]);

  // The WHOLE row is one click target (no separate caret hit area): a row that isn't the
  // current page just SELECTS it; a row that already is toggles its expand/collapse.
  const activate = (): void => {
    if (!isActive) router.push(href);
    else if (hasChildren) ctx.collapse.toggle(id);
  };

  return (
    <li>
      <div
        className={`tree-row${isActive ? " active" : ""}${isDragging ? " dragging" : ""}${
          intent !== null ? ` drop-${zone}` : ""
        }`}
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
          ctx.setDrag({ id, parentKey, pinned: node.pinned === true, subtree: subtreeIds(node) });
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", id); // required for Firefox to start a drag
        }}
        onDragEnd={() => {
          ctx.setDrag(null);
          ctx.setOver(null);
        }}
        onDragOver={(e) => {
          if (ctx.drag === null) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const next = zoneAt(e.clientY - rect.top, rect.height);
          if (resolveDrop(ctx.drag, { id, parentKey }, next) === null) {
            e.dataTransfer.dropEffect = "none";
            if (ctx.over?.id === id) ctx.setOver(null);
            return;
          }
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (ctx.over?.id !== id || ctx.over.zone !== next) ctx.setOver({ id, zone: next });
        }}
        onDragLeave={() => {
          if (ctx.over?.id === id) ctx.setOver(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          // A drop INTO this row lands among its own children; a sibling drop, among these.
          if (ctx.drag !== null && intent !== null) {
            const destIds =
              zone === "inside"
                ? ctx.order.applyOrder(id, node.children).map((n) => String(n.id))
                : siblingIds;
            ctx.commit(ctx.drag, intent, destIds);
          }
          ctx.setDrag(null);
          ctx.setOver(null);
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
        {/* The whole row is one click target, so this action must not bubble into it. */}
        <button
          type="button"
          className="tree-add"
          title="New page under this one"
          aria-label={`New page under ${node.title}`}
          draggable={false}
          onClick={(e) => {
            e.stopPropagation();
            ctx.createUnder(node.id as PageId);
          }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          +
        </button>
      </div>
      {hasChildren && !collapsed && <TreeChildren parentKey={id} siblings={node.children} ctx={ctx} />}
    </li>
  );
}

/** Drop strip shown only mid-drag: the one target that means "out of every parent". */
function RootDropStrip({ ctx, rootIds }: { ctx: TreeCtx; rootIds: readonly string[] }): React.JSX.Element | null {
  const [over, setOver] = useState(false);
  if (ctx.drag === null) return null;
  const intent = resolveRootDrop(ctx.drag, ctx.rootKey);
  if (intent === null) return null;

  return (
    <div
      className={`tree-root-drop${over ? " drop-inside" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!over) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (ctx.drag !== null) ctx.commit(ctx.drag, intent, rootIds);
        ctx.setDrag(null);
        ctx.setOver(null);
      }}
    >
      Move to top level
    </div>
  );
}

/** Collapsible "Archived (N)" list at the foot of the sidebar — the place to see archived pages
 *  and restore them. Hidden entirely when nothing is archived. */
function ArchivedSection({
  tree,
  workspaceId,
  structural,
  expanded,
  onToggle,
}: {
  tree: ITreeNode;
  workspaceId: WorkspaceId;
  structural: StructuralMutator;
  expanded: boolean;
  onToggle: () => void;
}): React.JSX.Element | null {
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
  const structural = useStructuralMutator(workspaceId);
  const [drag, setDrag] = useState<DragSource | null>(null);
  const [over, setOver] = useState<OverState>(null);
  // The row whose `+` was clicked — the new page's preselected parent.
  const [createParent, setCreateParent] = useState<PageId | null>(null);

  if (tree === null) return <p className="muted">Loading tree…</p>;
  if (tree.children.length === 0) {
    return <p className="muted">No pages yet — use + next to the workspace name to create one.</p>;
  }

  const rootKey = String(tree.id);
  const rootIds = order.applyOrder(rootKey, tree.children).map((n) => String(n.id));

  const commit = (d: DragSource, intent: MoveIntent, destIds: readonly string[]): void => {
    const next = placeAt(destIds, d.id, intent.anchor);
    // Same parent: a rearrangement of this browser's view, never a write to the stream.
    if (intent.parentKey === d.parentKey) {
      order.setOrder(intent.parentKey, next);
      return;
    }
    // Different parent: a real move. The engine positions the page among its new siblings —
    // but a destination this browser has already rearranged would override that, so record
    // the dropped position locally too.
    if (order.hasOrder(intent.parentKey)) order.setOrder(intent.parentKey, next);
    collapse.expand(intent.parentKey);
    void structural.reparent(
      d.id as PageId,
      intent.parentKey === rootKey ? null : (intent.parentKey as PageId),
      next.indexOf(d.id),
    );
  };

  const ctx: TreeCtx = {
    workspaceId,
    rootKey,
    activePageId,
    collapse,
    order,
    drag,
    setDrag,
    over,
    setOver,
    commit,
    createUnder: setCreateParent,
  };

  return (
    <div className="tree-wrap">
      <TreeChildren parentKey={rootKey} siblings={tree.children} ctx={ctx} top />
      <RootDropStrip ctx={ctx} rootIds={rootIds} />
      <ArchivedSection
        tree={tree}
        workspaceId={workspaceId}
        structural={structural}
        expanded={archivedView.show}
        onToggle={archivedView.toggle}
      />
      {structural.error !== null && (
        <p className="tree-error" role="alert">
          {structural.error}
        </p>
      )}
      {createParent !== null && (
        <CreatePageModal
          workspaceId={workspaceId}
          initialParentId={createParent}
          onClose={() => setCreateParent(null)}
        />
      )}
    </div>
  );
}
