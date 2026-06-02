/**
 * The projection service / tailer (DESIGN §5.1, §7). Discovers workspaces (via the
 * namespace catalog) and holds a live tail of each workspace's stream; for every
 * commit it drives {@link applyCommit} (fold → serialize → SQL), advancing
 * `applied_version` and notifying the {@link SqlReadModel} so `waitFor`s wake.
 *
 * The raw Durable Streams wire format (catalog discovery + per-workspace event
 * envelopes) is engine-internal, so this module takes an injected
 * {@link EventSource} seam: anything that yields each workspace's contiguous event
 * history drives the same apply path. The v1 wiring connects it to localhost
 * streams (§8); tests connect it to a hand-built history. A poison event the
 * configured page types can't fold **halts** that workspace's projection (§9)
 * rather than corrupting SQL.
 */
import { UnknownPageTypeError } from "wiki";
import { Registry } from "wiki/registry";
import type { IEventEnvelope, WorkspaceId } from "wiki";
import type { Kysely } from "kysely";

import type { Logger } from "../logger.js";
import { applyCommit, type Commit } from "../readmodel/project.js";
import type { SqlReadModel } from "../readmodel/readmodel.js";
import type { ReadModelDatabase } from "../readmodel/schema.js";

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
}

/** A projection service bound to a store, registry, and read model. */
export class ProjectionService {
  private readonly registry: Registry;
  private readonly fingerprint: string;

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
   * Pull each known workspace's history from the {@link EventSource} and project it
   * once (resuming from each workspace's `applied_version`). The single drain used
   * at startup and as the body of the live-tail loop; idempotent re-delivery is a
   * no-op (events `<= applied_version` are skipped, §5.1).
   */
  async drain(source: EventSource): Promise<void> {
    const workspaces = await source.listWorkspaces();
    for (const workspace of workspaces) {
      const since = await this.appliedVersionOf(workspace);
      const history = await source.readHistory(workspace, since);
      if (history.length === 0) continue;
      const head = history[history.length - 1];
      await this.project({ workspaceId: workspace, events: history, cursor: undefined });
      void head;
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
