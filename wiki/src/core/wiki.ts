/**
 * `createWiki` — the public entry point (DESIGN §10.1–§10.4; BUILD_NOTES §8).
 *
 * Wires the engine together: builds the {@link Registry}, the injected
 * {@link Services} (clock + id generation — the ONLY place a host clock / entropy
 * is allowed, since reducers/deciders/renderers receive time + ids via the
 * services), the {@link EventLog}, and a {@link CommandBus}. Returns an {@link IWiki}
 * that creates/opens/lists workspaces and a concrete {@link IWorkspaceHandle} +
 * {@link IPageView} over an in-memory projection kept fresh by a live tail.
 *
 * Per-workspace writes are serialized through a tiny promise-chain {@link Mutex}
 * so one process never races itself (DESIGN §15); cross-process conflicts are
 * resolved by the bus's rebase-and-retry.
 */
import type {
  DeepReadonly,
  DomainEvent,
  IEventEnvelope,
  IMutationDescriptor,
  IPageNode,
  IPageView,
  ITreeNode,
  IWiki,
  IWikiConfig,
  IWorkspaceHandle,
  IWorkspaceState,
  IWorkspaceSummary,
  PageId,
  PageState,
  RootId,
  Unsubscribe,
  WorkspaceId,
  WorkspaceStatus,
} from "../api";
import { ROOT } from "../api";
import { renderPage, renderWorkspace } from "../render/markdown";
import { EventLog } from "../stores/event-log";
import { CommandBus, type BusProjection, type CommandBusConfig } from "./command-bus";
import { PageNotFoundError, WorkspaceNotFoundError } from "./errors";
import { Registry } from "./registry";
import { STRUCTURAL_HANDLERS } from "./structure";
import type { CatalogEvent, IEventLog, Services } from "./types";
import { applyWorkspace, foldWorkspace, pageStateView } from "./workspace";

/** Defaults from {@link IWikiConfig}. */
const DEFAULT_SNAPSHOT_EVERY = 100;

// ────────────────────────────────────────────────────────────────────────────
// Mutex — a minimal promise-chain serializer (DESIGN §15)
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

  return new Wiki(config, registry, services, eventLog, bus);
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
    // from zero for correctness of history() (BUILD_NOTES §8).
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
      }
    }
    return [...byId.values()].map((s) => ({ id: s.id, name: s.name, status: s.status }));
  }

  async close(): Promise<void> {
    for (const handle of this.open.values()) handle.teardown();
    this.open.clear();
    await this.eventLog.close();
  }

  /** Start the live tail, register the handle, and return it. */
  private async attach(id: WorkspaceId, projection: BusProjection): Promise<WorkspaceHandle> {
    const handle = new WorkspaceHandle(id, projection, this.registry, this.bus, this.config);
    this.open.set(id, handle);
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
  private tailUnsub: Unsubscribe | undefined;

  constructor(
    id: WorkspaceId,
    private readonly projection: BusProjection,
    private readonly registry: Registry,
    private readonly bus: CommandBus,
    private readonly config: IWikiConfig,
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
        });
      },
      { fromCursor: this.projection.cursor },
    );
  }

  /** Tear down the live tail (called by `wiki.close()`). */
  teardown(): void {
    this.tailUnsub?.();
    this.tailUnsub = undefined;
    this.projection.subscribers.clear();
  }

  // ── structural commands ───────────────────────────────────────────────────

  createPage(
    type: string,
    input: { title: string; parentId: PageId | null } & Record<string, unknown>,
  ): Promise<PageId> {
    return this.structural("createPage", {
      type,
      title: input.title,
      parentId: input.parentId,
    }) as Promise<PageId>;
  }

  async reparent(pageId: PageId, newParentId: PageId | null, position?: number): Promise<void> {
    await this.structural("reparent", {
      pageId,
      newParentId,
      ...(position !== undefined ? { position } : {}),
    });
  }

  async reorder(parentId: PageId | null, orderedChildIds: readonly PageId[]): Promise<void> {
    await this.structural("reorder", { parentId, orderedChildIds: [...orderedChildIds] });
  }

  async setPageTitle(pageId: PageId, title: string): Promise<void> {
    await this.structural("setPageTitle", { pageId, title });
  }

  async archivePage(pageId: PageId): Promise<void> {
    await this.structural("archivePage", { pageId });
  }

  async link(from: PageId, to: PageId, role: string): Promise<void> {
    await this.structural("link", { from, to, role });
  }

  async unlink(from: PageId, to: PageId, role: string): Promise<void> {
    await this.structural("unlink", { from, to, role });
  }

  async moveItem(input: {
    from: PageId;
    to: PageId;
    itemType: string;
    itemId: string;
  }): Promise<void> {
    await this.structural("moveItem", input);
  }

  async archive(): Promise<void> {
    await this.structural("archive", {});
  }

  /** Run a structural command under the per-workspace mutex. */
  private structural(handler: string, args: unknown): Promise<unknown> {
    return this.mutex.run(() =>
      this.bus.runStructural(this.projection, {
        handler,
        args,
        ...(this.config.actor !== undefined ? { actor: this.config.actor } : {}),
      }),
    );
  }

  // ── page-scoped command ─────────────────────────────────────────────────────

  mutate(pageId: PageId, command: string, args: Record<string, unknown>): Promise<unknown> {
    return this.mutex.run(() =>
      this.bus.runPage(this.projection, {
        pageId,
        command,
        args,
        ...(this.config.actor !== undefined ? { actor: this.config.actor } : {}),
      }),
    );
  }

  // ── reads ───────────────────────────────────────────────────────────────────

  status(): WorkspaceStatus {
    return this.projection.state.status;
  }

  tree(): ITreeNode {
    return buildTree(this.projection.state);
  }

  page(pageId: PageId): IPageView {
    const node = this.projection.state.pages.get(pageId);
    if (node === undefined) throw new PageNotFoundError(pageId);
    return new PageView(pageId, node.type, this);
  }

  toMarkdown(pageId?: PageId): string {
    if (pageId === undefined) {
      return renderWorkspace(this.projection.state, this.registry);
    }
    return renderPage(this.projection.state, pageId, this.registry);
  }

  history(): readonly IEventEnvelope[] {
    return this.projection.events;
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

  registryRef(): Registry {
    return this.registry;
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

  parentId(): PageId | null {
    return this.handle.nodeOf(this.id).parentId;
  }

  title(): string {
    return this.handle.nodeOf(this.id).title;
  }

  children(): readonly IPageView[] {
    return this.handle.childIdsOf(this.id).map((childId) => this.handle.page(childId));
  }

  status(): string {
    return this.handle.nodeOf(this.id).status;
  }

  state(): DeepReadonly<PageState> {
    const node = this.handle.nodeOf(this.id);
    return pageStateView(node) as DeepReadonly<PageState>;
  }

  availableMutations(): readonly string[] {
    const node = this.handle.nodeOf(this.id);
    return this.handle.registryRef().pageGuard(node.type).available(node.status);
  }

  describeMutations(): readonly IMutationDescriptor[] {
    const node = this.handle.nodeOf(this.id);
    const registry = this.handle.registryRef();
    const def = registry.page(node.type);
    const guard = registry.pageGuard(node.type);
    const available = new Set(guard.available(node.status));

    const descriptors: IMutationDescriptor[] = [];
    for (const [name, cmd] of Object.entries(def.commands)) {
      const meta = guard.meta(node.status, name);
      const descriptor: IMutationDescriptor = {
        name,
        argsSchema: cmd.args.toJsonSchema(),
        available: available.has(name),
        ...(cmd.result !== undefined ? { resultSchema: cmd.result.toJsonSchema() } : {}),
        ...(meta?.description !== undefined ? { description: meta.description } : {}),
      };
      descriptors.push(descriptor);
    }
    return descriptors;
  }

  toMarkdown(): string {
    return this.handle.renderPageMarkdown(this.id);
  }

  mutate(command: string, args: Record<string, unknown>): Promise<unknown> {
    return this.handle.mutate(this.id, command, args);
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
function buildTree(state: IWorkspaceState): ITreeNode {
  const visit = (id: PageId): ITreeNode => {
    const node = state.pages.get(id);
    const childIds = state.children.get(id) ?? [];
    return {
      id,
      title: node?.title ?? id,
      ...(node !== undefined ? { type: node.type, status: node.status } : {}),
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
