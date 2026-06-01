/**
 * Snapshot machinery (DESIGN §8.3; BUILD_NOTES §8).
 *
 * A snapshot is a cache, never the source of truth: it records `{ version, cursor,
 * state, fingerprint }` so reopening a workspace can fold only the tail past the
 * snapshot point instead of replaying the whole stream. The page-type version
 * `fingerprint` invalidates a snapshot across a schema bump (DESIGN §8.5) — a
 * mismatch is treated as "no snapshot" and the workspace re-folds from zero.
 *
 * `IWorkspaceState` holds `Map`s (`pages`, `children`); the on-stream
 * `SerializedWorkspaceState` flattens those to arrays for JSON. Both directions
 * are deterministic and total, and use no host clock / entropy: time and ids
 * arrive elsewhere via injected services.
 */
import type { IPageNode, IWorkspaceState, PageId, RootId, WorkspaceId } from "../api";
import type { IEventLog, SerializedSnapshot, SerializedWorkspaceState } from "./types";

/**
 * Flatten an {@link IWorkspaceState} (with `Map`s) into a JSON-friendly
 * {@link SerializedWorkspaceState} (with arrays). Insertion order is preserved so
 * round-trips and re-serialization are byte-stable. The page nodes themselves are
 * referenced as-is (they are already plain JSON-able objects).
 */
export function serializeState(state: IWorkspaceState): SerializedWorkspaceState {
  const pages: IPageNode[] = [];
  for (const node of state.pages.values()) pages.push(node);

  const children: [parent: string, childIds: string[]][] = [];
  for (const [parent, childIds] of state.children) {
    children.push([parent as string, [...(childIds as readonly string[])]]);
  }

  const links = state.links.map((l) => ({ from: l.from as string, to: l.to as string, role: l.role }));

  return {
    id: state.id,
    name: state.name,
    status: state.status,
    version: state.version,
    pages,
    children,
    links,
  };
}

/**
 * Rebuild an {@link IWorkspaceState} (with `Map`s) from its serialized form. The
 * inverse of {@link serializeState}; preserves the array ordering as `Map`
 * insertion order so a serialize→deserialize round-trip is identity.
 */
export function deserializeState(ser: SerializedWorkspaceState): IWorkspaceState {
  const pages = new Map<PageId, IPageNode>();
  for (const node of ser.pages) pages.set(node.id, node);

  const children = new Map<PageId | RootId, PageId[]>();
  for (const [parent, childIds] of ser.children) {
    children.set(parent as PageId | RootId, [...childIds] as PageId[]);
  }

  const links = ser.links.map((l) => ({ from: l.from as PageId, to: l.to as PageId, role: l.role }));

  return {
    id: ser.id,
    name: ser.name,
    status: ser.status,
    version: ser.version,
    pages,
    children,
    links,
  };
}

/**
 * Persist a snapshot of `state` to the workspace's sibling snapshot stream. The
 * snapshot records the workspace `version` it covers, the coarse DS resume
 * `cursor` at that point, and the registry `fingerprint` that produced it.
 * Best-effort by contract: callers ignore failures (the stream remains the
 * source of truth). No host clock usage.
 */
export async function writeSnapshot(
  eventLog: IEventLog,
  ws: WorkspaceId,
  state: IWorkspaceState,
  cursor: string,
  fingerprint: string,
): Promise<void> {
  const snapshot: SerializedSnapshot = {
    version: state.version,
    cursor,
    state: serializeState(state),
    fingerprint,
  };
  await eventLog.appendSnapshot(ws, snapshot);
}

/**
 * Load the latest snapshot for `ws`, rehydrated into live `Map`-backed state.
 *
 * Returns `undefined` when there is no snapshot OR when the stored `fingerprint`
 * does not match `fingerprint` (a schema bump invalidated it, DESIGN §8.5) — in
 * both cases the caller folds from zero. On a hit, returns the deserialized
 * `state`, the resume `cursor`, and the `version` the snapshot covers (events with
 * `version ≤` this are skipped when folding the tail).
 */
export async function loadSnapshot(
  eventLog: IEventLog,
  ws: WorkspaceId,
  fingerprint: string,
): Promise<{ state: IWorkspaceState; cursor: string; version: number } | undefined> {
  const snapshot = await eventLog.readLatestSnapshot(ws);
  if (snapshot === undefined) return undefined;
  if (snapshot.fingerprint !== fingerprint) return undefined;
  return {
    state: deserializeState(snapshot.state),
    cursor: snapshot.cursor,
    version: snapshot.version,
  };
}
