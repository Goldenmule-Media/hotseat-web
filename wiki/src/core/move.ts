/**
 * Cross-workspace page moves, one workspace at a time. A move spans two streams, so it is a
 * saga of single-stream commits, each idempotent: the source freezes the pages
 * (`PageMoveStarted`), the target imports them (`PagesImported`), and the source finishes
 * (`PageMoveCompleted`, which leaves forwards) or gives up (`PageMoveAborted`). The
 * `wiki/admin` `movePages` saga drives these steps; the journal on the source stream is
 * enough to resume a move that stopped partway.
 */
import type { IPageMoveRequest, IPendingMove, IWorkspaceState, PageId, WorkspaceId } from "../api";
import { InvariantViolationError, PageMovedError, PageMoveInProgressError, PageNotFoundError } from "./errors";
import type { StructureHandler } from "./structure";

/** The pending move a page belongs to, if any. */
export function pendingMoveOf(state: IWorkspaceState, pageId: PageId): IPendingMove | undefined {
  for (const move of state.pendingMoves.values()) {
    if (move.pageIds.includes(pageId)) return move;
  }
  return undefined;
}

/** Throw when any of `pageIds` is frozen by a pending move. */
export function assertNotMoving(state: IWorkspaceState, pageIds: readonly (PageId | null | undefined)[]): void {
  if (state.pendingMoves.size === 0) return;
  for (const id of pageIds) {
    if (id === null || id === undefined) continue;
    const move = pendingMoveOf(state, id);
    if (move !== undefined) throw new PageMoveInProgressError(id, move.moveId);
  }
}

/** The page ids a structural command's args touch (the ones a pending move must not change). */
export function structuralTargets(handler: string, args: unknown): PageId[] {
  const a = (args ?? {}) as Record<string, unknown>;
  const ids: unknown[] =
    handler === "moveItem" ? [a["from"], a["to"]] : [a["pageId"], a["parentId"], a["newParentId"], a["from"]];
  return ids.filter((v): v is PageId => typeof v === "string");
}

/** Resolve a page, naming where it went if it moved away. */
export function requireLivePage(state: IWorkspaceState, pageId: PageId): void {
  if (state.pages.has(pageId)) return;
  const forward = state.forwards.get(pageId);
  if (forward !== undefined) throw new PageMovedError(pageId, forward.workspace);
  throw new PageNotFoundError(pageId);
}

/** Every page in the given subtrees, in tree order (archived pages included). */
export function subtreePageIds(state: IWorkspaceState, roots: readonly PageId[]): PageId[] {
  const out: PageId[] = [];
  const visit = (id: PageId): void => {
    out.push(id);
    for (const child of state.children.get(id) ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  return out;
}

/** Validate a move request against the source and resolve the pages it moves. */
export function planMove(state: IWorkspaceState, request: IPageMoveRequest): { roots: PageId[]; pageIds: PageId[] } {
  const to = request.to as string;
  if (typeof to !== "string" || to.length === 0) throw new InvariantViolationError("A move needs a target workspace.");
  if (to === state.id) throw new InvariantViolationError("A move's target must be another workspace; use reparent instead.");
  const asked = [...new Set(request.roots)];
  if (asked.length === 0) throw new InvariantViolationError("A move needs at least one page.");
  for (const id of asked) requireLivePage(state, id);
  // A page inside another requested page's subtree already moves with it.
  const roots = asked.filter((id) => !hasAncestorIn(state, id, asked));
  for (const id of roots) {
    if (state.pages.get(id)!.pinned === true) {
      throw new InvariantViolationError(`Page "${id}" is pinned to its owner; move the owner instead.`);
    }
  }
  const pageIds = subtreePageIds(state, roots);
  assertNotMoving(state, pageIds);
  return { roots, pageIds };
}

function hasAncestorIn(state: IWorkspaceState, id: PageId, candidates: readonly PageId[]): boolean {
  let cur = state.pages.get(id)?.parentId ?? null;
  while (cur !== null) {
    if (candidates.includes(cur)) return true;
    cur = state.pages.get(cur)?.parentId ?? null;
  }
  return false;
}

/** Freeze the pages of a move out of this workspace. */
export const beginPageMove: StructureHandler = (state, args, services) => {
  const request = args as IPageMoveRequest;
  const { roots, pageIds } = planMove(state, request);
  const move: IPendingMove = {
    moveId: `move:${services.newId()}`,
    to: request.to as WorkspaceId,
    toParentId: request.toParentId ?? null,
    ...(request.position !== undefined ? { position: request.position } : {}),
    roots,
    pageIds,
  };
  return { events: [{ type: "PageMoveStarted", payload: move }], result: move };
};

/** Finish a move out. A move that already finished is a no-op. */
export const completePageMove: StructureHandler = (state, args) => {
  const { moveId } = args as { moveId: string };
  const move = state.pendingMoves.get(moveId);
  if (move === undefined) {
    if (finished(state, moveId)) return { events: [] };
    throw new InvariantViolationError(`No pending move "${moveId}".`);
  }
  // `to` and `pageIds` repeat the journal so a consumer reading one commit sees what left.
  return { events: [{ type: "PageMoveCompleted", payload: { moveId, to: move.to, pageIds: move.pageIds } }] };
};

/** Unfreeze a move the target refused. A move no longer pending is a no-op. */
export const abortPageMove: StructureHandler = (state, args) => {
  const { moveId, reason } = args as { moveId: string; reason?: string };
  if (!state.pendingMoves.has(moveId)) {
    if (finished(state, moveId)) throw new InvariantViolationError(`Move "${moveId}" already completed.`);
    return { events: [] };
  }
  return { events: [{ type: "PageMoveAborted", payload: { moveId, reason: reason ?? "" } }] };
};

function finished(state: IWorkspaceState, moveId: string): boolean {
  for (const f of state.forwards.values()) if (f.moveId === moveId) return true;
  return false;
}

export const MOVE_HANDLERS: Readonly<Record<string, StructureHandler>> = {
  beginPageMove,
  completePageMove,
  abortPageMove,
};

/** Move steps that must still run on an archived workspace (so a move can always finish). */
export const MOVE_FINISHERS: ReadonlySet<string> = new Set(["completePageMove", "abortPageMove"]);
