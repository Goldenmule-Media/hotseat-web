/**
 * The projection service / tailer (DESIGN §5.1, §7). Keeps the SQL read model
 * current by projecting each workspace's events; for every commit it drives
 * {@link applyCommit} (fold → serialize → SQL), advancing `applied_version` and
 * notifying the {@link SqlReadModel} so parked `waitFor`s wake.
 *
 * The live tail ({@link start}) is **event-driven** (DESIGN §5.1), not a hot poll.
 * Each workspace is fed by THREE signals:
 *
 *  1. **subscribe** — the engine handle's stream tail fans out EXTERNAL events
 *     (writes by *other* clients, §8.4), which schedule a (coalesced) re-projection;
 *  2. **{@link notify}** — a local commit does NOT fan out to its own handle's
 *     subscribers, so THIS process pushes its own writes in explicitly (the host
 *     calls `notify(workspace)` after each write tool);
 *  3. a low-frequency **discovery** poll — the namespace catalog is not publicly
 *     subscribable (§9.3), so we periodically list workspaces and attach any new
 *     ones; per-workspace DATA flows via (1)/(2), so the poll only discovers.
 *
 * The raw Durable Streams wire format is engine-internal, so this takes an injected
 * {@link EventSource} seam: anything that yields a workspace's contiguous history
 * (and optionally a live `subscribe`) drives the same apply path. A poison event the
 * configured page types can't fold **halts** that workspace's projection (§9) rather
 * than corrupting SQL.
 */
import { UnknownPageTypeError } from "wiki";
import { Registry } from "wiki/registry";
import type { IEventEnvelope, Unsubscribe, WorkspaceId } from "wiki";
import type { Kysely } from "kysely";

import type { Logger } from "../logger.js";
import { applyCommit, type Commit } from "../readmodel/project.js";
import type { SqlReadModel } from "../readmodel/readmodel.js";
import type { ReadModelDatabase } from "../readmodel/schema.js";

/**
 * Default cadence (ms) for the catalog DISCOVERY poll — only lists + attaches NEW
 * workspaces (cheap); per-workspace data flows via subscribe/notify, not this timer.
 */
const DEFAULT_DISCOVER_POLL_MS = 1000;

/**
 * A source of workspace commits to project. A real implementation tails the
 * namespace catalog + per-workspace Durable Streams; a test feeds a scripted
 * history. Each {@link Commit} carries the workspace's FULL contiguous history so
 * the projection can fold it with the engine reducer (ADR-M3).
 */
export interface EventSource {
  /** Discover the workspaces currently known to the namespace catalog (§5.1). */
  listWorkspaces(): Promise<readonly WorkspaceId[]>;
  /**
   * Read the workspace's full event history (optionally only events past
   * `sinceVersion`, though a re-read of all is always safe — the fold + offset
   * skip make apply idempotent, §5.1).
   */
  readHistory(workspace: WorkspaceId, sinceVersion: number): Promise<readonly IEventEnvelope[]>;
  /**
   * Live tail (§5.1): invoke `onChange` whenever NEW external events land for
   * `workspace`, returning an unsubscribe. Optional — a source without it (a scripted
   * test source) is driven by {@link ProjectionService.drain}/`notify` alone.
   */
  subscribe?(workspace: WorkspaceId, onChange: () => void): Promise<Unsubscribe>;
}

/** One attached workspace in the live tail: its coalesced scheduler + its unsubscribe. */
interface Attached {
  /** Schedule a coalesced re-projection of this workspace. */
  readonly schedule: () => void;
  /** Tear down this workspace's stream subscription. */
  readonly unsub: Unsubscribe;
}

/** A projection service bound to a store, registry, and read model. */
export class ProjectionService {
  private readonly registry: Registry;
  private readonly fingerprint: string;
  /** Live-tail state — set by {@link start}, cleared by {@link stopLive}. */
  private live:
    | {
        readonly source: EventSource;
        readonly attached: Map<WorkspaceId, Attached>;
        timer: ReturnType<typeof setInterval> | undefined;
        stopped: boolean;
      }
    | undefined;

  constructor(
    private readonly db: Kysely<ReadModelDatabase>,
    pageTypes: ConstructorParameters<typeof Registry>[0],
    private readonly readModel: SqlReadModel,
    private readonly logger: Logger,
  ) {
    this.registry = new Registry(pageTypes);
    this.fingerprint = this.registry.fingerprint();
  }

  /**
   * Project a single {@link Commit} into SQL (fold → serialize → advance offset),
   * then notify the read model so parked `waitFor`s wake. On an unfoldable event
   * (`UnknownPageTypeError`) the workspace's projection **halts** (§9): the read
   * model rejects its `waitFor`s non-retryably and the error is re-thrown for the
   * caller to log. Returns the new applied version.
   */
  async project(commit: Commit): Promise<number> {
    try {
      const applied = await applyCommit(this.db, this.registry, commit, this.fingerprint);
      this.readModel.notifyApplied(commit.workspaceId, applied);
      this.logger.info("projection applied", { workspace: commit.workspaceId, appliedVersion: applied });
      return applied;
    } catch (err) {
      if (err instanceof UnknownPageTypeError) {
        this.readModel.halt(commit.workspaceId, err);
        this.logger.error("projection halted (unfoldable event)", {
          workspace: commit.workspaceId,
          types: err.types,
        });
      } else {
        this.logger.error("projection apply failed", {
          workspace: commit.workspaceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
  }

  /**
   * Project one workspace from its `applied_version` to head — the body of
   * {@link drain} and of the live tail. Idempotent: events `<= applied_version` are
   * skipped (§5.1), so a re-run with no new events is a no-op.
   */
  async projectWorkspace(source: EventSource, workspace: WorkspaceId): Promise<void> {
    const since = await this.appliedVersionOf(workspace);
    const history = await source.readHistory(workspace, since);
    if (history.length === 0) return;
    await this.project({ workspaceId: workspace, events: history, cursor: undefined });
  }

  /**
   * One-shot drain: project every known workspace once (resuming from each
   * `applied_version`). Used at startup/catch-up and by tests; a halt throws to the
   * caller. The live tail ({@link start}) drives the same path event-by-event.
   */
  async drain(source: EventSource): Promise<void> {
    for (const workspace of await source.listWorkspaces()) {
      await this.projectWorkspace(source, workspace);
    }
  }

  // ── live tail (DESIGN §5.1) ─────────────────────────────────────────────────────

  /**
   * Start the **event-driven** live tail. Discovers + attaches every current
   * workspace (subscribe for external events; an initial catch-up project), then
   * polls the catalog at `discoverPollMs` to attach workspaces created later by other
   * clients. Returns an unsubscribe; idempotent (a second call returns the same stop).
   * The host also calls {@link notify} after its own writes (local commits don't fan
   * out to subscribers).
   */
  async start(source: EventSource, opts?: { discoverPollMs?: number }): Promise<Unsubscribe> {
    if (this.live !== undefined) return () => this.stopLive();
    const attached = new Map<WorkspaceId, Attached>();
    const live = { source, attached, timer: undefined as ReturnType<typeof setInterval> | undefined, stopped: false };
    this.live = live;

    await this.discover(source, attached, () => live.stopped);

    const pollMs = opts?.discoverPollMs ?? DEFAULT_DISCOVER_POLL_MS;
    const timer = setInterval(() => void this.discover(source, attached, () => live.stopped), pollMs);
    (timer as { unref?: () => void }).unref?.();
    live.timer = timer;

    return () => this.stopLive();
  }

  /**
   * Push a (coalesced) projection of `workspace` — called for THIS process's own
   * writes, which a local commit does not fan out to stream subscribers (§8.4).
   * Attaches the workspace first if the tail hasn't seen it yet. No-op before
   * {@link start}.
   */
  notify(workspace: WorkspaceId): void {
    const live = this.live;
    if (live === undefined || live.stopped) return;
    const entry = live.attached.get(workspace);
    if (entry !== undefined) {
      entry.schedule();
      return;
    }
    void this.attach(live.source, live.attached, workspace, () => live.stopped);
  }

  /** Stop the live tail: unsubscribe every workspace and clear the discovery poll. */
  stopLive(): void {
    const live = this.live;
    if (live === undefined) return;
    live.stopped = true;
    if (live.timer !== undefined) clearInterval(live.timer);
    for (const { unsub } of live.attached.values()) unsub();
    live.attached.clear();
    this.live = undefined;
  }

  /**
   * Attach a workspace to the live tail: subscribe to its stream (external events),
   * then schedule an initial catch-up project. Subscribing BEFORE the first project
   * means an event arriving during catch-up is not lost — the re-projection reads to
   * head anyway. Each workspace gets a **coalesced** runner: at most one projection in
   * flight + one queued re-run, so a burst (or a multi-event commit) collapses to a
   * single up-to-head serialization. A halt/error is logged by {@link project} and
   * swallowed here so it never crashes the tailer.
   */
  private async attach(
    source: EventSource,
    attached: Map<WorkspaceId, Attached>,
    workspace: WorkspaceId,
    stopped: () => boolean,
  ): Promise<void> {
    if (stopped() || attached.has(workspace)) return;

    let running = false;
    let pending = false;
    const run = (): void => {
      if (stopped()) return;
      if (running) {
        pending = true;
        return;
      }
      running = true;
      void (async () => {
        try {
          do {
            pending = false;
            try {
              await this.projectWorkspace(source, workspace);
            } catch {
              // project() already logged (halt/error); waitFors were rejected on halt.
              // Don't crash the tailer — a later event/notify retries.
            }
          } while (pending && !stopped());
        } finally {
          running = false;
        }
      })();
    };

    let unsub: Unsubscribe = () => {};
    if (source.subscribe !== undefined) {
      unsub = await source.subscribe(workspace, run);
    }
    attached.set(workspace, { schedule: run, unsub });
    run(); // initial catch-up to head
  }

  /** List the catalog and attach any not-yet-attached workspace (discovery only). */
  private async discover(
    source: EventSource,
    attached: Map<WorkspaceId, Attached>,
    stopped: () => boolean,
  ): Promise<void> {
    if (stopped()) return;
    try {
      for (const ws of await source.listWorkspaces()) {
        await this.attach(source, attached, ws, stopped);
      }
    } catch (err) {
      this.logger.warn("workspace discovery failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** The registry fingerprint stamped on offsets (§5.3) — exposed for rebuild checks. */
  get registryFingerprint(): string {
    return this.fingerprint;
  }

  private async appliedVersionOf(workspace: WorkspaceId): Promise<number> {
    const row = await this.db
      .selectFrom("projection_offsets")
      .select("applied_version")
      .where("workspace_id", "=", workspace)
      .executeTakeFirst();
    return row?.applied_version ?? -1;
  }
}
