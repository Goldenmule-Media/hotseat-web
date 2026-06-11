/**
 * INTERNAL types (never re-exported raw). The persistence contract, projection
 * cache, snapshot/catalog serialization shapes, and the event-log interface.
 *
 * Persistence model (verified empirically against @durable-streams 0.2.6/0.3.5):
 * the real client does NOT split a posted JSON array into
 * per-element messages, and `Stream-Seq` enforces strict-greater optimistic
 * concurrency. Therefore each COMMAND's events are stored as ONE message holding
 * a JSON array (`IEventEnvelope[]`), appended with `seq = pad(expectedVersion)`.
 * Reads flatten the array-messages back into a flat event sequence.
 */
import type {
  IEventEnvelope,
  IPageNode,
  IWorkspaceState,
  Unsubscribe,
  WorkspaceId,
  WorkspaceStatus,
} from "../api";

/** A single atomic commit = the events one command appends, as one stream message. */
export type Commit = IEventEnvelope[];

export interface AppendResult {
  /** Version after the last appended event (== new stream head / event count). */
  readonly headVersion: number;
  /** Opaque DS resume cursor after this append, if the server returned one. */
  readonly cursor: string | undefined;
}

export interface ReadResult {
  /** Flattened, version-ordered events from `fromCursor` onward. */
  readonly events: IEventEnvelope[];
  /** Opaque DS cursor to resume after the last returned event. */
  readonly nextCursor: string;
}

/** JSON-friendly snapshot of workspace state (Maps flattened to arrays). */
export interface SerializedWorkspaceState {
  readonly id: WorkspaceId;
  readonly name: string;
  readonly status: WorkspaceStatus;
  readonly version: number;
  readonly pages: IPageNode[];
  readonly children: [parent: PageOrRootKey, childIds: string[]][];
  readonly links: { from: string; to: string; role: string }[];
  /** Pages skipped as retired-type during the fold; optional — absent in older snapshots. */
  readonly retired?: string[];
}

export type PageOrRootKey = string; // PageId | "@root"

export interface SerializedSnapshot {
  /** Workspace version this snapshot covers (skip events with version ≤ this on fold). */
  readonly version: number;
  /** DS resume cursor at the snapshot point (coarse; fold stays idempotent). */
  readonly cursor: string;
  readonly state: SerializedWorkspaceState;
  /** Page-type version fingerprint; a mismatch invalidates the snapshot. */
  readonly fingerprint: string;
}

/** Namespace catalog stream events. Secondary index, not a consistency boundary. */
export type CatalogEvent =
  | { readonly type: "WorkspaceRegistered"; readonly id: WorkspaceId; readonly name: string; readonly at: string }
  | { readonly type: "WorkspaceRenamed"; readonly id: WorkspaceId; readonly name: string; readonly at: string }
  | { readonly type: "WorkspaceArchived"; readonly id: WorkspaceId; readonly at: string }
  | { readonly type: "WorkspaceUnarchived"; readonly id: WorkspaceId; readonly at: string };

/**
 * The persistence port. The ONLY thing that talks to Durable Streams
 * is the concrete `EventLog` implementing this; everything else depends on the
 * interface. Promote/extend only when a real second backend appears (ADR-001).
 */
export interface IEventLog {
  /** Idempotently ensure the workspace stream exists. */
  ensure(ws: WorkspaceId): Promise<void>;
  /** Does the workspace stream exist? */
  exists(ws: WorkspaceId): Promise<boolean>;
  /**
   * Append a command's events as ONE atomic message, asserting the folded head
   * is exactly `expectedVersion` (OCC via padded Stream-Seq). Throws
   * {@link ConcurrencyError}-eligible signal (a stale-write conflict) so the bus
   * can rebase-and-retry. Empty `events` is a no-op.
   */
  append(ws: WorkspaceId, events: IEventEnvelope[], opts: { expectedVersion: number }): Promise<AppendResult>;
  /** Read flattened events from a coarse cursor (or the start when omitted). */
  read(ws: WorkspaceId, fromCursor?: string): Promise<ReadResult>;
  /** Live tail: invoke `onBatch` with each batch's flattened events + resume cursor. */
  subscribe(
    ws: WorkspaceId,
    onBatch: (events: IEventEnvelope[], cursor: string) => void | Promise<void>,
    opts?: { fromCursor?: string },
  ): Promise<Unsubscribe>;

  // ── sibling snapshot stream `…/workspace/{id}/snapshot` ──
  appendSnapshot(ws: WorkspaceId, snapshot: SerializedSnapshot): Promise<void>;
  readLatestSnapshot(ws: WorkspaceId): Promise<SerializedSnapshot | undefined>;

  // ── namespace catalog stream `…/{namespace}/_catalog` ──
  appendCatalog(event: CatalogEvent): Promise<void>;
  readCatalog(): Promise<CatalogEvent[]>;

  /** Release any cached handles / live subscriptions. */
  close(): Promise<void>;
}

/** Sentinel signal an EventLog raises on a stale (OCC) append; bus maps to retry/ConcurrencyError. */
export class StaleAppendError extends Error {
  readonly __stale = true as const;
  constructor(message = "stale append (optimistic-concurrency conflict)") {
    super(message);
    this.name = "StaleAppendError";
  }
}

export function isStaleAppend(e: unknown): e is StaleAppendError {
  return typeof e === "object" && e !== null && (e as { __stale?: unknown }).__stale === true;
}

/** Per-open-workspace in-memory projection. */
export interface ProjectionEntry {
  state: IWorkspaceState;
  /** DS cursor for the last event folded into `state`. */
  cursor: string;
  /** Events folded since the last snapshot (drives count-based snapshotting). */
  eventsSinceSnapshot: number;
  /** epoch ms of the last local write (drives idle snapshotting); from injected clock-ish source. */
  lastWriteAt: number;
  /** Fan-out targets for handle.subscribe(). */
  readonly subscribers: Set<(event: IEventEnvelope) => void>;
  /** Tear down the live tail. */
  liveUnsub?: Unsubscribe;
}

/** Injected services threaded through the engine (clock + id generation). */
export interface Services {
  readonly now: () => string;
  readonly newId: () => string;
}

export type { IWorkspaceState, IEventEnvelope };
