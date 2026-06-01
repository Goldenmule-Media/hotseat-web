/**
 * Structural command handlers + invariants (DESIGN §6.2, BUILD_NOTES §5).
 *
 * Each handler is a PURE function over the current workspace `state`, the parsed
 * `args`, the injected `services` (clock + id generation), and the `registry`.
 * It returns the lightweight `DomainEvent`s the command bus will envelope into a
 * single atomic commit, plus an optional `result`. No I/O, no host clock/RNG —
 * time and ids arrive exclusively via `services.now()` / `services.newId()`.
 *
 * The bus is responsible for the "workspace active?" check before invoking a
 * handler; these handlers enforce the structural invariants themselves and
 * additionally reject mutating an archived target page (reads are unaffected).
 */
import {
  ROOT,
  type DomainEvent,
  type IPageNode,
  type IItemRecord,
  type IWorkspaceState,
  type PageId,
  type RootId,
} from "../api";
import {
  CycleError,
  DuplicateTitleError,
  InvariantViolationError,
  ItemNotFoundError,
  LinkTargetNotFoundError,
  PageNotFoundError,
  ParentNotFoundError,
} from "./errors";
import type { Registry } from "./registry";
import type { Services } from "./types";

// ────────────────────────────────────────────────────────────────────────────
// Local types
// ────────────────────────────────────────────────────────────────────────────

/** The parent key used in `state.children`: a page id or the ROOT sentinel. */
type ParentKey = PageId | RootId;

/** A pure structural command handler. */
export type StructureHandler = (
  state: IWorkspaceState,
  args: any,
  services: Services,
  registry: Registry,
) => { events: DomainEvent[]; result?: unknown };

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Normalize a nullable parent id to the children-map key. */
function parentKey(parentId: PageId | null | undefined): ParentKey {
  return parentId == null ? ROOT : parentId;
}

/** Ordered child ids under `parentId` (or ROOT), as a fresh array. */
function childrenOf(state: IWorkspaceState, parentId: PageId | null | undefined): PageId[] {
  return [...(state.children.get(parentKey(parentId)) ?? [])];
}

/** Resolve a page node or throw {@link PageNotFoundError}. */
function requirePage(state: IWorkspaceState, pageId: PageId): IPageNode {
  const node = state.pages.get(pageId);
  if (node === undefined) throw new PageNotFoundError(pageId);
  return node;
}

/** Reject mutating an archived target page. */
function assertPageActive(node: IPageNode): void {
  if (node.status === "archived") {
    throw new InvariantViolationError(`Page "${node.id}" is archived; structural mutation is blocked.`);
  }
}

/**
 * Reject a duplicate title among the siblings under `parentId`, ignoring the
 * page identified by `excludeId` (used by reparent/setPageTitle on the page
 * itself). Comparison is exact-match on the denormalized node title.
 */
function assertUniqueSiblingTitle(
  state: IWorkspaceState,
  parentId: PageId | null,
  title: string,
  excludeId?: PageId,
): void {
  for (const childId of childrenOf(state, parentId)) {
    if (childId === excludeId) continue;
    const child = state.pages.get(childId);
    if (child !== undefined && child.title === title) {
      throw new DuplicateTitleError(parentId, title);
    }
  }
}

/** Is `candidate` `pageId` itself or a descendant of `pageId` in the tree? */
function isSelfOrDescendant(state: IWorkspaceState, pageId: PageId, candidate: PageId): boolean {
  if (candidate === pageId) return true;
  // BFS/DFS over the subtree rooted at pageId.
  const stack: PageId[] = childrenOf(state, pageId);
  const seen = new Set<PageId>();
  while (stack.length > 0) {
    const cur = stack.pop() as PageId;
    if (cur === candidate) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const grand of childrenOf(state, cur)) stack.push(grand);
  }
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// createPage
// ────────────────────────────────────────────────────────────────────────────

/**
 * Create a page (+ its required children, recursively, as pinned children) in
 * ONE atomic commit. Generates `pageId = `${type}:${newId()}``. Result is the
 * top-level page's id.
 */
export const createPage: StructureHandler = (state, args, services, registry) => {
  const { type, title, parentId } = args as {
    type: string;
    title: string;
    parentId: PageId | null;
  };
  const normalizedParent: PageId | null = parentId ?? null;

  // The registry must know the type (also throws UnknownPageTypeError on miss).
  if (!registry.has(type)) {
    throw new InvariantViolationError(`Unknown page type "${type}".`);
  }

  // Parent (when present) must exist and not be archived.
  if (normalizedParent !== null) {
    const parent = requirePage(state, normalizedParent);
    if (parent.status === "archived") {
      throw new ParentNotFoundError(normalizedParent);
    }
  }

  // Unique sibling title under the parent.
  assertUniqueSiblingTitle(state, normalizedParent, title);

  const events: DomainEvent[] = [];

  /**
   * Emit a `PageCreated` for `pageType` under `parent`, then recurse into its
   * required children (pinned). Returns the created page id.
   */
  const emitPage = (
    pageType: string,
    pageTitle: string,
    parent: PageId | null,
    pinned: boolean,
  ): PageId => {
    // Resolve the def (throws UnknownPageTypeError on an unregistered required child).
    const def = registry.page(pageType);
    const id = `${pageType}:${services.newId()}` as PageId;

    events.push({
      type: "PageCreated",
      pageId: id,
      payload: {
        type: pageType,
        parentId: parent,
        title: pageTitle,
        ...(pinned ? { pinned: true } : {}),
      },
    });

    // Required children are created atomically as pinned children, recursively.
    for (const childType of def.requiredChildren ?? []) {
      emitPage(childType, childType, id, true);
    }
    return id;
  };

  const topId = emitPage(type, title, normalizedParent, false);
  return { events, result: topId };
};

// ────────────────────────────────────────────────────────────────────────────
// reparent
// ────────────────────────────────────────────────────────────────────────────

/**
 * Move `pageId` under `newParentId` (or ROOT). Rejects cycles, missing parents,
 * and moving a pinned page out of its current owner. Emits `PageReparented`
 * plus a `ChildrenReordered` (to insert at `position`) when needed.
 */
export const reparent: StructureHandler = (state, args) => {
  const { pageId, newParentId, position } = args as {
    pageId: PageId;
    newParentId: PageId | null;
    position?: number;
  };
  const newParent: PageId | null = newParentId ?? null;

  const node = requirePage(state, pageId);
  assertPageActive(node);

  // Pinned pages cannot be reparented out of their owner.
  if (node.pinned === true && node.parentId !== newParent) {
    throw new InvariantViolationError(`Page "${pageId}" is pinned and cannot be reparented out of its owner.`);
  }

  // New parent (when present) must exist and not be archived.
  if (newParent !== null) {
    const parent = state.pages.get(newParent);
    if (parent === undefined || parent.status === "archived") {
      throw new ParentNotFoundError(newParent);
    }
    // Cycle: newParent must not be the page itself or a descendant of it.
    if (isSelfOrDescendant(state, pageId, newParent)) {
      throw new CycleError(pageId, newParent);
    }
  }

  const oldParent: PageId | null = node.parentId;

  const events: DomainEvent[] = [
    {
      type: "PageReparented",
      pageId,
      payload: {
        pageId,
        oldParentId: oldParent,
        newParentId: newParent,
        ...(position !== undefined ? { position } : {}),
      },
    },
  ];

  // If a position was requested, emit the resulting sibling order explicitly so
  // the reducer doesn't have to guess. Compute the order after the move.
  if (position !== undefined) {
    const siblings = childrenOf(state, newParent).filter((id) => id !== pageId);
    const clamped = Math.max(0, Math.min(position, siblings.length));
    siblings.splice(clamped, 0, pageId);
    events.push({
      type: "ChildrenReordered",
      payload: { parentId: newParent, orderedChildIds: siblings },
    });
  }

  return { events };
};

// ────────────────────────────────────────────────────────────────────────────
// reorder
// ────────────────────────────────────────────────────────────────────────────

/**
 * Reorder the children under `parentId` (or ROOT). The supplied ids must be a
 * permutation of the current children (same membership, no dupes, no extras).
 */
export const reorder: StructureHandler = (state, args) => {
  const { parentId, orderedChildIds } = args as {
    parentId: PageId | null;
    orderedChildIds: readonly PageId[];
  };
  const normalizedParent: PageId | null = parentId ?? null;

  const current = childrenOf(state, normalizedParent);
  const next = [...orderedChildIds];

  const dupeCheck = new Set<PageId>();
  for (const id of next) {
    if (dupeCheck.has(id)) {
      throw new InvariantViolationError(`reorder list contains a duplicate child "${id}".`);
    }
    dupeCheck.add(id);
  }

  const currentSet = new Set(current);
  if (next.length !== current.length || next.some((id) => !currentSet.has(id))) {
    throw new InvariantViolationError(
      `reorder must be a permutation of the current children under "${normalizedParent ?? ROOT}".`,
    );
  }

  return {
    events: [
      {
        type: "ChildrenReordered",
        payload: { parentId: normalizedParent, orderedChildIds: next },
      },
    ],
  };
};

// ────────────────────────────────────────────────────────────────────────────
// setPageTitle
// ────────────────────────────────────────────────────────────────────────────

/** Rename a page; the new title must be unique among its siblings. */
export const setPageTitle: StructureHandler = (state, args) => {
  const { pageId, title } = args as { pageId: PageId; title: string };

  const node = requirePage(state, pageId);
  assertPageActive(node);
  assertUniqueSiblingTitle(state, node.parentId, title, pageId);

  return {
    events: [{ type: "PageTitleSet", pageId, payload: { pageId, title } }],
  };
};

// ────────────────────────────────────────────────────────────────────────────
// archivePage
// ────────────────────────────────────────────────────────────────────────────

/** Archive a page. Pinned pages cannot be archived alone. */
export const archivePage: StructureHandler = (state, args) => {
  const { pageId } = args as { pageId: PageId };

  const node = requirePage(state, pageId);
  if (node.pinned === true) {
    throw new InvariantViolationError(`Page "${pageId}" is pinned and cannot be archived independently.`);
  }

  return {
    events: [{ type: "PageArchived", pageId, payload: { pageId } }],
  };
};

// ────────────────────────────────────────────────────────────────────────────
// link / unlink
// ────────────────────────────────────────────────────────────────────────────

/** Add a graph edge `from -[role]-> to`. Both endpoints must exist. */
export const link: StructureHandler = (state, args) => {
  const { from, to, role } = args as { from: PageId; to: PageId; role: string };

  if (!state.pages.has(from)) throw new LinkTargetNotFoundError(from);
  if (!state.pages.has(to)) throw new LinkTargetNotFoundError(to);

  return {
    events: [{ type: "LinkAdded", payload: { from, to, role } }],
  };
};

/** Remove a graph edge `from -[role]-> to`. Both endpoints must exist. */
export const unlink: StructureHandler = (state, args) => {
  const { from, to, role } = args as { from: PageId; to: PageId; role: string };

  if (!state.pages.has(from)) throw new LinkTargetNotFoundError(from);
  if (!state.pages.has(to)) throw new LinkTargetNotFoundError(to);

  return {
    events: [{ type: "LinkRemoved", payload: { from, to, role } }],
  };
};

// ────────────────────────────────────────────────────────────────────────────
// moveItem
// ────────────────────────────────────────────────────────────────────────────

/**
 * Move an item (by id) of `itemType` from one page to another, atomically. The
 * item must exist on `from` (else {@link ItemNotFoundError}). Emits a generic
 * `ItemRemoved{pageId:from,itemType,item}` + `ItemAdded{pageId:to,itemType,item}`
 * in ONE batch so the move is all-or-nothing (BUILD_NOTES §5).
 */
export const moveItem: StructureHandler = (state, args) => {
  const { from, to, itemType, itemId } = args as {
    from: PageId;
    to: PageId;
    itemType: string;
    itemId: string;
  };

  const fromNode = requirePage(state, from);
  const toNode = requirePage(state, to);
  assertPageActive(fromNode);
  assertPageActive(toNode);

  const bucket: IItemRecord[] = fromNode.items[itemType] ?? [];
  const item = bucket.find((i) => i.id === itemId);
  if (item === undefined) throw new ItemNotFoundError(itemType, itemId);

  // Carry the full item record across so status/typed fields are preserved.
  const moved: IItemRecord = { ...item };

  return {
    events: [
      { type: "ItemRemoved", pageId: from, payload: { itemType, item: moved } },
      { type: "ItemAdded", pageId: to, payload: { itemType, item: moved } },
    ],
  };
};

// ────────────────────────────────────────────────────────────────────────────
// archiveWorkspace
// ────────────────────────────────────────────────────────────────────────────

/** Archive the whole workspace. */
export const archiveWorkspace: StructureHandler = () => {
  return { events: [{ type: "WorkspaceArchived", payload: {} }] };
};

// ────────────────────────────────────────────────────────────────────────────
// Handler map (keyed by command name)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Structural command handlers, keyed by the public command name. The command
 * bus dispatches `structural({ handlerName, args })` through this table.
 * Aliases: `archive`/`unlink` map to the workspace/link handlers respectively.
 */
export const STRUCTURAL_HANDLERS: Readonly<Record<string, StructureHandler>> = {
  createPage,
  reparent,
  reorder,
  setPageTitle,
  archivePage,
  link,
  unlink,
  moveItem,
  archiveWorkspace,
  // The IWorkspaceHandle exposes `archive()` for workspace archival.
  archive: archiveWorkspace,
};
