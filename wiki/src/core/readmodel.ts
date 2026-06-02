/**
 * Consistency tokens + the default in-memory read model (DESIGN §8.4, §8.6;
 * ADR-003; BUILD_NOTES — CQRS contract).
 *
 * Strict CQRS: the command bus folds a write-side decide-aggregate to validate the
 * FSM / invariants / OCC and append (§5, §15); a SEPARATE read model — fed by the
 * same fold off the live tail — serves all reads. This module owns:
 *
 *  - the {@link ConsistencyToken} codec: `{ workspaceId, version }` ↔ an opaque,
 *    comparable string (compared WITHIN a workspace only, §8.6);
 *  - {@link InMemoryReadModel}, the default `IReadModel`. It tracks the highest
 *    `version` applied per workspace (its **applied token**) and answers
 *    `appliedToken()` / `waitFor()` locally — the common path needs no re-read.
 *
 * The read model holds NO projection of its own; the engine's handle owns the
 * single in-process fold (shared with the write side in this default), and tells
 * the read model how far it has applied via {@link InMemoryReadModel.notifyApplied}.
 * An external read model (e.g. a SQL projection) implements the same `IReadModel`
 * seam against its own store, fed by the public `foldWorkspace` (§16.1).
 *
 * Pure of host clock / RNG: timeouts use the host timer, which is I/O, not
 * determinism-sensitive reducer/renderer logic.
 */
import type { ConsistencyToken, IReadModel, WorkspaceId } from "../api";
import { ConsistencyTimeoutError } from "./errors";

// ────────────────────────────────────────────────────────────────────────────
// Token codec — { workspaceId, version } ↔ opaque comparable string (§8.6)
// ────────────────────────────────────────────────────────────────────────────

/** The applied position of a brand-new / unknown workspace (no events yet). */
export const ZERO_VERSION = 0;

/**
 * Encode a {@link ConsistencyToken} for `{ workspaceId, version }`. The format is
 * opaque to callers; we keep the workspace id and a zero-padded version so tokens
 * are stable strings (the padding makes them lexicographically comparable within a
 * workspace, matching the OCC seq encoding — BUILD_NOTES §1).
 */
export function encodeToken(workspaceId: WorkspaceId, version: number): ConsistencyToken {
  return `${workspaceId}@${padVersion(version)}` as ConsistencyToken;
}

/** Decode a {@link ConsistencyToken} into its `{ workspaceId, version }` parts. */
export function decodeToken(token: ConsistencyToken): { workspaceId: WorkspaceId; version: number } {
  const at = token.lastIndexOf("@");
  if (at === -1) {
    // Tolerate a malformed/foreign token: treat the whole string as the ws id at v0.
    return { workspaceId: token as unknown as WorkspaceId, version: ZERO_VERSION };
  }
  const workspaceId = token.slice(0, at) as unknown as WorkspaceId;
  const version = Number.parseInt(token.slice(at + 1), 10);
  return { workspaceId, version: Number.isFinite(version) ? version : ZERO_VERSION };
}

/** Zero-pad a version to a fixed width so tokens sort lexicographically (per workspace). */
function padVersion(version: number): string {
  return String(version).padStart(20, "0");
}

// ────────────────────────────────────────────────────────────────────────────
// InMemoryReadModel — the default IReadModel (§8.4 / §8.6)
// ────────────────────────────────────────────────────────────────────────────

/** A pending `waitFor` resolved once the workspace reaches `targetVersion`. */
interface Waiter {
  readonly targetVersion: number;
  readonly resolve: () => void;
  readonly reject: (err: unknown) => void;
  /** Host timer handle (cleared on resolve/reject). */
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Default in-memory read model. Maintained per open workspace alongside the engine's
 * projection: every time the handle advances its fold (a local commit OR a folded
 * tail batch), it calls {@link notifyApplied}, which bumps the applied version and
 * releases any `waitFor`s that the new head satisfies. `waitFor` for an
 * already-applied token resolves immediately; otherwise it parks until
 * `notifyApplied` crosses the threshold or `timeoutMs` elapses
 * ({@link ConsistencyTimeoutError}).
 */
export class InMemoryReadModel implements IReadModel {
  /** Highest applied `version` per workspace (== read-side head). */
  private readonly applied = new Map<string, number>();
  /** Outstanding `waitFor`s per workspace. */
  private readonly waiters = new Map<string, Set<Waiter>>();

  constructor(private readonly defaultTimeoutMs: number) {}

  // ── IReadModel ──────────────────────────────────────────────────────────────

  async appliedToken(workspace: WorkspaceId): Promise<ConsistencyToken> {
    return encodeToken(workspace, this.appliedVersion(workspace));
  }

  async waitFor(token: ConsistencyToken, opts?: { timeoutMs?: number }): Promise<void> {
    const { workspaceId, version } = decodeToken(token);

    // Fast path: already applied (read-your-writes is usually free in-process).
    if (this.appliedVersion(workspaceId) >= version) return;

    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;

    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { targetVersion: version, resolve, reject, timer: undefined };
      const bucket = this.waitersFor(workspaceId);
      bucket.add(waiter);

      waiter.timer = setTimeout(() => {
        bucket.delete(waiter);
        reject(new ConsistencyTimeoutError(token, timeoutMs));
      }, timeoutMs);
      // Don't keep the event loop alive solely for a consistency wait.
      (waiter.timer as { unref?: () => void }).unref?.();
    });
  }

  // ── feed side (called by the handle as it advances its fold) ─────────────────

  /**
   * Record that `workspace` has applied up to `version` (monotonic). Releases every
   * parked `waitFor` whose target the new head now satisfies. Idempotent / tolerant
   * of out-of-order or duplicate notifications (keeps the max).
   */
  notifyApplied(workspace: WorkspaceId, version: number): void {
    const current = this.applied.get(workspace) ?? ZERO_VERSION;
    if (version <= current) return;
    this.applied.set(workspace, version);

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

  /** Forget a workspace and reject any still-parked waiters (handle teardown). */
  forget(workspace: WorkspaceId): void {
    this.applied.delete(workspace);
    const bucket = this.waiters.get(workspace);
    if (bucket !== undefined) {
      for (const waiter of [...bucket]) {
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      }
      this.waiters.delete(workspace);
    }
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private appliedVersion(workspace: WorkspaceId): number {
    return this.applied.get(workspace) ?? ZERO_VERSION;
  }

  private waitersFor(workspace: WorkspaceId): Set<Waiter> {
    let bucket = this.waiters.get(workspace);
    if (bucket === undefined) {
      bucket = new Set<Waiter>();
      this.waiters.set(workspace, bucket);
    }
    return bucket;
  }
}
