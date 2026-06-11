/**
 * `createWiki` — the public entry point.
 *
 * Wires the engine together: builds the {@link Registry}, the injected
 * {@link Services} (clock + id generation — the ONLY place a host clock / entropy
 * is allowed, since reducers/deciders/renderers receive time + ids via the
 * services), the {@link EventLog}, and a {@link CommandBus}. Returns an {@link IWiki}
 * that creates/opens/lists workspaces and a concrete {@link IWorkspaceHandle} +
 * {@link IPageView} over an in-memory projection kept fresh by a live tail.
 *
 * Per-workspace writes are serialized through a tiny promise-chain {@link Mutex}
 * so one process never races itself; cross-process conflicts are
 * resolved by the bus's rebase-and-retry.
 */
import type {
  BatchResult,
  Committed,
  ConsistencyToken,
  DeepReadonly,
  DomainEvent,
  FsmDescriptor,
  IAttentionItem,
  IEventEnvelope,
  IItem,
  IMutationDescriptor,
  IPageNode,
  IPageView,
  IReadOpts,
  IRelatedReader,
  ITreeNode,
  IWiki,
  IWikiConfig,
  IWorkspaceHandle,
  IWorkspaceState,
  IWorkspaceSummary,
  PageId,
  PageState,
  RootId,
  SectionDecl,
  TypeCommandDescriptor,
  TypeDescriptor,
  Unsubscribe,
  WorkspaceId,
  WorkspaceStatus,
} from "../api";
import { ROOT } from "../api";
import { displayTitle, renderPage, renderWorkspace } from "../render/read-model";
import { EventLog } from "../stores/event-log";
import { CommandBus, type BusProjection, type CommandBusConfig, type CommitOutcome } from "./command-bus";
import { PageNotFoundError, WorkspaceNotFoundError } from "./errors";
import { unauthoredRequiredInFields } from "./ingestion";
import { encodeToken, InMemoryReadModel } from "./readmodel";
import { Registry } from "./registry";
import {
  affectedPageIds,
  renderAffectedDocs,
  renderSearchDocs,
  SqlSearchIndex,
  type ISearchIndex,
  type SearchHit,
  type SearchQueryOpts,
} from "../search";
import { STRUCTURAL_HANDLERS } from "./structure";
import type { CatalogEvent, IEventLog, Services } from "./types";
import { applyWorkspace, foldWorkspace, pageStateView } from "./workspace";

/** Defaults from {@link IWikiConfig}. */
const DEFAULT_SNAPSHOT_EVERY = 100;
/** Default token-gated read `waitFor` timeout. */
const DEFAULT_READ_CONSISTENCY_TIMEOUT_MS = 5000;

// ────────────────────────────────────────────────────────────────────────────
// Mutex — a minimal promise-chain serializer
// ────────────────────────────────────────────────────────────────────────────

/**
 * Serializes async work in submission order: each `run` awaits the previous
 * task's settlement (success OR failure) before starting, so per-workspace
 * commands never interleave within one process.
 */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    // Keep the chain alive regardless of this task's outcome.
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Default services (host clock / entropy ALLOWED here only)
// ────────────────────────────────────────────────────────────────────────────

/** Default ISO-8601 clock from the host. */
function defaultClock(): () => string {
  return () => new Date().toISOString();
}

/**
 * Default id factory: a monotonic, collision-resistant generator. Combines a
 * base-36 timestamp, a process-lifetime counter, and a small random suffix so
 * ids are unique within and across runs. Host clock/entropy is fine HERE only.
 */
function defaultIds(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    const time = Date.now().toString(36);
    const seq = counter.toString(36).padStart(4, "0");
    const rand = Math.floor(Math.random() * 0x7fffffff).toString(36);
    return `${time}-${seq}-${rand}`;
  };
}

// ────────────────────────────────────────────────────────────────────────────
// createWiki
// ────────────────────────────────────────────────────────────────────────────

export function createWiki(config: IWikiConfig): IWiki {
  const registry = new Registry(config.pageTypes);
  const services: Services = {
    now: config.clock ?? defaultClock(),
    newId: config.ids ?? defaultIds(),
  };
  const eventLog: IEventLog = new EventLog({
    baseUrl: config.stream.baseUrl,
    namespace: config.stream.namespace,
    ...(config.stream.ttlSeconds !== undefined ? { ttlSeconds: config.stream.ttlSeconds } : {}),
  });
  const busConfig: CommandBusConfig = {
    snapshotEvery: config.snapshotEvery ?? DEFAULT_SNAPSHOT_EVERY,
    ...(config.onEvent !== undefined ? { onEvent: config.onEvent } : {}),
  };
  const bus = new CommandBus(eventLog, registry, services, busConfig);

  // The default in-memory read model: fed by the same fold the
  // handle maintains off the live tail; serves token-gated reads.
  const readModel = new InMemoryReadModel(
    config.readConsistencyTimeoutMs ?? DEFAULT_READ_CONSISTENCY_TIMEOUT_MS,
  );

  // The optional full-text search index (the engine's first content projection). The
  // container injects the DB; absent ⇒ no index and `search` reads return empty.
  const searchIndex: ISearchIndex | undefined =
    config.search !== undefined
      ? new SqlSearchIndex(
          config.search.db,
          config.search.readConsistencyTimeoutMs ??
            config.readConsistencyTimeoutMs ??
            DEFAULT_READ_CONSISTENCY_TIMEOUT_MS,
        )
      : undefined;

  return new Wiki(config, registry, services, eventLog, bus, readModel, searchIndex);
}

// ────────────────────────────────────────────────────────────────────────────
// IWiki
// ────────────────────────────────────────────────────────────────────────────

class Wiki implements IWiki {
  /** Open handles, keyed by workspace id (so re-opening reuses the projection). */
  private readonly open = new Map<string, WorkspaceHandle>();

  constructor(
    private readonly config: IWikiConfig,
    private readonly registry: Registry,
    private readonly services: Services,
    private readonly eventLog: IEventLog,
    private readonly bus: CommandBus,
    private readonly readModel: InMemoryReadModel,
    private readonly searchIndex: ISearchIndex | undefined,
  ) {}

  async createWorkspace(input: { name: string; id?: WorkspaceId }): Promise<IWorkspaceHandle> {
    const id = (input.id ?? (`ws:${this.services.newId()}` as WorkspaceId)) as WorkspaceId;

    // Ensure the stream exists, then commit the creation event via the bus by
    // seeding a fresh projection at version 0.
    await this.eventLog.ensure(id);

    const projection = seedEmptyProjection(id);
    await this.bus.runStructural(projection, {
      handler: "__workspaceCreated__",
      args: { name: input.name },
      ...(this.config.actor !== undefined ? { actor: this.config.actor } : {}),
    });

    // Register in the namespace catalog (secondary index; best-effort).
    const created: CatalogEvent = {
      type: "WorkspaceRegistered",
      id,
      name: input.name,
      at: this.services.now(),
    };
    try {
      await this.eventLog.appendCatalog(created);
    } catch {
      /* catalog is a secondary index; the stream remains the source of truth */
    }

    const handle = await this.attach(id, projection);
    return handle;
  }

  async openWorkspace(id: WorkspaceId): Promise<IWorkspaceHandle> {
    const existing = this.open.get(id);
    if (existing !== undefined) return existing;

    if (!(await this.eventLog.exists(id))) {
      throw new WorkspaceNotFoundError(id);
    }

    // Read the full stream and fold from zero (keeps the FULL events[] for
    // history()). Snapshots remain a tested optimization but openWorkspace folds
    // from zero for correctness of history().
    const { events, nextCursor } = await this.eventLog.read(id);
    const state = foldWorkspace(events, this.registry);
    const projection: BusProjection = {
      state,
      cursor: nextCursor,
      eventsSinceSnapshot: 0,
      lastWriteAt: 0,
      subscribers: new Set(),
      events: [...events],
    };

    return this.attach(id, projection);
  }

  async listWorkspaces(): Promise<readonly IWorkspaceSummary[]> {
    const events = await this.eventLog.readCatalog();
    const byId = new Map<string, { id: WorkspaceId; name: string; status: WorkspaceStatus }>();
    for (const ev of events) {
      switch (ev.type) {
        case "WorkspaceRegistered":
          byId.set(ev.id, { id: ev.id, name: ev.name, status: "active" });
          break;
        case "WorkspaceRenamed": {
          const cur = byId.get(ev.id);
          if (cur !== undefined) cur.name = ev.name;
          break;
        }
        case "WorkspaceArchived": {
          const cur = byId.get(ev.id);
          if (cur !== undefined) cur.status = "archived";
          break;
        }
        case "WorkspaceUnarchived": {
          const cur = byId.get(ev.id);
          if (cur !== undefined) cur.status = "active";
          break;
        }
      }
    }
    return [...byId.values()].map((s) => ({ id: s.id, name: s.name, status: s.status }));
  }

  async close(): Promise<void> {
    for (const handle of this.open.values()) {
      handle.teardown();
      this.readModel.forget(handle.id);
      this.searchIndex?.forget(handle.id);
    }
    this.open.clear();
    await this.eventLog.close();
  }

  /**
   * The serializable status FSM of a registered page type: initial status,
   * the distinct states (initial first), and the named transitions — derived from
   * the registry's memoized guard. Pure; throws {@link UnknownPageTypeError} for an
   * unregistered type (via `registry.page`).
   */
  fsmOf(type: string): FsmDescriptor {
    const def = this.registry.page(type);
    const guard = this.registry.pageGuard(type);
    const rest = guard.states().filter((s) => s !== def.initialStatus);
    return {
      type,
      initial: def.initialStatus,
      states: [def.initialStatus, ...rest],
      transitions: guard.transitions.map((tr) => ({
        from: tr.fromState,
        event: tr.event,
        to: tr.toState,
        ...(tr.meta !== undefined ? { meta: tr.meta } : {}),
      })),
    };
  }

  /** Every registered page-type tag, in declaration order. */
  pageTypes(): readonly string[] {
    return this.registry.types();
  }

  /**
   * The TYPE-level authoring surface of a page type: its FSM plus every
   * command — declared commands (with real args schema, description, target, and the
   * FSM event they fire) then generated structural commands (args implied by target).
   * The instance-free companion to {@link PageView.describeMutations}; it deliberately
   * omits availability/preconditions, which need a folded page instance. Pure; throws
   * {@link UnknownPageTypeError} for an unregistered type (via `registry.page`).
   */
  describeType(type: string): TypeDescriptor {
    const def = this.registry.page(type);
    // The declared field-kind of a (section, field) target, when both are known — lets the
    // descriptor surface kind-specific authoring rules (e.g. blocks vs prose) generically.
    // A target's `section` may be a NESTED subsection key (generated commands record the
    // immediate subsection key), so resolve it recursively, not just at the top level.
    const findSection = (
      sections: Readonly<Record<string, SectionDecl>> | undefined,
      key: string,
    ): SectionDecl | undefined => {
      if (sections === undefined) return undefined;
      if (sections[key] !== undefined) return sections[key];
      for (const sd of Object.values(sections)) {
        const found = findSection(sd.sections, key);
        if (found !== undefined) return found;
      }
      return undefined;
    };
    const fieldKind = (section?: string, field?: string): string | undefined =>
      section !== undefined && field !== undefined ? findSection(def.sections, section)?.fields[field]?.kind : undefined;
    const commands: TypeCommandDescriptor[] = [];
    for (const [name, cmd] of Object.entries(def.commands)) {
      // Instance-free: read the edge's agency off the static transition table by event
      // name (agency is per-event-uniform in practice). Page transitions only.
      const agency =
        cmd.transition?.level === "page"
          ? def.statusTransitions.find((tr) => tr.event === cmd.transition!.event)?.meta?.agency
          : undefined;
      commands.push({
        name,
        generated: false,
        argsSchema: cmd.args.toJsonSchema(),
        ...(cmd.result !== undefined ? { resultSchema: cmd.result.toJsonSchema() } : {}),
        ...(cmd.description !== undefined ? { description: cmd.description } : {}),
        ...(cmd.target !== undefined
          ? { target: { section: cmd.target.section, ...(cmd.target.field !== undefined ? { field: cmd.target.field } : {}) } }
          : {}),
        ...(() => {
          const k = fieldKind(cmd.target?.section, cmd.target?.field);
          return k !== undefined ? { targetKind: k } : {};
        })(),
        ...(cmd.transition !== undefined ? { transition: { level: cmd.transition.level, event: cmd.transition.event } } : {}),
        ...(agency !== undefined ? { agency } : {}),
      });
    }
    for (const [name, gen] of this.registry.generatedCommands(type)) {
      const k = fieldKind(gen.section, gen.field);
      commands.push({
        name,
        generated: true,
        argsSchema: {},
        target: { section: gen.section, field: gen.field },
        ...(k !== undefined ? { targetKind: k } : {}),
      });
    }
    return {
      type,
      ...(def.label !== undefined ? { label: def.label } : {}),
      fsm: this.fsmOf(type),
      commands,
      ...(def.requiredChildren !== undefined && def.requiredChildren.length > 0
        ? { requiredChildren: def.requiredChildren }
        : {}),
    };
  }

  /**
   * Full-text search over page content across `workspaces` (default: every open
   * workspace), ranked, with highlighted snippets. Returns `[]` when no search index
   * is configured ({@link IWikiConfig.search}).
   */
  async search(
    query: string,
    opts?: {
      workspaces?: readonly WorkspaceId[];
      limit?: number;
      consistentWith?: ConsistencyToken;
      timeoutMs?: number;
    },
  ): Promise<readonly SearchHit[]> {
    if (this.searchIndex === undefined) return [];
    const workspaces = opts?.workspaces ?? ([...this.open.keys()] as WorkspaceId[]);
    const queryOpts: SearchQueryOpts = {
      ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts?.consistentWith !== undefined ? { consistentWith: opts.consistentWith } : {}),
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    };
    return this.searchIndex.query(workspaces, query, queryOpts);
  }

  /** Start the live tail, register the handle, and return it. */
  private async attach(id: WorkspaceId, projection: BusProjection): Promise<WorkspaceHandle> {
    const handle = new WorkspaceHandle(
      id,
      projection,
      this.registry,
      this.bus,
      this.config,
      this.readModel,
      this.eventLog,
      this.searchIndex,
    );
    this.open.set(id, handle);
    // Seed the read model with whatever the projection has already folded so a token
    // for an existing head is satisfiable before the first tail batch.
    this.readModel.notifyApplied(id, projection.state.version);
    await handle.startTail(this.eventLog);
    return handle;
  }
}

/** A fresh, unseeded projection used to commit `WorkspaceCreated`. */
function seedEmptyProjection(id: WorkspaceId): BusProjection {
  const state: IWorkspaceState = {
    id,
    name: "",
    status: "active",
    pages: new Map(),
    children: new Map([[ROOT, []]]),
    links: [],
    retired: new Set(),
    version: 0,
  };
  return {
    state,
    cursor: "-1",
    eventsSinceSnapshot: 0,
    lastWriteAt: 0,
    subscribers: new Set(),
    events: [],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// The "WorkspaceCreated" structural shim
// ────────────────────────────────────────────────────────────────────────────
//
// `createWorkspace` needs the bus's commit pipeline (envelope + atomic append +
// fold) for the very first event. The structural handler table only knows page
// graph verbs, so we register a tiny synthetic handler keyed "__workspaceCreated__".
// (The synthetic handler runs before the bus's "active?" check folds a name, so
// it produces the seed event unconditionally.)
(STRUCTURAL_HANDLERS as Record<string, unknown>)["__workspaceCreated__"] = (
  _state: IWorkspaceState,
  args: { name: string },
): { events: DomainEvent[]; result?: unknown } => ({
  events: [{ type: "WorkspaceCreated", payload: { name: args.name } }],
});

// ────────────────────────────────────────────────────────────────────────────
// IWorkspaceHandle
// ────────────────────────────────────────────────────────────────────────────

class WorkspaceHandle implements IWorkspaceHandle {
  readonly id: WorkspaceId;

  private readonly mutex = new Mutex();
  /** Serializes search reindex tasks off the write path (one in flight per workspace). */
  private readonly searchMutex = new Mutex();
  /** Workspace version the search index was last advanced to (advanced only on success,
   *  so a failed/dropped reindex is retried from here by the next write). */
  private lastIndexedVersion = 0;
  private tailUnsub: Unsubscribe | undefined;

  constructor(
    id: WorkspaceId,
    private readonly projection: BusProjection,
    private readonly registry: Registry,
    private readonly bus: CommandBus,
    private readonly config: IWikiConfig,
    private readonly readModel: InMemoryReadModel,
    private readonly eventLog: IEventLog,
    private readonly searchIndex: ISearchIndex | undefined,
  ) {
    this.id = id;
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────

  /** Begin a live tail that folds EXTERNAL events forward + fans out to subscribers. */
  async startTail(eventLog: IEventLog): Promise<void> {
    this.tailUnsub = await eventLog.subscribe(
      this.id,
      (events, cursor) => {
        // Serialize tail folding through the same mutex so it can't interleave
        // with a local write's commit.
        void this.mutex.run(async () => {
          for (const env of events) {
            // Skip anything already folded locally (our own writes, overlap).
            if (env.version < this.projection.state.version) continue;
            applyAndFanOut(this.projection, env, this.registry);
          }
          this.projection.cursor = cursor;
          // Advance the read model so token-gated reads see externally-tailed writes.
          this.readModel.notifyApplied(this.id, this.projection.state.version);
          // Re-index the pages an external write changed (off the write path).
          this.scheduleReindex();
        });
      },
      { fromCursor: this.projection.cursor },
    );
    // Index the already-folded head (open/catch-up) so search is current before any write.
    this.scheduleReindex();
  }

  /** Tear down the live tail (called by `wiki.close()`). */
  teardown(): void {
    this.tailUnsub?.();
    this.tailUnsub = undefined;
    this.projection.subscribers.clear();
  }

  // ── structural commands ───────────────────────────────────────────────────

  async createPage(
    type: string,
    input: { title: string; parentId: PageId | null } & Record<string, unknown>,
  ): Promise<Committed<PageId>> {
    return this.structural("createPage", {
      type,
      title: input.title,
      parentId: input.parentId,
    }) as Promise<Committed<PageId>>;
  }

  async reparent(
    pageId: PageId,
    newParentId: PageId | null,
    position?: number,
  ): Promise<Committed<void>> {
    return this.structural("reparent", {
      pageId,
      newParentId,
      ...(position !== undefined ? { position } : {}),
    }) as Promise<Committed<void>>;
  }

  async reorder(
    parentId: PageId | null,
    orderedChildIds: readonly PageId[],
  ): Promise<Committed<void>> {
    return this.structural("reorder", {
      parentId,
      orderedChildIds: [...orderedChildIds],
    }) as Promise<Committed<void>>;
  }

  async setPageTitle(pageId: PageId, title: string): Promise<Committed<void>> {
    return this.structural("setPageTitle", { pageId, title }) as Promise<Committed<void>>;
  }

  async archivePage(pageId: PageId): Promise<Committed<void>> {
    return this.structural("archivePage", { pageId }) as Promise<Committed<void>>;
  }

  async unarchivePage(pageId: PageId): Promise<Committed<void>> {
    return this.structural("unarchivePage", { pageId }) as Promise<Committed<void>>;
  }

  async link(from: PageId, to: PageId, role: string): Promise<Committed<void>> {
    return this.structural("link", { from, to, role }) as Promise<Committed<void>>;
  }

  async unlink(from: PageId, to: PageId, role: string): Promise<Committed<void>> {
    return this.structural("unlink", { from, to, role }) as Promise<Committed<void>>;
  }

  async moveItem(input: {
    from: PageId;
    to: PageId;
    section: string;
    field: string;
    itemId: string;
  }): Promise<Committed<void>> {
    return this.structural("moveItem", input) as Promise<Committed<void>>;
  }

  async rename(name: string): Promise<Committed<void>> {
    const trimmed = name.trim();
    const committed = (await this.structural("rename", { name: trimmed })) as Committed<void>;
    await this.syncCatalog({ type: "WorkspaceRenamed", id: this.id, name: trimmed, at: this.config.clock?.() ?? "" });
    return committed;
  }

  async archive(): Promise<Committed<void>> {
    const committed = (await this.structural("archive", {})) as Committed<void>;
    await this.syncCatalog({ type: "WorkspaceArchived", id: this.id, at: this.config.clock?.() ?? "" });
    return committed;
  }

  async unarchive(): Promise<Committed<void>> {
    const committed = (await this.structural("unarchive", {})) as Committed<void>;
    await this.syncCatalog({ type: "WorkspaceUnarchived", id: this.id, at: this.config.clock?.() ?? "" });
    return committed;
  }

  assignSerials(): Promise<Committed<void>> {
    return this.structural("assignSerials", {}) as Promise<Committed<void>>;
  }

  /** Mirror a rename/archive/unarchive into the namespace catalog (the secondary index
   *  `listWorkspaces` folds) so the workspace's name/status is consistent there too —
   *  best-effort, like registration: the workspace stream stays the source of truth. */
  private async syncCatalog(event: CatalogEvent): Promise<void> {
    try {
      await this.eventLog.appendCatalog(event);
    } catch {
      /* catalog is a secondary index; the workspace stream remains the source of truth */
    }
  }

  /**
   * Run a structural command under the per-workspace mutex and wrap its outcome in
   * a {@link Committed} carrying the committed-head token. After committing,
   * advance the read model so a token threaded into a subsequent read resolves.
   */
  private structural(handler: string, args: unknown): Promise<Committed<unknown>> {
    return this.mutex.run(async () => {
      const outcome = await this.bus.runStructural(this.projection, {
        handler,
        args,
        ...(this.config.actor !== undefined ? { actor: this.config.actor } : {}),
      });
      return this.commit(outcome);
    });
  }

  // ── page-scoped command ─────────────────────────────────────────────────────

  mutate(
    pageId: PageId,
    command: string,
    args: Record<string, unknown>,
  ): Promise<Committed<unknown>> {
    return this.mutex.run(async () => {
      const outcome = await this.bus.runPage(this.projection, {
        pageId,
        command,
        args,
        ...(this.config.actor !== undefined ? { actor: this.config.actor } : {}),
      });
      return this.commit(outcome);
    });
  }

  mutateMany(
    pageId: PageId,
    commands: readonly { command: string; args?: Record<string, unknown> }[],
  ): Promise<Committed<BatchResult>> {
    // One per-workspace mutex span → one bus commit → one atomic append → one token.
    return this.mutex.run(async () => {
      const outcome = await this.bus.runPageBatch(this.projection, {
        pageId,
        commands: commands.map((c) => ({ command: c.command, args: c.args ?? {} })),
        ...(this.config.actor !== undefined ? { actor: this.config.actor } : {}),
      });
      return this.commit(outcome);
    }) as Promise<Committed<BatchResult>>;
  }

  /**
   * Turn a bus {@link CommitOutcome} into the public {@link Committed} shape: notify
   * the read model of the new applied head, then mint the token for that version.
   */
  private commit(outcome: CommitOutcome): Committed<unknown> {
    this.readModel.notifyApplied(this.id, outcome.committedVersion);
    // Re-index this write's pages off the write path (best-effort, eventually consistent).
    this.scheduleReindex();
    return { value: outcome.result, token: encodeToken(this.id, outcome.committedVersion) };
  }

  /**
   * Re-index the workspace's content off the write path. The folded state and the
   * documents are snapshotted SYNCHRONOUSLY (so indexing never interleaves with a later
   * fold), and only the DB write is queued on the search mutex (so it never blocks the
   * append). The first index after a (re)open rebuilds the whole workspace; thereafter
   * only the pages a commit could have changed are re-rendered ({@link affectedPageIds}),
   * so a one-page edit costs O(affected), not O(workspace). `lastIndexedVersion` advances
   * only once the write SUCCEEDS, so a dropped best-effort reindex is retried by the next
   * write's delta (which then spans the gap).
   */
  private scheduleReindex(): void {
    const idx = this.searchIndex;
    if (idx === undefined) return;
    const state = this.projection.state;
    const version = state.version;
    const since = this.lastIndexedVersion;
    if (version <= since) return; // nothing new since the last successful index

    const advance = (): void => {
      this.lastIndexedVersion = Math.max(this.lastIndexedVersion, version);
    };
    const swallow = (err: unknown): void => {
      // Derived index, best-effort: the durable write already succeeded, so this never
      // halts the append. But a token-gated search waiting on `version` must NOT hang to
      // its timeout — fail it fast with the cause. `lastIndexedVersion` is not advanced, so
      // the next write's delta (spanning `since`) retries; that success clears the failure.
      idx.fail(this.id, version, err);
    };

    const renderOpts = { onRenderError: this.config.search?.onRenderError };

    if (since === 0) {
      // First index (open / catch-up): rebuild wholesale so any stale rows are dropped.
      const docs = renderSearchDocs(state, this.registry, renderOpts);
      void this.searchMutex.run(() => idx.reconcile(this.id, version, docs)).then(advance, swallow);
      return;
    }

    // Steady state: re-render only the pages this delta could have changed.
    const newEvents = this.projection.events.filter((e) => e.version + 1 > since);
    const affected = affectedPageIds(newEvents, state);
    const upserts = renderAffectedDocs(state, affected, this.registry, renderOpts);
    const removed = [...affected].filter((id) => !state.pages.has(id));
    void this.searchMutex.run(() => idx.update(this.id, version, upserts, removed)).then(advance, swallow);
  }

  /** Full-text search over THIS workspace's content (see {@link IWorkspaceHandle.search}). */
  async search(query: string, opts?: SearchQueryOpts): Promise<readonly SearchHit[]> {
    if (this.searchIndex === undefined) return [];
    return this.searchIndex.query([this.id], query, opts);
  }

  // ── reads (token-gated; async) ─────────────────────────────────────────

  async status(opts?: IReadOpts): Promise<WorkspaceStatus> {
    await this.awaitConsistency(opts);
    return this.projection.state.status;
  }

  async tree(opts?: IReadOpts): Promise<ITreeNode> {
    await this.awaitConsistency(opts);
    return buildTree(this.projection.state, this.registry);
  }

  async page(pageId: PageId, opts?: IReadOpts): Promise<IPageView> {
    await this.awaitConsistency(opts);
    const node = this.projection.state.pages.get(pageId);
    if (node === undefined) throw new PageNotFoundError(pageId);
    return new PageView(pageId, node.type, this);
  }

  async toMarkdown(pageId?: PageId, opts?: IReadOpts): Promise<string> {
    await this.awaitConsistency(opts);
    if (pageId === undefined) {
      return renderWorkspace(this.projection.state, this.registry);
    }
    return renderPage(this.projection.state, pageId, this.registry);
  }

  async history(opts?: IReadOpts): Promise<readonly IEventEnvelope[]> {
    await this.awaitConsistency(opts);
    return this.projection.events;
  }

  /**
   * Honor a read's consistency option: if `consistentWith` is set, wait for
   * the read model to apply that token (bounded by `timeoutMs` /
   * `readConsistencyTimeoutMs` → {@link ConsistencyTimeoutError}) before serving;
   * otherwise serve the current (eventually-consistent) projection.
   */
  async awaitConsistency(opts?: IReadOpts): Promise<void> {
    const token: ConsistencyToken | undefined = opts?.consistentWith;
    if (token === undefined) return;
    await this.readModel.waitFor(
      token,
      opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : undefined,
    );
  }

  async subscribe(handler: (event: IEventEnvelope) => void): Promise<Unsubscribe> {
    this.projection.subscribers.add(handler);
    return () => {
      this.projection.subscribers.delete(handler);
    };
  }

  // ── internal accessors for PageView ──────────────────────────────────────────

  /** Resolve a page node (or throw). */
  nodeOf(pageId: PageId): IPageNode {
    const node = this.projection.state.pages.get(pageId);
    if (node === undefined) throw new PageNotFoundError(pageId);
    return node;
  }

  /**
   * Construct a {@link IPageView} synchronously (no consistency wait) — used where
   * consistency was already honored by the caller, e.g. resolving a parent view's
   * already-awaited children.
   */
  pageViewOf(pageId: PageId): IPageView {
    const node = this.nodeOf(pageId);
    return new PageView(pageId, node.type, this);
  }

  registryRef(): Registry {
    return this.registry;
  }

  /**
   * Build the read-only {@link IRelatedReader} the command bus hands a precondition at
   * commit, over the CURRENT folded projection. Lets a read-side check
   * (e.g. {@link PageView.describeMutations}) evaluate the SAME pure preconditions a
   * write would, so reported availability matches what a commit would allow.
   */
  relatedReaderFor(self: PageId): IRelatedReader {
    const state = this.projection.state;
    return {
      self,
      page: (id: PageId): DeepReadonly<PageState> | undefined => {
        const n = state.pages.get(id);
        return n === undefined ? undefined : (pageStateView(n) as DeepReadonly<PageState>);
      },
      childrenOf: (id: PageId | RootId): readonly PageId[] => [...(state.children.get(id) ?? [])],
    };
  }

  childIdsOf(pageId: PageId | RootId): readonly PageId[] {
    return [...(this.projection.state.children.get(pageId) ?? [])];
  }

  renderPageMarkdown(pageId: PageId): string {
    return renderPage(this.projection.state, pageId, this.registry);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// IPageView
// ────────────────────────────────────────────────────────────────────────────

class PageView implements IPageView {
  readonly id: PageId;
  readonly type: string;

  constructor(id: PageId, type: string, private readonly handle: WorkspaceHandle) {
    this.id = id;
    this.type = type;
  }

  async parentId(opts?: IReadOpts): Promise<PageId | null> {
    await this.handle.awaitConsistency(opts);
    return this.handle.nodeOf(this.id).parentId;
  }

  async title(opts?: IReadOpts): Promise<string> {
    await this.handle.awaitConsistency(opts);
    return this.handle.nodeOf(this.id).title;
  }

  async children(opts?: IReadOpts): Promise<readonly IPageView[]> {
    await this.handle.awaitConsistency(opts);
    return this.handle.childIdsOf(this.id).map((childId) => this.handle.pageViewOf(childId));
  }

  async status(opts?: IReadOpts): Promise<string> {
    await this.handle.awaitConsistency(opts);
    return this.handle.nodeOf(this.id).status;
  }

  async state(opts?: IReadOpts): Promise<DeepReadonly<PageState>> {
    await this.handle.awaitConsistency(opts);
    const node = this.handle.nodeOf(this.id);
    return pageStateView(node) as DeepReadonly<PageState>;
  }

  async availableMutations(opts?: IReadOpts): Promise<readonly string[]> {
    await this.handle.awaitConsistency(opts);
    const node = this.handle.nodeOf(this.id);
    const registry = this.handle.registryRef();
    const def = registry.page(node.type);
    const guard = registry.pageGuard(node.type);
    const decls = registry.sectionDeclsOf(node.type);
    const mutableNow = (sectionKey: string): boolean => {
      const sd = decls[sectionKey];
      return sd?.mutableIn === undefined || sd.mutableIn.includes(node.status);
    };

    const out: string[] = [];
    for (const [name, cmd] of Object.entries(def.commands)) {
      if (cmd.transition?.level === "page") {
        if (guard.can(node.status, name)) out.push(name);
      } else if (cmd.target?.section !== undefined) {
        if (mutableNow(cmd.target.section)) out.push(name);
      } else {
        out.push(name);
      }
    }
    for (const [name, gen] of registry.generatedCommands(node.type)) {
      if (mutableNow(gen.section)) out.push(name);
    }
    return out;
  }

  async describeMutations(opts?: IReadOpts): Promise<readonly IMutationDescriptor[]> {
    await this.handle.awaitConsistency(opts);
    const node = this.handle.nodeOf(this.id);
    const registry = this.handle.registryRef();
    const def = registry.page(node.type);
    const guard = registry.pageGuard(node.type);
    const decls = registry.sectionDeclsOf(node.type);
    const mutableNow = (sectionKey: string): boolean => {
      const sd = decls[sectionKey];
      return sd?.mutableIn === undefined || sd.mutableIn.includes(node.status);
    };

    // The page's own folded view + a lazily-built related reader, so a command's pure
    // `preconditions` can be evaluated against current state (the same checks the bus
    // runs at commit) to decide real availability — not just FSM/gate legality.
    const view = pageStateView(node) as DeepReadonly<PageState>;
    let related: IRelatedReader | undefined;

    const descriptors: IMutationDescriptor[] = [];
    for (const [name, cmd] of Object.entries(def.commands)) {
      // Base legality: a page transition is gated by the FSM; a content command by its
      // target section's write-gate; an untargeted command is always in-gate.
      let available =
        cmd.transition?.level === "page"
          ? guard.can(node.status, name)
          : cmd.target?.section !== undefined
            ? mutableNow(cmd.target.section)
            : true;
      // Then the engine's own `requiredIn` authored-ness gate, PREDICTIVELY: resolve the
      // edge's target status and require every field declaring it to be authored — the
      // same check the bus enforces on the dry-run post-state, surfaced here as a
      // blocked-edge reason naming the `section.field` paths to author.
      let unmet: string | undefined;
      if (available && cmd.transition?.level === "page") {
        const target = guard.next(node.status, name);
        if (target !== undefined) {
          const missing = unauthoredRequiredInFields(view.sections, def, target);
          if (missing.length > 0) {
            available = false;
            unmet = `author ${missing.join(", ")} — required in status "${target}"`;
          }
        }
      }
      // Then, if still legal, every declared precondition must currently hold; the first
      // failure flips `available` off and surfaces its reason as `unmet`.
      if (available && cmd.preconditions !== undefined && cmd.preconditions.length > 0) {
        related ??= this.handle.relatedReaderFor(this.id);
        for (const pre of cmd.preconditions) {
          const res = pre(view, related);
          if (res !== true) {
            available = false;
            unmet = res.unmet;
            break;
          }
        }
      }
      // Join the model-declared agency off the FSM edge this command fires. Keyed on the
      // command `name` to match the legality check above (`guard.can(node.status, name)`),
      // so agency is present iff the edge is legal from the current status.
      const agency =
        cmd.transition?.level === "page" ? guard.meta(node.status, name)?.agency : undefined;
      const descriptor: IMutationDescriptor = {
        name,
        argsSchema: cmd.args.toJsonSchema(),
        available,
        ...(unmet !== undefined ? { unmet } : {}),
        ...(cmd.result !== undefined ? { resultSchema: cmd.result.toJsonSchema() } : {}),
        ...(cmd.description !== undefined ? { description: cmd.description } : {}),
        ...(cmd.target !== undefined
          ? { target: { section: cmd.target.section, ...(cmd.target.field !== undefined ? { field: cmd.target.field } : {}) } }
          : {}),
        ...(agency !== undefined ? { agency } : {}),
      };
      descriptors.push(descriptor);
    }
    for (const [name, gen] of registry.generatedCommands(node.type)) {
      descriptors.push({
        name,
        argsSchema: {},
        available: mutableNow(gen.section),
        target: { section: gen.section, field: gen.field },
      });
    }
    return descriptors;
  }

  async attentionItems(opts?: IReadOpts): Promise<readonly IAttentionItem[]> {
    await this.handle.awaitConsistency(opts);
    const node = this.handle.nodeOf(this.id);
    const registry = this.handle.registryRef();
    const out: IAttentionItem[] = [];
    // Walk the (flat) section tree; for each list field, look up the element decl's pure
    // awaitsHuman predicate (if declared) and flag the instances it accepts. Purely
    // structural over the model declaration — no element-type literal in the engine.
    for (const sec of node.sections) {
      for (const [field, f] of Object.entries(sec.fields)) {
        if (f.kind !== "list") continue;
        const pred = registry.element(node.type, f.elementType)?.awaitsHuman;
        if (pred === undefined) continue;
        for (const el of f.elements) {
          if (pred(el as DeepReadonly<IItem>)) {
            out.push({
              pageId: this.id,
              sectionKey: sec.key,
              field,
              elementId: el.id,
              elementType: f.elementType,
              ...(el.status !== undefined ? { status: el.status } : {}),
            });
          }
        }
      }
    }
    return out;
  }

  async toMarkdown(opts?: IReadOpts): Promise<string> {
    await this.handle.awaitConsistency(opts);
    return this.handle.renderPageMarkdown(this.id);
  }

  mutate(command: string, args: Record<string, unknown>): Promise<Committed<unknown>> {
    return this.handle.mutate(this.id, command, args);
  }

  mutateMany(commands: readonly { command: string; args?: Record<string, unknown> }[]): Promise<Committed<BatchResult>> {
    return this.handle.mutateMany(this.id, commands);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Read helpers
// ────────────────────────────────────────────────────────────────────────────

/** Fold one external (tail) event into the projection and fan it out. */
function applyAndFanOut(
  projection: BusProjection,
  env: IEventEnvelope,
  registry: Registry,
): void {
  applyWorkspace(projection.state, env, registry);
  projection.state.version = env.version + 1;
  projection.events.push(env);
  for (const sub of projection.subscribers) {
    try {
      sub(env);
    } catch {
      /* subscribers must not break the tail */
    }
  }
}

/** Build the ordered page tree rooted at the ROOT sentinel. */
function buildTree(state: IWorkspaceState, registry: Registry): ITreeNode {
  const visit = (id: PageId): ITreeNode => {
    const node = state.pages.get(id);
    const childIds = state.children.get(id) ?? [];
    // The display title is the type's `render.title` template filled with the node's own
    // title + field values; surface it only when it differs from the raw title.
    const display = node !== undefined ? displayTitle(node, registry) : undefined;
    return {
      id,
      title: node?.title ?? id,
      ...(display !== undefined && display !== node?.title ? { displayTitle: display } : {}),
      ...(node !== undefined ? { type: node.type, status: node.status } : {}),
      ...(node?.archived === true ? { archived: true } : {}),
      ...(node?.updatedAt !== undefined ? { updatedAt: node.updatedAt } : {}),
      children: childIds.map(visit),
    };
  };
  const roots = state.children.get(ROOT) ?? [];
  return {
    id: ROOT,
    title: state.name,
    children: roots.map(visit),
  };
}
