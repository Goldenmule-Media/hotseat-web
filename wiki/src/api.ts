/**
 * PUBLIC TYPE SURFACE (DESIGN §10). Types only — no runtime code lives here.
 * Everything depends on this module; this module depends on nothing.
 *
 * Type-level helpers (PageTypeName, CommandName<K>, …) are pragmatic v1 aliases:
 * runtime safety comes from Zod arg-validation + the FSM guard. Full per-registry
 * inference is deferred (DESIGN §10.4 note / §18).
 */

// ────────────────────────────────────────────────────────────────────────────
// Branded ids
// ────────────────────────────────────────────────────────────────────────────

export type WorkspaceId = string & { readonly __brand: "WorkspaceId" };
export type PageId = string & { readonly __brand: "PageId" };

/** Sentinel parent key for top-level pages in the children map / tree. */
export const ROOT = "@root" as const;
export type RootId = typeof ROOT;

// ────────────────────────────────────────────────────────────────────────────
// Generic helpers
// ────────────────────────────────────────────────────────────────────────────

export type JsonSchema = Record<string, unknown>;

export type DeepReadonly<T> = T extends (infer U)[]
  ? ReadonlyArray<DeepReadonly<U>>
  : T extends Map<infer K, infer V>
    ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export type Unsubscribe = () => void;

// ────────────────────────────────────────────────────────────────────────────
// CQRS consistency tokens & read model (DESIGN §8.6, ADR-003)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Opaque, comparable token marking a position in a workspace's history. Encodes
 * `{ workspaceId, version }` — `version` being the per-workspace 0-based sequence
 * (== stream length; drives fold order & OCC, §8.1). Compared **within a single
 * workspace only**; cross-workspace tokens are independent.
 */
export type ConsistencyToken = string;

/**
 * The return shape of **every** write (DESIGN §8.6): the command's `value` plus a
 * {@link ConsistencyToken} naming the committed head `version` after the append and
 * any OCC rebase-retry. A void write resolves to `Committed<void>` — the token still
 * names where the events landed so a caller can read the mutated graph back.
 */
export interface Committed<T> {
  readonly value: T;
  readonly token: ConsistencyToken;
}

/**
 * Optional read consistency for a token-gated read (DESIGN §8.6). With
 * `consistentWith` present, the read `waitFor`s the read model to apply that token
 * before serving (read-your-writes / monotonic); absent, it serves the current
 * (possibly stale) projection.
 */
export interface IReadOpts {
  /** A token from a prior write: `waitFor` the read model to apply it before serving. */
  readonly consistentWith?: ConsistencyToken;
  /** Override the default `waitFor` timeout (`IWikiConfig.readConsistencyTimeoutMs`, default 5000 ms). */
  readonly timeoutMs?: number;
}

/**
 * The read-side seam (DESIGN §8.6). Any projection — the default in-memory one or an
 * external one (e.g. a SQL read model) — implements this so a read can wait until the
 * read side has caught up to a write's token.
 */
export interface IReadModel {
  /** How far this read model has applied, for a workspace (the zero token if unknown). */
  appliedToken(workspace: WorkspaceId): Promise<ConsistencyToken>;
  /** Resolve once applied ≥ `token`; reject with `ConsistencyTimeoutError` after `timeoutMs`. */
  waitFor(token: ConsistencyToken, opts?: { timeoutMs?: number }): Promise<void>;
}

// ────────────────────────────────────────────────────────────────────────────
// Event sourcing (DESIGN §8.1)
// ────────────────────────────────────────────────────────────────────────────

export interface IEventMeta {
  /** ISO-8601, from the injected Clock (never Date.now() at render). */
  readonly occurredAt: string;
  readonly actor?: string;
  /** Idempotency: the command that produced this event. */
  readonly commandId?: string;
  readonly causationId?: string;
  readonly correlationId?: string;
}

export interface IEventEnvelope<T extends string = string, P = unknown> {
  readonly eventId: string;
  /** The aggregate == the workspace. */
  readonly streamId: WorkspaceId;
  /** The page this event targets (absent for pure workspace/structural events). */
  readonly pageId?: PageId;
  /** 0-based per-WORKSPACE sequence; defines fold order & drives OCC. */
  readonly version: number;
  readonly type: T;
  /** Schema version the payload was written under (DESIGN §8.5). */
  readonly schemaVersion: number;
  readonly payload: P;
  readonly meta: IEventMeta;
}

/** Base domain event union: the minimum a page-type reducer/decider produces. */
export interface DomainEvent {
  readonly type: string;
  readonly pageId?: PageId;
  readonly payload?: unknown;
}

// ────────────────────────────────────────────────────────────────────────────
// Workspace aggregate state (DESIGN §6.2)
// ────────────────────────────────────────────────────────────────────────────

export type WorkspaceStatus = "active" | "archived";

export interface IItemRecord {
  readonly id: string;
  status?: string;
  /** + typed fields per item type. */
  [field: string]: unknown;
}

export interface IPageNode {
  readonly id: PageId;
  readonly type: string;
  parentId: PageId | null;
  title: string;
  status: string;
  /** Typed per page type (the page's `fields`). */
  fields: unknown;
  /** e.g. { component: [...], question: [...], commit: [...] }. */
  items: Record<string, IItemRecord[]>;
  /** Page types auto-created with this page and pinned (cannot reparent-out / archive alone). */
  pinned?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IWorkspaceState {
  id: WorkspaceId;
  name: string;
  status: WorkspaceStatus;
  /** every page by id. */
  pages: Map<PageId, IPageNode>;
  /** ordered children → the tree (key is parent id or ROOT). */
  children: Map<PageId | RootId, PageId[]>;
  /** graph edges beyond the tree. */
  links: { from: PageId; to: PageId; role: string }[];
  /** per-workspace, == stream length (event count). */
  version: number;
}

/**
 * The page state shape passed to a page type's reducer/decider/renderer.
 * `F` is the page type's typed `fields`.
 */
export interface PageState<F = unknown> {
  readonly id: PageId;
  readonly type: string;
  parentId: PageId | null;
  title: string;
  status: string;
  fields: F;
  items: Record<string, IItemRecord[]>;
  createdAt: string;
  updatedAt: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Entry point & configuration (DESIGN §10.1)
// ────────────────────────────────────────────────────────────────────────────

export interface IStreamConfig {
  /** Base URL of the Durable Streams server, e.g. "http://127.0.0.1:4437". */
  readonly baseUrl: string;
  /** Namespace/tenant segment: streams live at `{baseUrl}/{namespace}/workspace/{id}`. */
  readonly namespace: string;
  /** Optional stream TTL (seconds). Omit for infinite retention (the default). */
  readonly ttlSeconds?: number;
}

export interface IWikiConfig {
  readonly stream: IStreamConfig;
  /** The page types this wiki understands. An unknown `type` is rejected at `createPage`. */
  readonly pageTypes: readonly IPageType[];
  /** Current time as ISO-8601. Injected for determinism/testing. @default () => new Date().toISOString() */
  readonly clock?: () => string;
  /** Unique id generator (workspace/page/item/event). Injected for determinism/testing. @default ULID-ish */
  readonly ids?: () => string;
  /** Default `actor` stamped on event metadata when a call doesn't override it. */
  readonly actor?: string;
  /** Snapshot after this many events per workspace, or 0 to disable count-based snapshots. @default 100 */
  readonly snapshotEvery?: number;
  /** Snapshot after this many ms of write-idle. @default 5000 */
  readonly snapshotIdleMs?: number;
  /** Default timeout (ms) for a token-gated read's `waitFor` before it throws
   *  {@link ConsistencyTimeoutError}; a per-read `timeoutMs` overrides it. @default 5000 @see §8.6 */
  readonly readConsistencyTimeoutMs?: number;
  /** Bound the in-memory projection cache, or `false` to disable caching. */
  readonly cache?: { readonly maxWorkspaces?: number } | false;
  /** Optional sink for every appended event (logging/metrics). Must not throw. */
  readonly onEvent?: (event: IEventEnvelope) => void;
}

// ────────────────────────────────────────────────────────────────────────────
// IWiki (DESIGN §10.2)
// ────────────────────────────────────────────────────────────────────────────

export interface IWorkspaceSummary {
  readonly id: WorkspaceId;
  readonly name: string;
  readonly status: WorkspaceStatus;
}

export interface IWiki {
  createWorkspace(input: { name: string; id?: WorkspaceId }): Promise<IWorkspaceHandle>;
  openWorkspace(id: WorkspaceId): Promise<IWorkspaceHandle>;
  listWorkspaces(): Promise<readonly IWorkspaceSummary[]>;
  close(): Promise<void>;
}

// ────────────────────────────────────────────────────────────────────────────
// Type-level helpers derived (pragmatically) from the page-type registry
// ────────────────────────────────────────────────────────────────────────────

export type PageTypeName = string;
export type StatusOf<K extends PageTypeName = PageTypeName> = string;
export type CommandName<K extends PageTypeName = PageTypeName> = string;
export type CommandArgs<K extends PageTypeName = PageTypeName, C extends CommandName<K> = CommandName<K>> =
  Record<string, unknown>;
export type CommandResult<K extends PageTypeName = PageTypeName, C extends CommandName<K> = CommandName<K>> =
  unknown;
export type CreateArgs<K extends PageTypeName = PageTypeName> = Record<string, unknown>;

// ────────────────────────────────────────────────────────────────────────────
// IWorkspaceHandle (DESIGN §10.3)
// ────────────────────────────────────────────────────────────────────────────

export interface ITreeNode {
  readonly id: PageId | RootId;
  readonly title: string;
  readonly type?: PageTypeName;
  readonly status?: string;
  readonly children: readonly ITreeNode[];
}

export interface IWorkspaceHandle {
  readonly id: WorkspaceId;

  // ── structural commands (atomic; guarded by invariants + workspace/page status) ──
  // Every write resolves to a {@link Committed} value carrying the committed-head
  // {@link ConsistencyToken} — the position after the append AND any OCC rebase-retry (§8.6).
  createPage<K extends PageTypeName>(
    type: K,
    input: { title: string; parentId: PageId | null } & CreateArgs<K>,
  ): Promise<Committed<PageId>>;
  reparent(pageId: PageId, newParentId: PageId | null, position?: number): Promise<Committed<void>>;
  reorder(parentId: PageId | null, orderedChildIds: readonly PageId[]): Promise<Committed<void>>;
  setPageTitle(pageId: PageId, title: string): Promise<Committed<void>>;
  archivePage(pageId: PageId): Promise<Committed<void>>;
  link(from: PageId, to: PageId, role: string): Promise<Committed<void>>;
  unlink(from: PageId, to: PageId, role: string): Promise<Committed<void>>;
  moveItem(input: { from: PageId; to: PageId; itemType: string; itemId: string }): Promise<Committed<void>>;
  archive(): Promise<Committed<void>>;

  // ── page-scoped content/status command ──
  mutate<K extends PageTypeName, C extends CommandName<K>>(
    pageId: PageId,
    command: C,
    args: CommandArgs<K, C>,
  ): Promise<Committed<CommandResult<K, C>>>;

  // ── reads (token-gated; async — §8.6) ──
  // Pass `consistentWith` a write's token to read-your-writes (waits up to `timeoutMs`,
  // default IWikiConfig.readConsistencyTimeoutMs); omit it for current/eventually-consistent state.
  status(opts?: IReadOpts): Promise<WorkspaceStatus>;
  tree(opts?: IReadOpts): Promise<ITreeNode>;
  page(pageId: PageId, opts?: IReadOpts): Promise<IPageView>;
  toMarkdown(pageId?: PageId, opts?: IReadOpts): Promise<string>;
  history(opts?: IReadOpts): Promise<readonly IEventEnvelope[]>;

  // ── live updates (G6) ──
  subscribe(handler: (event: IEventEnvelope) => void): Promise<Unsubscribe>;
}

// ────────────────────────────────────────────────────────────────────────────
// IPageView (DESIGN §10.4)
// ────────────────────────────────────────────────────────────────────────────

export interface IMutationDescriptor {
  readonly name: string;
  readonly argsSchema: JsonSchema;
  readonly resultSchema?: JsonSchema;
  /** Whether the command is legal in the page's current status right now. */
  readonly available: boolean;
  readonly description?: string;
}

export interface IPageView<K extends PageTypeName = PageTypeName> {
  readonly id: PageId;
  readonly type: K;
  // Reads are token-gated and async (§8.6): pass `consistentWith` a write's token to
  // read-your-writes, or omit it for current state.
  parentId(opts?: IReadOpts): Promise<PageId | null>;
  title(opts?: IReadOpts): Promise<string>;
  children(opts?: IReadOpts): Promise<readonly IPageView[]>;
  status(opts?: IReadOpts): Promise<StatusOf<K>>;
  state(opts?: IReadOpts): Promise<DeepReadonly<PageState>>;
  availableMutations(opts?: IReadOpts): Promise<readonly CommandName<K>[]>;
  describeMutations(opts?: IReadOpts): Promise<readonly IMutationDescriptor[]>;
  toMarkdown(opts?: IReadOpts): Promise<string>;
  mutate<C extends CommandName<K>>(command: C, args: CommandArgs<K, C>): Promise<Committed<CommandResult<K, C>>>;
}

// ────────────────────────────────────────────────────────────────────────────
// FSM transition (DESIGN §7.2 / §10.5) — `t()` & `makeGuard()` live in core/guard.ts
// ────────────────────────────────────────────────────────────────────────────

export interface ITransition<S extends string = string, C extends string = string> {
  readonly fromState: S;
  readonly event: C;
  readonly toState: S;
  readonly meta?: { readonly description?: string };
}

// ────────────────────────────────────────────────────────────────────────────
// Authoring API (DESIGN §10.5)
// ────────────────────────────────────────────────────────────────────────────

/** Adapter over a runtime validator (Zod by default): parse + export JSON Schema. */
export interface ISchema<T = unknown> {
  /** Throws {@link ValidationError} on failure. */
  parse(input: unknown): T;
  toJsonSchema(): JsonSchema;
}

/**
 * Context passed to a command's `produces`. Pure: no I/O.
 * `related` exposes read-only access to OTHER pages in the same workspace so a
 * command can enforce cross-page invariants atomically (DESIGN §13.4) — e.g.
 * `beginImplementation` reading the implementation-plan's steps.
 */
export interface ICommandContext {
  /** Generate a fresh id (e.g. for a new item). */
  readonly newId: () => string;
  /** The command's occurrence time (ISO-8601). */
  readonly now: string;
  readonly actor?: string;
  readonly commandId?: string;
  /** Read-only view of related pages/structure for cross-page invariants. */
  readonly related: IRelatedReader;
}

export interface IRelatedReader {
  page(id: PageId): DeepReadonly<PageState> | undefined;
  childrenOf(id: PageId | RootId): readonly PageId[];
  /** The id of the page currently being mutated. */
  readonly self: PageId;
}

/** Read-only workspace context passed to a renderer (DESIGN §11). */
export interface IRenderCtx {
  titleOf(id: PageId): string | undefined;
  typeOf(id: PageId): string | undefined;
  statusOf(id: PageId): string | undefined;
  childrenOf(id: PageId | RootId): readonly PageId[];
  linksOf(id: PageId): readonly { readonly to: PageId; readonly role: string }[];
  backlinksOf(id: PageId): readonly { readonly from: PageId; readonly role: string }[];
}

/** One page-scoped command: typed args, optional result, an FSM transition, a pure decider. */
export interface ICommandDef<State = unknown, Args = unknown, Result = unknown, Ev extends DomainEvent = DomainEvent> {
  readonly args: ISchema<Args>;
  readonly result?: ISchema<Result>;
  /** The transition this command represents — page-level, or delegated to an item's FSM. */
  readonly transition:
    | { readonly level: "page"; readonly event: string }
    | { readonly level: "item"; readonly itemType: string; readonly idArg: string; readonly event: string };
  /** Pure decision: check invariants, return events to append + the typed result. No I/O. */
  readonly produces: (page: PageState<State>, args: Args, ctx: ICommandContext) => { events: Ev[]; result: Result };
}

export type CommandMap = Readonly<Record<string, ICommandDef<any, any, any, any>>>;

/** Full specification of a page entity (DESIGN §6.3). */
export interface IPageTypeDef<
  State = unknown,
  Status extends string = string,
  Cmds extends CommandMap = CommandMap,
  Ev extends DomainEvent = DomainEvent,
> {
  /** Stable type tag, also the page-id prefix (e.g. "feature-brief"). */
  readonly type: string;
  /** Status assigned when a page of this type is created. */
  readonly initialStatus: Status;
  /** Initial `fields` value for a freshly-created page of this type. */
  readonly initialFields: State;
  /** Current schema version for this type's events (DESIGN §8.5). */
  readonly version: number;
  /** Upcasters keyed by from-version, composed on fold to migrate old payloads up to `version`. */
  readonly upcasters?: Readonly<Record<number, (payload: unknown) => unknown>>;
  /** The page lifecycle FSM, built with {@link t}. Include self-transitions for content edits. */
  readonly statusTransitions: readonly ITransition<Status, Extract<keyof Cmds, string>>[];
  /** Item types this page may contain, keyed by item-type tag. */
  readonly items?: Readonly<Record<string, IItemType>>;
  /** Page types auto-created (atomically) as pinned children whenever a page of this type is created. */
  readonly requiredChildren?: readonly string[];
  /** Page-scoped commands, keyed by command name. */
  readonly commands: Cmds;
  /** Pure reducer: fold one event into this page's state. Total, no I/O. */
  readonly apply: (page: PageState<State>, event: Ev) => PageState<State>;
  /** Deterministic Markdown renderer for a page of this type (DESIGN §11). */
  readonly render: (page: PageState<State>, ctx: IRenderCtx) => string;
}

/** Full specification of an item entity (DESIGN §6.4). */
export interface IItemTypeDef<Status extends string = never> {
  readonly type: string;
  readonly initialStatus?: Status;
  readonly statusTransitions?: readonly ITransition<Status, string>[];
}

/** Opaque registration objects returned by the `define*` helpers. */
export interface IPageType<
  State = any,
  Status extends string = string,
  Cmds extends CommandMap = CommandMap,
  Ev extends DomainEvent = DomainEvent,
> {
  readonly __def: IPageTypeDef<State, Status, Cmds, Ev>;
}

export interface IItemType<Status extends string = string> {
  readonly __def: IItemTypeDef<Status>;
}
