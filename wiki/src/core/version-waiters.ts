/**
 * {@link VersionWaiterRegistry} — the engine-internal version-applied + parked-`waitFor`
 * machinery shared by the default {@link InMemoryReadModel} and the
 * {@link SqlSearchIndex}. Before this existed the two carried byte-for-byte copies of the
 * same logic, so the same bugs lived twice (a `forget()` that leaked parked waiters; a
 * swallowed failure that left a token-gated read hanging until its timeout).
 *
 * It tracks the highest applied `version` per workspace, releases parked `waitFor`s as the
 * head advances ({@link notifyApplied}), fails them fast on a derived-projection failure
 * ({@link failWaiters}) or on teardown ({@link forget}), and remembers the most recent
 * failure ({@link lastFailed}) so a `waitFor` arriving AFTER the failure also fails fast
 * until the next successful advance clears it.
 *
 * Engine-internal: NOT exported from `wiki/src/index.ts`. Pure of host clock/RNG —
 * timeouts use the host timer (I/O, not determinism-sensitive reducer/renderer logic).
 */
import type { ConsistencyToken, WorkspaceId } from "../api";
import { decodeToken, encodeToken, ZERO_VERSION } from "./readmodel";
import { ConsistencyTimeoutError, ReadModelClosedError } from "./errors";

/** A pending `waitFor`, settled once the workspace reaches `targetVersion` (or fails). */
interface Waiter {
  readonly targetVersion: number;
  readonly resolve: () => void;
  readonly reject: (err: unknown) => void;
  /** Host timer handle (cleared on resolve/reject). */
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class VersionWaiterRegistry {
  /** Highest applied `version` per workspace (== this projection's head). */
  private readonly applied = new Map<string, number>();
  /** Outstanding `waitFor`s per workspace. */
  private readonly waiters = new Map<string, Set<Waiter>>();
  /** The most recent failed-reindex marker per workspace (version reached + cause). */
  private readonly lastFailed = new Map<string, { version: number; err: unknown }>();

  constructor(private readonly defaultTimeoutMs: number) {}

  /** The highest applied `version` for `workspace` (the zero version if unknown). */
  appliedVersion(workspace: WorkspaceId): number {
    return this.applied.get(workspace) ?? ZERO_VERSION;
  }

  /** The applied position as an opaque {@link ConsistencyToken}. */
  appliedToken(workspace: WorkspaceId): ConsistencyToken {
    return encodeToken(workspace, this.appliedVersion(workspace));
  }

  /**
   * Resolve once the workspace has applied ≥ the token's version. Fast path: already
   * applied → resolves immediately (read-your-writes is usually free in-process). The
   * applied check comes FIRST so a version already durably applied resolves even if a
   * later target failed. Otherwise: if a recorded failure already covers this version,
   * fail fast with its cause; else park until {@link notifyApplied}/{@link failWaiters}
   * crosses the threshold or `timeoutMs` elapses ({@link ConsistencyTimeoutError}).
   */
  async waitFor(token: ConsistencyToken, opts?: { timeoutMs?: number }): Promise<void> {
    const { workspaceId, version } = decodeToken(token);
    if (this.appliedVersion(workspaceId) >= version) return;
    const failed = this.lastFailed.get(workspaceId);
    if (failed !== undefined && version <= failed.version) throw failed.err;

    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { targetVersion: version, resolve, reject, timer: undefined };
      const bucket = this.bucketFor(workspaceId);
      bucket.add(waiter);
      waiter.timer = setTimeout(() => {
        bucket.delete(waiter);
        reject(new ConsistencyTimeoutError(token, timeoutMs));
      }, timeoutMs);
      // Don't keep the event loop alive solely for a consistency wait.
      (waiter.timer as { unref?: () => void }).unref?.();
    });
  }

  /**
   * Record that `workspace` has applied up to `version` (monotonic-max). Releases every
   * parked `waitFor` the new head satisfies and CLEARS any failure marker — a fresh
   * successful advance means the index has recovered. Tolerant of out-of-order/duplicate
   * notifications.
   */
  notifyApplied(workspace: WorkspaceId, version: number): void {
    const current = this.appliedVersion(workspace);
    if (version <= current) return;
    this.applied.set(workspace, version);
    // Clear the failure marker only when this advance actually REACHES the failed version —
    // a genuine recovery. An advance that lands BELOW a pending higher-version failure (e.g.
    // hydrating a stale durable cursor while a newer reindex has already failed) must KEEP the
    // marker, so a token-gated read for that newer version still fast-fails instead of hanging.
    const failed = this.lastFailed.get(workspace);
    if (failed !== undefined && version >= failed.version) this.lastFailed.delete(workspace);

    const bucket = this.waiters.get(workspace);
    if (bucket === undefined || bucket.size === 0) return;
    for (const waiter of [...bucket]) {
      if (waiter.targetVersion <= version) {
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        bucket.delete(waiter);
        waiter.resolve();
      }
    }
  }

  /**
   * A best-effort reindex to `version` FAILED. Reject every parked `waitFor` the failed
   * target would have satisfied (fast-fail instead of a silent timeout), and remember the
   * failure at its MAX version so a `waitFor` that arrives later also fails fast — until a
   * subsequent {@link notifyApplied} that reaches the failed version (recovery) or {@link forget}.
   */
  failWaiters(workspace: WorkspaceId, version: number, err: unknown): void {
    const prev = this.lastFailed.get(workspace);
    if (prev === undefined || version > prev.version) {
      this.lastFailed.set(workspace, { version, err });
    }
    const bucket = this.waiters.get(workspace);
    if (bucket === undefined) return;
    for (const waiter of [...bucket]) {
      if (waiter.targetVersion <= version) {
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        bucket.delete(waiter);
        waiter.reject(err);
      }
    }
  }

  /**
   * Forget a workspace and REJECT any still-parked waiters with {@link ReadModelClosedError}
   * (a token-gated read can never be satisfied once its read model is gone — fail fast
   * rather than hang until the timeout), then drop all of its in-memory state.
   */
  forget(workspace: WorkspaceId): void {
    const bucket = this.waiters.get(workspace);
    if (bucket !== undefined) {
      for (const waiter of [...bucket]) {
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        waiter.reject(new ReadModelClosedError(workspace));
      }
      this.waiters.delete(workspace);
    }
    this.applied.delete(workspace);
    this.lastFailed.delete(workspace);
  }

  private bucketFor(workspace: string): Set<Waiter> {
    let bucket = this.waiters.get(workspace);
    if (bucket === undefined) {
      bucket = new Set<Waiter>();
      this.waiters.set(workspace, bucket);
    }
    return bucket;
  }
}
