/**
 * Consistency tokens + the default in-memory read model (ADR-003).
 *
 * Strict CQRS: the command bus folds a write-side decide-aggregate to validate the
 * FSM / invariants / OCC and append; a SEPARATE read model — fed by the
 * same fold off the live tail — serves all reads. This module owns:
 *
 *  - the {@link ConsistencyToken} codec: `{ workspaceId, version }` ↔ an opaque,
 *    comparable string (compared WITHIN a workspace only);
 *  - {@link InMemoryReadModel}, the default `IReadModel`. It tracks the highest
 *    `version` applied per workspace (its **applied token**) and answers
 *    `appliedToken()` / `waitFor()` locally — the common path needs no re-read.
 *
 * The read model holds NO projection of its own; the engine's handle owns the
 * single in-process fold (shared with the write side in this default), and tells
 * the read model how far it has applied via {@link InMemoryReadModel.notifyApplied}.
 * An external read model (e.g. a SQL projection) implements the same `IReadModel`
 * seam against its own store, fed by the public `foldWorkspace`.
 *
 * Pure of host clock / RNG: timeouts use the host timer, which is I/O, not
 * determinism-sensitive reducer/renderer logic.
 */
import type { ConsistencyToken, IReadModel, WorkspaceId } from "../api";
import { VersionWaiterRegistry } from "./version-waiters";

// ────────────────────────────────────────────────────────────────────────────
// Token codec — { workspaceId, version } ↔ opaque comparable string
// ────────────────────────────────────────────────────────────────────────────

/** The applied position of a brand-new / unknown workspace (no events yet). */
export const ZERO_VERSION = 0;

/**
 * Encode a {@link ConsistencyToken} for `{ workspaceId, version }`. The format is
 * opaque to callers; we keep the workspace id and a zero-padded version so tokens
 * are stable strings (the padding makes them lexicographically comparable within a
 * workspace, matching the OCC seq encoding).
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
// InMemoryReadModel — the default IReadModel
// ────────────────────────────────────────────────────────────────────────────

/**
 * Default in-memory read model. Maintained per open workspace alongside the engine's
 * projection: every time the handle advances its fold (a local commit OR a folded
 * tail batch), it calls {@link notifyApplied}, which bumps the applied version and
 * releases any `waitFor`s that the new head satisfies. `waitFor` for an
 * already-applied token resolves immediately; otherwise it parks until
 * `notifyApplied` crosses the threshold or `timeoutMs` elapses
 * ({@link ConsistencyTimeoutError}). The applied-version + parked-waiter machinery
 * lives in the shared {@link VersionWaiterRegistry}; this class is a thin `IReadModel`
 * adapter over it.
 */
export class InMemoryReadModel implements IReadModel {
  private readonly registry: VersionWaiterRegistry;

  // Build the registry in the CONSTRUCTOR BODY, never as a field initializer: a field
  // initializer runs before the `defaultTimeoutMs` parameter-property is assigned, so it
  // would capture `undefined` and silently break the default `waitFor` timeout.
  constructor(private readonly defaultTimeoutMs: number) {
    this.registry = new VersionWaiterRegistry(defaultTimeoutMs);
  }

  // ── IReadModel ──────────────────────────────────────────────────────────────

  async appliedToken(workspace: WorkspaceId): Promise<ConsistencyToken> {
    return this.registry.appliedToken(workspace);
  }

  waitFor(token: ConsistencyToken, opts?: { timeoutMs?: number }): Promise<void> {
    return this.registry.waitFor(token, opts);
  }

  // ── feed side (called by the handle as it advances its fold) ─────────────────

  /**
   * Record that `workspace` has applied up to `version` (monotonic). Releases every
   * parked `waitFor` whose target the new head now satisfies. Idempotent / tolerant
   * of out-of-order or duplicate notifications (keeps the max).
   */
  notifyApplied(workspace: WorkspaceId, version: number): void {
    this.registry.notifyApplied(workspace, version);
  }

  /** Forget a workspace and REJECT any still-parked waiters (handle teardown). */
  forget(workspace: WorkspaceId): void {
    this.registry.forget(workspace);
  }
}
