/**
 * The command bus — the engine's hot path (DESIGN §5, §15; BUILD_NOTES §3, §4).
 *
 * `CommandBus` operates on ONE workspace `ProjectionEntry` (folded `state`, the
 * full in-memory `events[]` for `history()`, a DS cursor, snapshot bookkeeping,
 * and the fan-out subscriber set) supplied by the workspace handle. It owns the
 * pure validate → guard → build-context → decide → commit pipeline; the handle
 * owns the per-workspace mutex (the bus must be re-entrant so a rebase can re-run
 * the pipeline without re-acquiring the lock).
 *
 * Two entry points:
 *  - `runStructural(projection, {handler, args, …})` — structural commands.
 *  - `runPage(projection, {pageId, command, args, …})` — page-scoped FSM commands.
 *
 * Everything before `commit` is pure: no host clock / RNG. Time and ids ride in
 * exclusively via the injected {@link Services} (`now()` / `newId()`).
 */
import type {
  DeepReadonly,
  DomainEvent,
  ICommandContext,
  IEventEnvelope,
  IEventMeta,
  IRelatedReader,
  IWorkspaceState,
  PageId,
  PageState,
  RootId,
  WorkspaceId,
} from "../api";
import {
  ConcurrencyError,
  ItemNotFoundError,
  MutationNotAllowedError,
  PageNotFoundError,
  WorkspaceArchivedError,
} from "./errors";
import type { Registry } from "./registry";
import { writeSnapshot } from "./snapshot";
import { STRUCTURAL_HANDLERS, type StructureHandler } from "./structure";
import { isStaleAppend, type IEventLog, type ProjectionEntry, type Services } from "./types";
import { applyWorkspace, isStructuralEvent, pageStateView } from "./workspace";

/** Max rebase attempts before surfacing {@link ConcurrencyError}. */
const MAX_REBASE_ATTEMPTS = 5;

/** Bus dependencies / configuration. */
export interface CommandBusConfig {
  readonly snapshotEvery: number;
  /** Optional sink for every appended event. Must not throw (we still guard it). */
  readonly onEvent?: (event: IEventEnvelope) => void;
}

/**
 * A committed write's outcome (DESIGN §5 step 6, §8.6): the command's `result`
 * value plus the **committed-head version** — the per-workspace `version` after the
 * append and any OCC rebase-retry. The handle turns `committedVersion` into a
 * {@link ConsistencyToken}. An idempotent / zero-event write reports the current head.
 */
export interface CommitOutcome {
  readonly result: unknown;
  /** The workspace `version` after this commit landed (== folded head). */
  readonly committedVersion: number;
}

/**
 * The bus's view of an open workspace: the standard {@link ProjectionEntry} plus
 * the FULL in-memory event log the handle keeps for `history()`. The bus appends
 * each committed/rebased envelope to `events` so `history()` is always complete.
 */
export interface BusProjection extends ProjectionEntry {
  /** Full ordered event history for this workspace (drives `handle.history()`). */
  readonly events: IEventEnvelope[];
}

/** A structural-command invocation. */
export interface StructuralRequest {
  /** Key into {@link STRUCTURAL_HANDLERS} (e.g. "createPage", "reparent", "archive"). */
  readonly handler: string;
  readonly args: unknown;
  readonly commandId?: string;
  readonly actor?: string;
}

/** A page-scoped command invocation. */
export interface PageRequest {
  readonly pageId: PageId;
  readonly command: string;
  readonly args: unknown;
  readonly commandId?: string;
  readonly actor?: string;
}

/**
 * The internal command bus. One instance per open workspace handle. Pure pipeline
 * + a single I/O step (the atomic append); rebases by reading the tail and
 * re-running the decision against fresh state.
 */
export class CommandBus {
  constructor(
    private readonly eventLog: IEventLog,
    private readonly registry: Registry,
    private readonly services: Services,
    private readonly config: CommandBusConfig,
  ) {}

  // ──────────────────────────────────────────────────────────────────────────
  // Structural commands
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Run a structural command. The decision is re-evaluated from scratch on each
   * (re)attempt against the latest folded state so a rebase re-checks invariants.
   * Resolves to a {@link CommitOutcome} (result + committed-head version, §8.6).
   */
  async runStructural(projection: BusProjection, req: StructuralRequest): Promise<CommitOutcome> {
    const handler = STRUCTURAL_HANDLERS[req.handler];
    if (handler === undefined) {
      // Unknown structural verb — treat as a forbidden mutation rather than a crash.
      throw new MutationNotAllowedError("workspace", projection.state.status, req.handler, [
        ...Object.keys(STRUCTURAL_HANDLERS),
      ]);
    }
    const decide = (state: IWorkspaceState) => this.decideStructural(handler, state, req);
    return this.commit(projection, decide, { actor: req.actor, commandId: req.commandId });
  }

  /** Pure structural decision: workspace must be active, then run the handler. */
  private decideStructural(
    handler: StructureHandler,
    state: IWorkspaceState,
    req: StructuralRequest,
  ): { events: DomainEvent[]; result: unknown } {
    if (state.status === "archived") {
      throw new WorkspaceArchivedError(state.id);
    }
    const { events, result } = handler(state, req.args, this.services, this.registry);
    return { events, result };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Page-scoped commands
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Run a page-scoped command: validate args, guard the page FSM (and the item
   * FSM for item-level commands), build the command context, run the pure
   * `produces`, then commit. The decision is re-run on each rebase attempt.
   * Resolves to a {@link CommitOutcome} (result + committed-head version, §8.6).
   */
  async runPage(projection: BusProjection, req: PageRequest): Promise<CommitOutcome> {
    const decide = (state: IWorkspaceState) => this.decidePage(state, req);
    return this.commit(projection, decide, {
      actor: req.actor,
      commandId: req.commandId,
      // Page-command events default to the target page when they omit `pageId`
      // (BUILD_NOTES §2). Structural commands set their own pageId explicitly.
      defaultPageId: req.pageId,
    });
  }

  /** Pure page-command decision (validate → guard → context → produces). */
  private decidePage(
    state: IWorkspaceState,
    req: PageRequest,
  ): { events: DomainEvent[]; result: unknown } {
    if (state.status === "archived") {
      throw new WorkspaceArchivedError(state.id);
    }

    const node = state.pages.get(req.pageId);
    if (node === undefined) throw new PageNotFoundError(req.pageId);

    const def = this.registry.page(node.type);
    const cmd = def.commands[req.command];
    const guard = this.registry.pageGuard(node.type);

    // Unknown command for this type → MutationNotAllowed listing what IS allowed.
    if (cmd === undefined) {
      throw new MutationNotAllowedError(
        node.type,
        node.status,
        req.command,
        guard.available(node.status),
      );
    }

    // 1) Validate args (→ ValidationError on failure).
    const parsed = cmd.args.parse(req.args) as Record<string, unknown>;

    // 2) Page FSM: is this command legal from the current page status?
    if (!guard.can(node.status, req.command)) {
      throw new MutationNotAllowedError(
        node.type,
        node.status,
        req.command,
        guard.available(node.status),
      );
    }

    // 3) Item-level commands ALSO check the target item's FSM.
    if (cmd.transition.level === "item") {
      const { itemType, idArg, event } = cmd.transition;
      const itemId = parsed[idArg] as string;
      const bucket = node.items[itemType] ?? [];
      const item = bucket.find((i) => i.id === itemId);
      if (item === undefined) {
        throw new ItemNotFoundError(itemType, String(itemId));
      }
      const itemGuard = this.registry.itemGuard(itemType);
      const itemStatus = item.status ?? "";
      if (itemGuard !== undefined && !itemGuard.can(itemStatus, event)) {
        throw new MutationNotAllowedError(
          `${node.type}.${itemType}`,
          itemStatus,
          req.command,
          itemGuard.available(itemStatus),
        );
      }
    }

    // 4) Build the command context (cross-page reads via `related`) and decide.
    const ctx = this.buildContext(state, req.pageId, req.actor, req.commandId);
    const view: PageState = pageStateView(node);
    const { events, result } = cmd.produces(view, parsed, ctx);
    return { events, result };
  }

  /** Assemble the read-only {@link ICommandContext} a `produces` is handed. */
  private buildContext(
    state: IWorkspaceState,
    self: PageId,
    actor: string | undefined,
    commandId: string | undefined,
  ): ICommandContext {
    const related: IRelatedReader = {
      self,
      page(id: PageId): DeepReadonly<PageState> | undefined {
        const n = state.pages.get(id);
        if (n === undefined) return undefined;
        return pageStateView(n) as DeepReadonly<PageState>;
      },
      childrenOf(id: PageId | RootId): readonly PageId[] {
        return [...(state.children.get(id) ?? [])];
      },
    };
    return {
      newId: this.services.newId,
      now: this.services.now(),
      ...(actor !== undefined ? { actor } : {}),
      ...(commandId !== undefined ? { commandId } : {}),
      related,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Commit (the only I/O step) + rebase-and-retry
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Run the pure `decide` against the current folded state, envelope its events,
   * and append them atomically asserting `expectedVersion = state.version`. On a
   * stale-write conflict, fold the new tail forward and re-run `decide` against
   * the fresh state (bounded retries → {@link ConcurrencyError}).
   *
   * Returns a {@link CommitOutcome}: the typed `result` plus the **committed-head
   * version** after the append AND any rebase (§5 step 6, §8.6). An idempotent /
   * zero-event write reports the current head — no append happens, so the token
   * names where the (already-applied or empty) effect sits.
   */
  private async commit(
    projection: BusProjection,
    decide: (state: IWorkspaceState) => { events: DomainEvent[]; result: unknown },
    meta: { actor?: string; commandId?: string; defaultPageId?: PageId },
  ): Promise<CommitOutcome> {
    const ws = projection.state.id;

    for (let attempt = 0; attempt < MAX_REBASE_ATTEMPTS; attempt++) {
      // Idempotency: a commandId already represented in history short-circuits
      // BEFORE we guard/decide (the FSM would otherwise reject the replayed
      // command). The original append already produced the effect (BUILD_NOTES §3).
      // The token reflects the CURRENT head, since the effect already landed (§8.6).
      if (meta.commandId !== undefined && this.commandSeen(projection, meta.commandId)) {
        return { result: undefined, committedVersion: projection.state.version };
      }

      // (Re)decide against the freshest folded state every attempt.
      const { events: raw, result } = decide(projection.state);

      const expectedVersion = projection.state.version;

      // Empty decision: nothing to append — current head is the committed head (§8.6).
      if (raw.length === 0) {
        return { result, committedVersion: projection.state.version };
      }

      const envelopes = this.envelope(projection.state, raw, expectedVersion, meta);

      try {
        await this.eventLog.append(ws, envelopes, { expectedVersion });
      } catch (e) {
        if (isStaleAppend(e)) {
          await this.rebase(projection);
          continue;
        }
        throw e;
      }

      // Success — fold our own envelopes in, advance bookkeeping, fan out. The
      // committed head is the post-absorb version (after the append; rebases
      // already advanced it before this attempt).
      this.absorb(projection, envelopes);
      await this.maybeSnapshot(projection);
      return { result, committedVersion: projection.state.version };
    }

    throw new ConcurrencyError(projection.state.version, projection.state.version);
  }

  /** Envelope each lightweight {@link DomainEvent} into a full {@link IEventEnvelope}. */
  private envelope(
    state: IWorkspaceState,
    raw: readonly DomainEvent[],
    expectedVersion: number,
    meta: { actor?: string; commandId?: string; defaultPageId?: PageId },
  ): IEventEnvelope[] {
    const ws: WorkspaceId = state.id;
    const eventMeta: IEventMeta = {
      occurredAt: this.services.now(),
      ...(meta.actor !== undefined ? { actor: meta.actor } : {}),
      ...(meta.commandId !== undefined ? { commandId: meta.commandId } : {}),
    };

    return raw.map((ev, i): IEventEnvelope => {
      // A content event that omits `pageId` defaults to the command's target
      // page; structural/workspace events keep their own (possibly absent) pageId.
      const pageId =
        ev.pageId ?? (isStructuralEvent(ev.type) ? undefined : meta.defaultPageId);
      const env: IEventEnvelope = {
        eventId: this.services.newId(),
        streamId: ws,
        ...(pageId !== undefined ? { pageId } : {}),
        version: expectedVersion + i,
        type: ev.type,
        schemaVersion: this.schemaVersionFor(state, ev, pageId),
        payload: ev.payload,
        meta: eventMeta,
      };
      return env;
    });
  }

  /**
   * Choose a raw event's `schemaVersion`: a CONTENT event (one routed to a page
   * type's `apply`) is stamped with that page type's current `version`; every
   * structural/workspace event uses `0`. The owning page type is resolved from
   * the (possibly not-yet-folded) projection node, or — for `PageCreated`, whose
   * node does not exist yet — from the event payload's `type`. Unknown types fall
   * back to `0` (the reducer's upcaster handles the rest).
   */
  private schemaVersionFor(state: IWorkspaceState, ev: DomainEvent, pageId?: PageId): number {
    // Structural / workspace events (incl. PageCreated, which carries a pageId)
    // are not content events — they never carry a page-type schema version.
    if (isStructuralEvent(ev.type)) return 0;
    const targetPage = ev.pageId ?? pageId;
    if (targetPage === undefined) return 0;
    const pageType: string | undefined = state.pages.get(targetPage)?.type;
    if (pageType === undefined || !this.registry.has(pageType)) return 0;
    return this.registry.page(pageType).version;
  }

  /** Fold our committed envelopes into the projection and fan out. */
  private absorb(projection: BusProjection, envelopes: readonly IEventEnvelope[]): void {
    for (const env of envelopes) {
      applyWorkspace(projection.state, env, this.registry);
      projection.state.version = env.version + 1;
      projection.events.push(env);
      projection.eventsSinceSnapshot += 1;
      this.fanOut(projection, env);
    }
  }

  /** Deliver one event to handle subscribers + the config sink (never throws out). */
  private fanOut(projection: BusProjection, env: IEventEnvelope): void {
    for (const sub of projection.subscribers) {
      try {
        sub(env);
      } catch {
        /* subscribers must not break the write path */
      }
    }
    if (this.config.onEvent !== undefined) {
      try {
        this.config.onEvent(env);
      } catch {
        /* sink must not throw, per contract — guard anyway */
      }
    }
  }

  /** Has any event already in this projection's history carried `commandId`? */
  private commandSeen(projection: BusProjection, commandId: string): boolean {
    for (const env of projection.events) {
      if (env.meta.commandId === commandId) return true;
    }
    return false;
  }

  /** Read the new tail past our cursor, fold it forward, advance the cursor. */
  private async rebase(projection: BusProjection): Promise<void> {
    const ws = projection.state.id;
    const { events: tail, nextCursor } = await this.eventLog.read(ws, projection.cursor);
    for (const env of tail) {
      // Skip anything we've already folded (cursor may be coarse / overlap).
      if (env.version < projection.state.version) continue;
      applyWorkspace(projection.state, env, this.registry);
      projection.state.version = env.version + 1;
      projection.events.push(env);
      projection.eventsSinceSnapshot += 1;
      this.fanOut(projection, env);
    }
    projection.cursor = nextCursor;
  }

  /** Count-based snapshot (best-effort; failures are swallowed). */
  private async maybeSnapshot(projection: BusProjection): Promise<void> {
    if (this.config.snapshotEvery <= 0) return;
    if (projection.eventsSinceSnapshot < this.config.snapshotEvery) return;
    try {
      await writeSnapshot(
        this.eventLog,
        projection.state.id,
        projection.state,
        projection.cursor,
        this.registry.fingerprint(),
      );
      projection.eventsSinceSnapshot = 0;
    } catch {
      /* snapshots are a cache, never the source of truth — ignore failures */
    }
  }
}
