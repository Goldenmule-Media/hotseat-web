/**
 * The projection service / tailer. Keeps the SQL read model
 * current by projecting each workspace's events; for every commit it drives
 * {@link applyCommit} (fold → serialize → SQL), advancing `applied_version` and
 * notifying the {@link SqlReadModel} so parked `waitFor`s wake.
 *
 * The live tail ({@link start}) is **event-driven**, not a hot poll.
 * Each workspace is fed by THREE signals:
 *
 *  1. **subscribe** — the engine handle's stream tail fans out EXTERNAL events
 *     (writes by *other* clients), which schedule a (coalesced) re-projection;
 *  2. **{@link notify}** — a local commit does NOT fan out to its own handle's
 *     subscribers, so THIS process pushes its own writes in explicitly (the host
 *     calls `notify(workspace)` after each write tool);
 *  3. a low-frequency **discovery** poll — the namespace catalog is not publicly
 *     subscribable, so we periodically list workspaces and attach any new
 *     ones; per-workspace DATA flows via (1)/(2), so the poll only discovers.
 *
 * The raw Durable Streams wire format is engine-internal, so this takes an injected
 * {@link EventSource} seam: anything that yields a workspace's contiguous history
 * (and optionally a live `subscribe`) drives the same apply path. A poison event the
 * configured page types can't fold **halts** that workspace's projection rather
 * than corrupting SQL.
 */
import {
  UnknownPageTypeError,
  affectedPageIds,
  foldWorkspace,
  isStructuralCommit,
  renderAffectedDocs,
  renderSearchDocs,
} from "wiki";
import { Registry } from "wiki/registry";
import type { IEventEnvelope, ISearchIndex, IWorkspaceState, PageId, SearchDoc, Unsubscribe, WorkspaceId } from "wiki";
import type { Kysely } from "kysely";

import type { Logger } from "../logger.js";
import { createLanguageRegistry } from "../models/analyzers/index.js";
import type { LanguageRegistry } from "../models/language-registry.js";
import { applyCommit, type Commit } from "../readmodel/project.js";
import type { SqlReadModel } from "../readmodel/readmodel.js";
import type { ReadModelDatabase } from "../readmodel/schema.js";
import { type RenderSink, SearchRenderSink } from "./render-sink.js";

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
  /** Discover the workspaces currently known to the namespace catalog. */
  listWorkspaces(): Promise<readonly WorkspaceId[]>;
  /**
   * Read the workspace's full event history (optionally only events past
   * `sinceVersion`, though a re-read of all is always safe — the fold + offset
   * skip make apply idempotent).
   */
  readHistory(workspace: WorkspaceId, sinceVersion: number): Promise<readonly IEventEnvelope[]>;
  /**
   * Live tail: invoke `onChange` whenever NEW external events land for
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
  private registry: Registry;
  private fingerprint: string;
  /**
   * The {@link LanguageRegistry} the symbol/reference projection consults per `code`
   * field/block `lang`. Defaults to the built-in (TS/JS) registry; analyzers
   * swap re-projects the symbol/reference indexes only, never the write model.
   */
  private readonly languages: LanguageRegistry;
  /**
   * Render-side sinks fed by the SINGLE per-commit render (the search index and the
   * Markdown-disk mirror). Each commit renders its affected pages once and fans the docs out
   * to every sink (see {@link fanOutRender}); a sink failure is best-effort and never halts
   * projection. Seeded with the search index (if wired); {@link addRenderSink} appends more.
   */
  private readonly renderSinks: RenderSink[];
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
    languages?: LanguageRegistry,
    /**
     * The engine's full-text search index (optional). When present it is wrapped as a
     * {@link RenderSink}, so each projected commit re-indexes the workspace's rendered
     * Markdown — and ALL workspaces are searchable durably (the tailer tails the whole
     * namespace, not just hot handles).
     */
    searchIndex?: ISearchIndex,
  ) {
    this.registry = new Registry(pageTypes);
    this.fingerprint = this.registry.fingerprint();
    this.languages = languages ?? createLanguageRegistry();
    this.renderSinks = searchIndex !== undefined ? [new SearchRenderSink(searchIndex)] : [];
  }

  /**
   * Register another {@link RenderSink} (e.g. the Markdown-disk mirror) to receive the same
   * per-commit render as the search index. Call BEFORE {@link start}/{@link drain} so the
   * sink is fed during the initial catch-up; pair with {@link reconcileSinks} at boot for a
   * sink that may already lag a current read model.
   */
  addRenderSink(sink: RenderSink): void {
    this.renderSinks.push(sink);
  }

  /**
   * Project a single {@link Commit} into SQL (fold → serialize → advance offset),
   * then notify the read model so parked `waitFor`s wake. On an unfoldable event
   * (`UnknownPageTypeError`) the workspace's projection **halts**: the read
   * model rejects its `waitFor`s non-retryably and the error is re-thrown for the
   * caller to log. Returns the new applied version.
   */
  async project(commit: Commit): Promise<number> {
    try {
      const { version, state, newEvents } = await applyCommit(
        this.db,
        this.registry,
        commit,
        this.fingerprint,
        this.languages,
      );
      this.readModel.notifyApplied(commit.workspaceId, version);
      // Render the commit's content ONCE and fan it out to every render sink (search index,
      // and later the Markdown-disk mirror). Reuses the fold applyCommit already did
      // (`state`/`newEvents`); on a read-model no-op the sinks catch up if they lagged.
      // Best-effort: the read model already committed, so a sink failure never halts projection.
      if (this.renderSinks.length > 0) {
        await this.fanOutRender(commit, version, state, newEvents);
      }
      this.logger.info("projection applied", { workspace: commit.workspaceId, appliedVersion: version });
      return version;
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
   * Render a commit's content ONCE and fan it out to every {@link RenderSink} (search index,
   * and later the Markdown-disk mirror). Reuses the fold {@link applyCommit} already did:
   *
   *  - **Hot path** (`state`/`newEvents` present): render only the affected pages
   *    ({@link affectedPageIds}) ONE time — O(affected), not O(workspace) — and hand the same
   *    docs to each sink that is current up to the prior applied version.
   *  - **Lagged / no-op path**: a sink behind the commit (a dropped best-effort update, a
   *    fresh/rebuilt sink) — or a read-model no-op where `applyCommit` folded nothing — rebuilds
   *    from a WHOLE-workspace render, computed at most once and only if some sink needs it.
   *
   * Every sink is best-effort and independent: a sink failure is caught, logged, and surfaced
   * via `sink.fail` (so token-gated waiters fast-fail vs a silent timeout — cleared by the next
   * successful apply), and NEVER halts projection, since the durable write already committed.
   */
  private async fanOutRender(
    commit: Commit,
    version: number,
    state: IWorkspaceState | undefined,
    newEvents: readonly IEventEnvelope[] | undefined,
  ): Promise<void> {
    const opts = this.renderOpts(commit.workspaceId);

    // The single shared render of the affected pages (the hot path: every sink is current).
    let delta: { docs: SearchDoc[]; removed: PageId[]; priorApplied: number } | undefined;
    if (state !== undefined && newEvents !== undefined) {
      const affected = affectedPageIds(newEvents, state);
      delta = {
        docs: renderAffectedDocs(state, affected, this.registry, opts),
        removed: [...affected].filter((id) => !state.pages.has(id)),
        priorApplied: version - newEvents.length, // contiguous: each event bumps version by 1
      };
    }
    // A structural commit can move a whole subtree's render PATHS — so a path-mapping sink
    // (`rebuildOnStructural`) takes a whole rebuild even when it is current (a doc-only sink
    // like search keeps the cheaper delta, since `affectedPageIds` already covers its ripple).
    const structural = newEvents !== undefined && isStructuralCommit(newEvents);

    // The whole-workspace render — built at most once, lazily, only if some sink needs it.
    let whole: { docs: SearchDoc[]; state: IWorkspaceState } | undefined;
    const renderWhole = (): { docs: SearchDoc[]; state: IWorkspaceState } => {
      if (whole === undefined) {
        const full = state ?? foldWorkspace(commit.events, this.registry);
        whole = { docs: renderSearchDocs(full, this.registry, opts), state: full };
      }
      return whole;
    };

    for (const sink of this.renderSinks) {
      try {
        const applied = await sink.appliedVersion(commit.workspaceId);
        if (delta !== undefined && state !== undefined && applied >= delta.priorApplied) {
          if (structural && sink.rebuildOnStructural === true) {
            const w = renderWhole();
            await sink.rebuild(commit.workspaceId, version, w.docs, w.state);
          } else {
            await sink.applyDelta(commit.workspaceId, version, delta.docs, delta.removed, state);
          }
        } else if (applied < version) {
          const w = renderWhole();
          await sink.rebuild(commit.workspaceId, version, w.docs, w.state);
        }
        // applied >= version with no contiguous delta: the sink is already current — no-op.
      } catch (err) {
        this.logger.warn(`${sink.name} index update failed`, {
          workspace: commit.workspaceId,
          error: err instanceof Error ? err.message : String(err),
        });
        sink.fail(commit.workspaceId, version, err);
      }
    }
  }

  /**
   * Bring every {@link RenderSink} up to each workspace's head — the boot reconcile (self-heal).
   * Independent of the SQL read model: a sink (the Markdown-disk mirror) can lag even when SQL is
   * already current — a fresh sink, a wiped output directory, a dropped best-effort update — so
   * the normal {@link project} path (gated on SQL's applied version) never fires for it. This
   * folds each workspace head ONCE and rebuilds only the sinks behind it; sinks already current
   * are skipped (the fold is cheap to skip but still read to learn the head). Best-effort per sink.
   *
   * Resilient per workspace: reading/folding a workspace whose page types aren't registered yet
   * (an {@link UnknownPageTypeError} — `wiki-server` loads its `--models-dir` bundles AFTER
   * `createWikiMcp`, and the subsequent model-load reproject feeds the sinks then) — or any other
   * per-workspace failure — is logged and skipped, never aborting boot.
   */
  async reconcileSinks(source: EventSource): Promise<void> {
    if (this.renderSinks.length === 0) return;
    for (const workspace of await source.listWorkspaces()) {
      try {
        const events = await source.readHistory(workspace, 0); // full history → head + fold
        if (events.length === 0) continue;
        const head = events[events.length - 1].version + 1;
        const lagging: RenderSink[] = [];
        for (const sink of this.renderSinks) {
          if ((await sink.appliedVersion(workspace)) < head) lagging.push(sink);
        }
        if (lagging.length === 0) continue;
        const state = foldWorkspace(events, this.registry);
        const docs = renderSearchDocs(state, this.registry, this.renderOpts(workspace));
        for (const sink of lagging) {
          try {
            await sink.rebuild(workspace, state.version, docs, state);
          } catch (err) {
            this.logger.warn(`${sink.name} index update failed`, {
              workspace,
              error: err instanceof Error ? err.message : String(err),
            });
            sink.fail(workspace, state.version, err);
          }
        }
      } catch (err) {
        // Unregistered page types (models not loaded yet) or any read/fold failure for ONE
        // workspace must not abort boot — the model-load reproject reconciles the sinks later.
        this.logger.warn("render-sink reconcile skipped a workspace", {
          workspace,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Build the render-error hook for a workspace's per-commit render (shared by every
   * {@link RenderSink}): a page that fails to render yields an empty body but is logged per
   * page, so an otherwise-silent render-vs-fold drift surfaces in the tailer's logs (the
   * durable feed path, where this Logger is the signal).
   */
  private renderOpts(workspace: WorkspaceId): { onRenderError: (pageId: string, err: unknown) => void } {
    return {
      onRenderError: (pageId: string, err: unknown): void => {
        this.logger.warn("render: page failed to render (projected with empty body)", {
          workspace,
          pageId,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    };
  }

  /**
   * Project one workspace from its `applied_version` to head — the body of
   * {@link drain} and of the live tail. Idempotent: events `<= applied_version` are
   * skipped, so a re-run with no new events is a no-op.
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

  // ── model hot-reload (ADR-M6) ────────────────────────────────────────────────────

  /**
   * Rebind the fold to a NEW registry (ADR-M6 hot-reload) — call when the model set
   * changes, then {@link reproject} to rebuild SQL with it. Subsequent applies fold with
   * the new registry and stamp the new `fingerprint`.
   */
  rebind(registry: Registry): void {
    this.registry = registry;
    this.fingerprint = registry.fingerprint();
  }

  /**
   * Re-fold the read model with the CURRENT registry (ADR-M6). Resets every projected
   * workspace's offset — so {@link applyCommit}'s idempotency guard (`headApplied <=
   * applied`) doesn't skip the re-fold — and clears any halt (a freshly-loaded bundle may
   * now cover a previously-poison type), then re-projects from scratch. A workspace the
   * new registry STILL can't fold simply re-halts (its stale rows linger); the reproject
   * never throws so one bad workspace can't abort the rest.
   */
  async reproject(source: EventSource): Promise<void> {
    const projected = (
      await this.db.selectFrom("projection_offsets").select("workspace_id").execute()
    ).map((r) => r.workspace_id as WorkspaceId);
    for (const ws of projected) {
      this.readModel.resume(ws);
      await this.db.deleteFrom("projection_offsets").where("workspace_id", "=", ws).execute();
    }
    const all = new Set<WorkspaceId>([...projected, ...(await source.listWorkspaces())]);
    let halted = 0;
    for (const ws of all) {
      try {
        await this.projectWorkspace(source, ws);
      } catch {
        halted++; // project() already logged it; a still-unfoldable workspace stays halted.
      }
    }
    this.logger.info("reprojected read model", { workspaces: all.size, halted, fingerprint: this.fingerprint });
  }

  // ── live tail ───────────────────────────────────────────────────────────────────

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
   * writes, which a local commit does not fan out to stream subscribers.
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

  /** The registry fingerprint stamped on offsets — exposed for rebuild checks. */
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
