/**
 * The cross-workspace move saga. Each step is one idempotent commit on one stream, and the
 * source's journal says how far a move got, so a move that stopped partway (a crash, a
 * dropped connection) finishes by running it again:
 *
 *   1. source `beginPageMove` freezes the pages;
 *   2. the host copies the attachments they reference;
 *   3. target `importPages` lands them (a no-op if it already did);
 *   4. source `completePageMove` drops them and leaves forwards.
 *
 * A target that refuses the import (a rejection, not an outage) aborts the move, which
 * unfreezes the source.
 */
import type {
  ConsistencyToken,
  IPageMoveExport,
  IPagesImportResult,
  IPendingMove,
  IWorkspaceHandle,
  PageId,
  WorkspaceId,
} from "../api";
import { InvariantViolationError, WikiError } from "./errors";

/** Copy one attachment between workspaces' stores. Throw a {@link WikiError} for a blob that
 *  can't be copied at all (the move then aborts); any other error leaves it resumable. */
export type BlobCopier = (blobId: string, from: WorkspaceId, to: WorkspaceId) => Promise<void>;

export interface MovePagesOptions {
  /** Open a workspace handle (e.g. `(id) => wiki.openWorkspace(id)`). */
  readonly open: (id: WorkspaceId) => Promise<IWorkspaceHandle>;
  readonly from: WorkspaceId;
  readonly to: WorkspaceId;
  /** The subtree roots to move; each moves with all its descendants. */
  readonly pageIds: readonly PageId[];
  /** Where the roots land in the target (`null` = top level). */
  readonly parentId: PageId | null;
  readonly position?: number;
  /** Required when the moved pages reference attachments. */
  readonly copyBlob?: BlobCopier;
  /** Check both sides and report what would happen, writing nothing. */
  readonly dryRun?: boolean;
}

export interface MovePagesReport {
  readonly dryRun: boolean;
  /** Absent for a dry run. */
  readonly moveId?: string;
  /** `true` when this call finished a move an earlier call had started. */
  readonly resumed: boolean;
  readonly from: WorkspaceId;
  readonly to: WorkspaceId;
  readonly roots: readonly PageId[];
  readonly movedPageIds: readonly PageId[];
  readonly blobs: readonly string[];
  /** Serial numbers the target re-minted, by page. */
  readonly serials: IPagesImportResult["serials"];
  /** Where each moved page now lives. */
  readonly forwards: readonly { readonly pageId: PageId; readonly workspaceId: WorkspaceId }[];
  readonly sourceToken?: ConsistencyToken;
  readonly targetToken?: ConsistencyToken;
}

/** Move subtrees from one workspace to another, or finish such a move already under way. */
export async function movePages(opts: MovePagesOptions): Promise<MovePagesReport> {
  const src = await opts.open(opts.from);
  const dst = await opts.open(opts.to);
  const request = { to: opts.to, roots: opts.pageIds, toParentId: opts.parentId, ...(opts.position !== undefined ? { position: opts.position } : {}) };

  const underway = (await src.pendingMoves()).find((m) => m.to === opts.to && opts.pageIds.every((id) => m.pageIds.includes(id)));
  if (underway !== undefined) {
    if (opts.dryRun === true) return report(opts.from, underway, (await src.exportPageMove(underway.moveId)).blobs, {}, true, true);
    return finish(src, dst, underway, opts.copyBlob, true);
  }

  const preview = await src.exportPageMove(request);
  if (preview.blobs.length > 0 && opts.copyBlob === undefined) {
    throw new InvariantViolationError(`The pages reference ${preview.blobs.length} attachment(s) and no blob copier was given.`);
  }
  const check = await dst.importPages({ ...preview, moveId: "move:dry-run" }, { dryRun: true });
  if (opts.dryRun === true) {
    const plan: IPendingMove = { moveId: "", ...request, roots: preview.pages.filter((p) => p.parentId === null).map((p) => p.id), pageIds: check.value.pageIds };
    return { ...report(opts.from, plan, preview.blobs, check.value.serials, false, true), moveId: undefined };
  }

  const { value: move } = await src.beginPageMove(request);
  return finish(src, dst, move, opts.copyBlob, false);
}

export interface ResumePageMoveOptions {
  readonly open: (id: WorkspaceId) => Promise<IWorkspaceHandle>;
  readonly from: WorkspaceId;
  readonly moveId: string;
  readonly copyBlob?: BlobCopier;
}

/** Finish a move the source journal shows as pending. */
export async function resumePageMove(opts: ResumePageMoveOptions): Promise<MovePagesReport> {
  const src = await opts.open(opts.from);
  const move = (await src.pendingMoves()).find((m) => m.moveId === opts.moveId);
  if (move === undefined) throw new InvariantViolationError(`No pending move "${opts.moveId}" in ${opts.from}.`);
  return finish(src, await opts.open(move.to), move, opts.copyBlob, true);
}

async function finish(
  src: IWorkspaceHandle,
  dst: IWorkspaceHandle,
  move: IPendingMove,
  copyBlob: BlobCopier | undefined,
  resumed: boolean,
): Promise<MovePagesReport> {
  const payload: IPageMoveExport = await src.exportPageMove(move.moveId);
  let imported: IPagesImportResult;
  let targetToken: ConsistencyToken;
  try {
    if (payload.blobs.length > 0 && copyBlob === undefined) {
      throw new InvariantViolationError(`The pages reference ${payload.blobs.length} attachment(s) and no blob copier was given.`);
    }
    for (const blob of payload.blobs) await copyBlob!(blob, src.id, dst.id);
    const committed = await dst.importPages(payload);
    imported = committed.value;
    targetToken = committed.token;
  } catch (e) {
    // A refusal won't change on retry, so unfreeze the source; an outage stays resumable.
    if (e instanceof WikiError) await src.abortPageMove(move.moveId, e.message);
    throw e;
  }
  const { token: sourceToken } = await src.completePageMove(move.moveId);
  return { ...report(src.id, move, payload.blobs, imported.serials, resumed, false), sourceToken, targetToken };
}

function report(
  from: WorkspaceId,
  move: IPendingMove,
  blobs: readonly string[],
  serials: IPagesImportResult["serials"],
  resumed: boolean,
  dryRun: boolean,
): MovePagesReport {
  return {
    dryRun,
    moveId: move.moveId,
    resumed,
    from,
    to: move.to,
    roots: move.roots,
    movedPageIds: move.pageIds,
    blobs,
    serials,
    forwards: move.pageIds.map((pageId) => ({ pageId, workspaceId: move.to })),
  };
}
