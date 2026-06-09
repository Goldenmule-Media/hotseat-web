/**
 * PUBLIC TYPE SURFACE. Types only — no runtime code lives here.
 * Everything depends on this module; this module depends on nothing.
 *
 * Type-level helpers (PageTypeName, CommandName<K>, …) are pragmatic v1 aliases:
 * runtime safety comes from Zod arg-validation + the FSM guard. Full per-registry
 * inference is deferred.
 *
 * One exception to "depends on nothing": the optional full-text search seam references
 * the search index's public types (which ride on Kysely — the engine's one sanctioned
 * external dependency). These are type-only imports, erased at runtime.
 */
import type { IWikiSearchConfig, SearchHit, SearchQueryOpts } from "./search/schema";

// ────────────────────────────────────────────────────────────────────────────
// Branded ids
// ────────────────────────────────────────────────────────────────────────────

export type WorkspaceId = string & { readonly __brand: "WorkspaceId" };
export type PageId = string & { readonly __brand: "PageId" };
export type SectionId = string & { readonly __brand: "SectionId" };
export type BlockId = string & { readonly __brand: "BlockId" };

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
// CQRS consistency tokens & read model (ADR-003)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Opaque, comparable token marking a position in a workspace's history. Encodes
 * `{ workspaceId, version }` — `version` being the per-workspace 0-based sequence
 * (== stream length; drives fold order & OCC). Compared **within a single
 * workspace only**; cross-workspace tokens are independent.
 */
export type ConsistencyToken = string;

/**
 * The return shape of **every** write: the command's `value` plus a
 * {@link ConsistencyToken} naming the committed head `version` after the append and
 * any OCC rebase-retry. A void write resolves to `Committed<void>` — the token still
 * names where the events landed so a caller can read the mutated graph back.
 */
export interface Committed<T> {
  readonly value: T;
  readonly token: ConsistencyToken;
}

/**
 * Optional read consistency for a token-gated read. With
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
 * The read-side seam. Any projection — the default in-memory one or an
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
// Event sourcing
// ────────────────────────────────────────────────────────────────────────────

export interface IEventMeta {
  /** ISO-8601, from the injected Clock (never Date.now() at render). */
  readonly occurredAt: string;
  readonly actor?: string;
  /** Idempotency: the command that produced this event. */
  readonly commandId?: string;
  /** The semantic command name that produced this content event — keeps
   *  history semantic (`answerQuestion`) without per-type events. */
  readonly command?: string;
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
  /** Schema version the payload was written under. */
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
// Workspace aggregate state
// ────────────────────────────────────────────────────────────────────────────

export type WorkspaceStatus = "active" | "archived";

// ────────────────────────────────────────────────────────────────────────────
// Content tree: Sections, Fields, Items, Blocks
// ────────────────────────────────────────────────────────────────────────────

/** Closed, engine-owned field-kind vocabulary. */
export type FieldKind =
  | "scalar"
  | "prose"
  | "code"
  | "attachment-ref"
  | "ref"
  | "blocks"
  | "list";

/**
 * A typed cross-reference target; the displayed label is render-derived.
 *
 * Every non-`page` kind carries an OPTIONAL `page?: PageId`: omitted = same page (the
 * historical behaviour), present = a CROSS-PAGE ref into that page's content. The
 * `element` kind addresses a list `IItem` by its stable id — the one content node no
 * ref could previously point at — and carries an optional `labelField` naming which of
 * the element's fields supplies the render-derived label (explicit, never object-key
 * order). Together these let a page reference a decision/step/case on a sibling page.
 */
export type RefTarget =
  | { readonly kind: "section"; page?: PageId; id: SectionId }
  | { readonly kind: "page"; id: PageId }
  | { readonly kind: "symbol"; page?: PageId; section: SectionId; field: string; name: string }
  | { readonly kind: "block"; page?: PageId; section: SectionId; field: string; block: BlockId }
  | { readonly kind: "element"; page?: PageId; section: SectionId; field: string; element: string; labelField?: string };

/** A `text` run's overlapping inline style, carried as a canonical-sorted set. */
export type Mark = "strong" | "emphasis" | { readonly kind: "link"; href: string };

/** Inline run inside a prose-bearing block. */
export type IInline =
  | { readonly kind: "text"; value: string; marks: Mark[] }
  | { readonly kind: "code-span"; value: string }
  | { readonly kind: "ref"; target: RefTarget };

/** Closed document block vocabulary. Each carries an injected `BlockId`. */
export type IBlock =
  | { readonly kind: "paragraph"; id: BlockId; inlines: IInline[] }
  | { readonly kind: "heading"; id: BlockId; level: 1 | 2 | 3 | 4 | 5 | 6; inlines: IInline[] }
  | { readonly kind: "code"; id: BlockId; lang: string; source: string; hash: string }
  | { readonly kind: "list"; id: BlockId; ordered: boolean; items: IBlock[][] }
  | {
      readonly kind: "table";
      id: BlockId;
      align: ("left" | "center" | "right" | null)[];
      header: IInline[][];
      rows: IInline[][][];
    }
  | { readonly kind: "quote"; id: BlockId; variant?: string; blocks: IBlock[] }
  | { readonly kind: "divider"; id: BlockId };

/** A typed field value — the closed value shapes per field-kind. */
export type IField =
  | { readonly kind: "scalar"; value: string | number | boolean }
  | { readonly kind: "prose"; value: string }
  | { readonly kind: "code"; lang: string; source: string; hash: string }
  | { readonly kind: "attachment-ref"; ref: string; mime: string; name: string }
  | { readonly kind: "ref"; target: RefTarget }
  | { readonly kind: "blocks"; blocks: IBlock[] }
  | { readonly kind: "list"; elementType: string; elements: IItem[] };

/** A list element (item): an id, an optional model FSM status, typed fields, optional meta. */
export interface IItem {
  readonly id: string;
  status?: string;
  fields: Record<string, IField>;
  meta?: Record<string, unknown>;
}

/** An addressable, contract-bearing node in a page's content tree. */
export interface ISection {
  readonly id: SectionId;
  /** Stable, model-declared; unique among siblings. */
  key: string;
  name: string;
  description?: string;
  /** Explicit ordering — never object-key order. */
  order: number;
  /** Intra-page section tree parent. */
  parentId: SectionId | null;
  fields: Record<string, IField>;
  meta?: Record<string, unknown>;
}

export interface IPageNode {
  readonly id: PageId;
  readonly type: string;
  parentId: PageId | null;
  title: string;
  status: string;
  /** The page's content tree — ordered typed sections. */
  sections: ISection[];
  /** Page types auto-created with this page and pinned (cannot reparent-out / archive alone). */
  pinned?: boolean;
  /** Hidden from default tree/sidebar views; orthogonal to the lifecycle `status`. Reversible via unarchive. */
  archived?: boolean;
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
 * The page state shape passed to the engine reducer / deciders / render read model.
 * Content is the typed section tree — no `fields`/`items` containers.
 */
export interface PageState {
  readonly id: PageId;
  readonly type: string;
  parentId: PageId | null;
  title: string;
  status: string;
  sections: ISection[];
  createdAt: string;
  updatedAt: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Entry point & configuration
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
   *  {@link ConsistencyTimeoutError}; a per-read `timeoutMs` overrides it. @default 5000 */
  readonly readConsistencyTimeoutMs?: number;
  /** Bound the in-memory projection cache, or `false` to disable caching. */
  readonly cache?: { readonly maxWorkspaces?: number } | false;
  /** Optional sink for every appended event (logging/metrics). Must not throw. */
  readonly onEvent?: (event: IEventEnvelope) => void;
  /**
   * Optional full-text search index (the engine's first content-bearing read
   * projection). The container injects a Kysely handle over a Postgres-compatible
   * database (pg or PGlite); when omitted, `search` reads return an empty result. The
   * index is fed off the same fold the read model is and is read-your-writes via
   * write tokens.
   */
  readonly search?: IWikiSearchConfig;
}

// ────────────────────────────────────────────────────────────────────────────
// IWiki
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
  /**
   * The serializable status-FSM of a registered page TYPE — states +
   * named transitions + the initial status — for inspection/visualization. Schema-
   * agnostic: works for any registered type (incl. runtime-loaded models). Throws
   * {@link UnknownPageTypeError} for an unregistered type. Pure (no I/O).
   */
  fsmOf(type: PageTypeName): FsmDescriptor;
  /** Every registered page-type tag, in declaration order. Pure (no I/O). */
  pageTypes(): readonly PageTypeName[];
  /**
   * The full TYPE-level authoring surface of a registered page type: its status
   * FSM plus every command it can ever run — each with the
   * machine-readable {@link JsonSchema} for its args, its description, the
   * section/field it edits, and (for a page-transition command) the FSM event it
   * fires. This is the companion to {@link fsmOf}: it answers "what can I author on
   * this type, and with what args?" WITHOUT needing a page instance — so a tool/UI
   * can build a form for a transition or discover a command before any page exists.
   *
   * What it deliberately omits (because it is instance-state-dependent, not type-
   * level): whether a command is currently legal in a given status and whether its
   * preconditions hold — that lives on {@link IPageView.describeMutations}. Generated
   * structural commands carry `argsSchema: {}` (their shape is implied by the target
   * section/field), mirroring `describeMutations`. Pure (no I/O); throws
   * {@link UnknownPageTypeError} for an unregistered type.
   */
  describeType(type: PageTypeName): TypeDescriptor;
  /**
   * Full-text search over page CONTENT (the deterministic Markdown render), ranked,
   * with highlighted snippets. Fans out across `workspaces` (default: every open
   * workspace). Requires {@link IWikiConfig.search}; returns `[]` when search is not
   * configured. Pass `consistentWith` (a write token) for read-your-writes.
   */
  search(
    query: string,
    opts?: {
      workspaces?: readonly WorkspaceId[];
      limit?: number;
      consistentWith?: ConsistencyToken;
      timeoutMs?: number;
    },
  ): Promise<readonly SearchHit[]>;
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
// IWorkspaceHandle
// ────────────────────────────────────────────────────────────────────────────

export interface ITreeNode {
  readonly id: PageId | RootId;
  readonly title: string;
  /** The page's `render.title` template filled with its own title + field values (e.g.
   *  `"ADR-7: …"`). Present ONLY when it differs from `title` — i.e. the type declares a
   *  title template that resolves to something other than the raw title. Display surfaces
   *  (sidebar/outline) should prefer `displayTitle ?? title`; the raw editable `title` is
   *  unchanged. */
  readonly displayTitle?: string;
  readonly type?: PageTypeName;
  readonly status?: string;
  /** Hidden from default views (orthogonal to `status`); present and true only when archived. */
  readonly archived?: boolean;
  /** Last-mutated timestamp (ISO). For an archived page this is when it was archived — archived
   *  pages are frozen, so no later mutation moves it (lets views order by archival time). */
  readonly updatedAt?: string;
  readonly children: readonly ITreeNode[];
}

export interface IWorkspaceHandle {
  readonly id: WorkspaceId;

  // ── structural commands (atomic; guarded by invariants + workspace/page status) ──
  // Every write resolves to a {@link Committed} value carrying the committed-head
  // {@link ConsistencyToken} — the position after the append AND any OCC rebase-retry.
  createPage<K extends PageTypeName>(
    type: K,
    input: { title: string; parentId: PageId | null } & CreateArgs<K>,
  ): Promise<Committed<PageId>>;
  reparent(pageId: PageId, newParentId: PageId | null, position?: number): Promise<Committed<void>>;
  reorder(parentId: PageId | null, orderedChildIds: readonly PageId[]): Promise<Committed<void>>;
  setPageTitle(pageId: PageId, title: string): Promise<Committed<void>>;
  archivePage(pageId: PageId): Promise<Committed<void>>;
  unarchivePage(pageId: PageId): Promise<Committed<void>>;
  link(from: PageId, to: PageId, role: string): Promise<Committed<void>>;
  unlink(from: PageId, to: PageId, role: string): Promise<Committed<void>>;
  /** Cross-page list-element move: remove from one page's `(section, field)` list and
   *  add to another's, in one atomic append. */
  moveItem(input: {
    from: PageId;
    to: PageId;
    section: string;
    field: string;
    itemId: string;
  }): Promise<Committed<void>>;
  /** Archive the whole workspace (hidden from default listings; reversible via {@link unarchive}). */
  archive(): Promise<Committed<void>>;
  /** Unarchive the whole workspace — the inverse of {@link archive}, runnable while archived. */
  unarchive(): Promise<Committed<void>>;
  /**
   * Backfill engine-assigned `serial` fields onto pages that predate the field (their number
   * materialized to the placeholder 0) — the one-time path for adding a serial to a type that
   * already has pages. Assigns unset pages, per type, in creation order, as one atomic commit;
   * pages whose serial is already set are left untouched. Idempotent — safe to re-run.
   */
  assignSerials(): Promise<Committed<void>>;

  // ── page-scoped content/status command ──
  mutate<K extends PageTypeName, C extends CommandName<K>>(
    pageId: PageId,
    command: C,
    args: CommandArgs<K, C>,
  ): Promise<Committed<CommandResult<K, C>>>;
  /**
   * Run an ordered batch of commands on ONE page as a single ATOMIC commit:
   * each command is decided against the state left by the previous one (so an
   * order-dependent sequence — set a field, then a transition gated on it — works),
   * all the resulting events are appended as one array-message, and the whole batch
   * shares one {@link Committed} token. All-or-nothing: if any command is rejected the
   * batch aborts with {@link BatchCommandError} (carrying the failing index) and NOTHING
   * is committed. The token reflects every command, so a read gated on it sees them all.
   */
  mutateMany(
    pageId: PageId,
    commands: readonly { command: string; args?: Record<string, unknown> }[],
  ): Promise<Committed<BatchResult>>;

  // ── reads (token-gated; async) ──
  // Pass `consistentWith` a write's token to read-your-writes (waits up to `timeoutMs`,
  // default IWikiConfig.readConsistencyTimeoutMs); omit it for current/eventually-consistent state.
  status(opts?: IReadOpts): Promise<WorkspaceStatus>;
  tree(opts?: IReadOpts): Promise<ITreeNode>;
  page(pageId: PageId, opts?: IReadOpts): Promise<IPageView>;
  toMarkdown(pageId?: PageId, opts?: IReadOpts): Promise<string>;
  history(opts?: IReadOpts): Promise<readonly IEventEnvelope[]>;
  /**
   * Full-text search over this workspace's page CONTENT (the deterministic Markdown
   * render), ranked, with highlighted snippets. Requires {@link IWikiConfig.search};
   * returns `[]` when search is not configured. Pass `consistentWith` (a write token)
   * via `opts` for read-your-writes.
   */
  search(query: string, opts?: SearchQueryOpts): Promise<readonly SearchHit[]>;

  // ── live updates (G6) ──
  subscribe(handler: (event: IEventEnvelope) => void): Promise<Unsubscribe>;
}

// ────────────────────────────────────────────────────────────────────────────
// IPageView
// ────────────────────────────────────────────────────────────────────────────

/**
 * The result of an atomic batch ({@link IWorkspaceHandle.mutateMany}): the per-command
 * results, positionally aligned to the submitted commands (each is the same value the
 * single-command `mutate` would have returned — e.g. a created element's `{ …Id }`).
 */
export interface BatchResult {
  readonly results: readonly unknown[];
}

export interface IMutationDescriptor {
  readonly name: string;
  readonly argsSchema: JsonSchema;
  readonly resultSchema?: JsonSchema;
  /**
   * Whether the command can run right now: FSM-legal in the page's current status
   * AND — for a command carrying `preconditions` — every precondition currently
   * satisfied (the same pure checks the command bus enforces at commit).
   */
  readonly available: boolean;
  /**
   * When the command is otherwise in-gate but a precondition currently fails, the
   * first failed precondition's human reason (e.g. "all testing-plan cases must be
   * passed"). Absent when `available` is true, or when the command is simply not
   * status-legal. Lets a UI render a transition as "blocked — here's why".
   */
  readonly unmet?: string;
  readonly description?: string;
  /** Which section/field this command edits (write-gate surfacing). */
  readonly target?: { readonly section: string; readonly field?: string };
  /**
   * Model-declared autonomy classifier for a PAGE-transition command, joined from its
   * FSM edge's meta ({@link ITransition.meta}.agency): `"agent"` = a forward edge an
   * in-gate agent drives autonomously; `"human"` = a sign-off/decision gate the agent
   * stops at. Present ONLY for a page transition that is legal from the current status
   * (so its presence already filters to reachable edges); absent for content/generated/
   * untargeted commands, element transitions, and unclassified (escape/backward) edges.
   * Lets a generic roll-up partition do/blocked/humanGates with zero command-name knowledge.
   */
  readonly agency?: "agent" | "human";
}

/**
 * One element instance flagged by its type's {@link ElementDecl.awaitsHuman} predicate —
 * surfaced by {@link IPageView.attentionItems}. Addresses the element generically (section
 * key + list field + element id) and carries its type tag + current FSM status, so a host
 * can roll these up across a subtree with NO element-type literal of its own.
 */
export interface IAttentionItem {
  /** The page this element lives on. */
  readonly pageId: PageId;
  /** The owning section's stable model key. */
  readonly sectionKey: string;
  /** The list field on that section holding the element. */
  readonly field: string;
  /** The element's stable id ({@link IItem.id}). */
  readonly elementId: string;
  /** The element's type tag (the list's `elementType`). */
  readonly elementType: string;
  /** The element's current FSM status, if it has one. */
  readonly status?: string;
}

export interface IPageView<K extends PageTypeName = PageTypeName> {
  readonly id: PageId;
  readonly type: K;
  // Reads are token-gated and async: pass `consistentWith` a write's token to
  // read-your-writes, or omit it for current state.
  parentId(opts?: IReadOpts): Promise<PageId | null>;
  title(opts?: IReadOpts): Promise<string>;
  children(opts?: IReadOpts): Promise<readonly IPageView[]>;
  status(opts?: IReadOpts): Promise<StatusOf<K>>;
  state(opts?: IReadOpts): Promise<DeepReadonly<PageState>>;
  availableMutations(opts?: IReadOpts): Promise<readonly CommandName<K>[]>;
  describeMutations(opts?: IReadOpts): Promise<readonly IMutationDescriptor[]>;
  /**
   * Generic per-instance ATTENTION scan: every section-level list element on this page whose
   * element type declares a pure {@link ElementDecl.awaitsHuman} predicate that currently
   * returns true. Drives self-direction ("where does a human belong?") with ZERO element-type
   * knowledge in the engine or host. Token-gated like every read.
   */
  attentionItems(opts?: IReadOpts): Promise<readonly IAttentionItem[]>;
  toMarkdown(opts?: IReadOpts): Promise<string>;
  mutate<C extends CommandName<K>>(command: C, args: CommandArgs<K, C>): Promise<Committed<CommandResult<K, C>>>;
  /** Atomic ordered batch of commands on this page — see {@link IWorkspaceHandle.mutateMany}. */
  mutateMany(commands: readonly { command: CommandName<K>; args?: Record<string, unknown> }[]): Promise<Committed<BatchResult>>;
}

// ────────────────────────────────────────────────────────────────────────────
// FSM transition — `t()` & `makeGuard()` live in core/guard.ts
// ────────────────────────────────────────────────────────────────────────────

export interface ITransition<S extends string = string, C extends string = string> {
  readonly fromState: S;
  readonly event: C;
  readonly toState: S;
  /**
   * Optional model-declared edge metadata. `agency` is the autonomy classifier read
   * generically by hosts to self-direct an agent: `"agent"` = a forward edge an in-gate
   * agent should drive autonomously; `"human"` = a sign-off/decision gate where the agent
   * stops; absent = an escape/backward edge the agent neither auto-fires nor stops for.
   */
  readonly meta?: { readonly description?: string; readonly agency?: "agent" | "human" };
}

// ────────────────────────────────────────────────────────────────────────────
// FSM descriptor — the serializable, public projection of a page type's status FSM.
// Built by {@link IWiki.fsmOf} from the registry's guard; the
// stable, transport-friendly shape a UI/tool consumes (vs the internal `Guard`).
// ────────────────────────────────────────────────────────────────────────────

/** One status-FSM edge: a named transition between two statuses. */
export interface FsmTransition {
  /** Source status. */
  readonly from: string;
  /** The page-transition command/event name (e.g. "ship"). */
  readonly event: string;
  /** Target status. */
  readonly to: string;
  /** Mirrors {@link ITransition.meta} (incl. the `agency` autonomy classifier). */
  readonly meta?: { readonly description?: string; readonly agency?: "agent" | "human" };
}

/** A page type's status FSM, serializable and self-contained. */
export interface FsmDescriptor {
  /** The page-type tag this FSM belongs to (e.g. "feature-brief"). */
  readonly type: string;
  /** The status a freshly-created page of this type starts in. */
  readonly initial: string;
  /** All distinct statuses; `initial` first, then the rest in declaration order. */
  readonly states: readonly string[];
  /** Every declared transition (the directed, labeled edges). */
  readonly transitions: readonly FsmTransition[];
}

// ────────────────────────────────────────────────────────────────────────────
// Type descriptor — the serializable, INSTANCE-FREE authoring surface of a page
// type. Built by {@link IWiki.describeType}; the type-level companion
// to the instance-level {@link IMutationDescriptor} (which adds availability).
// ────────────────────────────────────────────────────────────────────────────

/** One command in a {@link TypeDescriptor}: its static, instance-free shape. */
export interface TypeCommandDescriptor {
  /** The command name passed to `mutate` (e.g. "addConstraint", "ship"). */
  readonly name: string;
  /**
   * JSON Schema of the command's args. For a model-declared command this is the real
   * schema (from its Zod validator); for a GENERATED structural command it is `{}`
   * (the args are implied by `target`), mirroring {@link IPageView.describeMutations}.
   */
  readonly argsSchema: JsonSchema;
  /** JSON Schema of the command's result, when it returns one. */
  readonly resultSchema?: JsonSchema;
  /** Human description of what the command does, when declared. */
  readonly description?: string;
  /** The section/field this command edits, when it targets one. */
  readonly target?: { readonly section: string; readonly field?: string };
  /**
   * The field-KIND of `target.field` (e.g. "blocks", "prose", "list", "scalar"), when the command
   * targets a field. Surfaces authoring constraints that differ by kind — notably that a `blocks`
   * field's prose runs reject inline Markdown while a `prose` field does not.
   */
  readonly targetKind?: string;
  /** The FSM event this command fires, when it is a page/element transition. */
  readonly transition?: { readonly level: "page" | "element"; readonly event: string };
  /**
   * For a PAGE transition: the model-declared agency of the FSM edge it fires
   * ({@link ITransition.meta}.agency), independent of any page instance. Absent otherwise.
   */
  readonly agency?: "agent" | "human";
  /** True for an engine-generated structural command (vs a model-declared one). */
  readonly generated: boolean;
}

/** A page type's complete type-level authoring surface: FSM + every command. */
export interface TypeDescriptor {
  /** The page-type tag (e.g. "feature-brief"). */
  readonly type: string;
  /** The type's human label, when declared. */
  readonly label?: string;
  /** The status FSM (same shape as {@link IWiki.fsmOf}). */
  readonly fsm: FsmDescriptor;
  /** Every command the type can run — declared commands first, then generated. */
  readonly commands: readonly TypeCommandDescriptor[];
  /**
   * Page-type ids that `createPage` auto-materializes as pinned children (recursively) in the
   * same commit as a page of this type — mirrors {@link IPageTypeDef.requiredChildren}. A caller
   * should author INTO these rather than create its own. Absent/empty when the type has none.
   */
  readonly requiredChildren?: readonly string[];
}

// ────────────────────────────────────────────────────────────────────────────
// Authoring API
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
 * command can enforce cross-page invariants atomically — e.g.
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

/** Read-only workspace context passed to a renderer. */
export interface IRenderCtx {
  titleOf(id: PageId): string | undefined;
  typeOf(id: PageId): string | undefined;
  statusOf(id: PageId): string | undefined;
  /** Whether the page is archived (hidden from default views); orthogonal to `statusOf`. */
  archivedOf(id: PageId): boolean;
  childrenOf(id: PageId | RootId): readonly PageId[];
  linksOf(id: PageId): readonly { readonly to: PageId; readonly role: string }[];
  backlinksOf(id: PageId): readonly { readonly from: PageId; readonly role: string }[];
  /**
   * Read another page's full folded state — the render-side twin of
   * {@link IRelatedReader.page}. Lets a {@link DerivedList} project a value from a
   * sibling's ELEMENT-level state, the same way cross-page read preconditions already do.
   */
  pageState(id: PageId): DeepReadonly<PageState> | undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// Section operations — the closed write vocabulary
// ────────────────────────────────────────────────────────────────────────────

/** A structured edit of a code field/block: replace `[start,end)` with `replacement`. */
export interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

/**
 * The engine-owned closed vocabulary every command emits and the one built-in
 * reducer folds. Each op names its target by key/id, never by position.
 * `section` is the section KEY; `addSection` mints a fresh `SectionId`.
 */
export type SectionOp =
  // ── field / element edits ──
  | { readonly op: "setField"; section: string; field: string; value: IField }
  | {
      readonly op: "applyTextEdits";
      section: string;
      field: string;
      block?: BlockId;
      edits: TextEdit[];
      /**
       * Optional CONTENT-HASH PRECONDITION. When present,
       * the command bus's rebase-retried decide window rejects the op (with a typed
       * {@link StaleEditError}) iff the target code field/block's CURRENT content hash
       * differs — i.e. the edits were computed against now-stale source (e.g. after an
       * OCC rebase). Complements stream-level OCC; the reducer itself stays pure.
       */
      expectedHash?: string;
    }
  | {
      readonly op: "addElement";
      section: string;
      field: string;
      id: string;
      fields: Record<string, IField>;
      status?: string;
      meta?: Record<string, unknown>;
      index?: number;
    }
  | { readonly op: "removeElement"; section: string; field: string; id: string }
  | { readonly op: "moveElement"; section: string; field: string; id: string; toIndex: number }
  | { readonly op: "setElementField"; section: string; field: string; id: string; elementField: string; value: IField }
  // ── block-tree edits (a `blocks` field) ──
  | { readonly op: "addBlock"; section: string; field: string; block: IBlock; index?: number }
  | { readonly op: "removeBlock"; section: string; field: string; block: BlockId }
  | { readonly op: "moveBlock"; section: string; field: string; block: BlockId; toIndex: number }
  | { readonly op: "setBlock"; section: string; field: string; block: IBlock }
  // ── section-tree edits ──
  | {
      readonly op: "addSection";
      key: string;
      name: string;
      description?: string;
      parentSection?: SectionId | null;
      index?: number;
      id?: SectionId;
    }
  | { readonly op: "removeSection"; section: string }
  | { readonly op: "moveSection"; section: string; parentSection: SectionId | null; toIndex: number }
  | { readonly op: "renameSection"; section: string; name: string }
  // ── meta ──
  | { readonly op: "setMeta"; section: string; element?: string; path: (string | number)[]; value: unknown }
  // ── FSM ──
  | {
      readonly op: "transition";
      level: "page" | "element";
      section?: string;
      field?: string;
      element?: string;
      event: string;
    };

/** The single engine content event payload: an ordered op list. */
export interface SectionOpsAppliedPayload {
  readonly ops: SectionOp[];
}

// ────────────────────────────────────────────────────────────────────────────
// Declarative authoring
// ────────────────────────────────────────────────────────────────────────────

/** The model's view of a field-kind in a section/element declaration. */
export type FieldDecl =
  | { readonly kind: "scalar"; required?: boolean; schema?: ISchema }
  | { readonly kind: "prose"; required?: boolean }
  | { readonly kind: "code"; required?: boolean }
  | { readonly kind: "attachment-ref"; required?: boolean }
  | { readonly kind: "ref"; required?: boolean; targetKinds?: RefTarget["kind"][] }
  | { readonly kind: "blocks"; required?: boolean }
  | { readonly kind: "list"; element: string; ordered?: boolean; required?: boolean }
  /**
   * An ENGINE-ASSIGNED, IMMUTABLE sequence number. At `createPage` the engine mints the
   * next value — `max(existing) + 1`, scoped to pages of the SAME TYPE in the workspace,
   * starting at 1 — bakes it into the creation event (a minted constant like the page id),
   * and stores it as a `scalar` number. No setter command is generated and no op may write
   * it, so it is stable for the life of the page. A `render.title` token (`{section.field}`)
   * can surface it as a human-friendly label (e.g. `"ADR-{meta.number}: {title}"`) without
   * it ever becoming the page's identity — that remains the page id.
   */
  | { readonly kind: "serial"; required?: boolean };

export interface SectionDecl {
  readonly name: string;
  readonly description?: string;
  /** requiredSection — materialized empty at create. */
  readonly required?: boolean;
  /** The write-gate. */
  readonly mutableIn?: readonly string[];
  readonly fields: Readonly<Record<string, FieldDecl>>;
  readonly meta?: ISchema;
  readonly reduceMeta?: (meta: unknown, op: SectionOp) => unknown;
  readonly deriveMeta?: (section: DeepReadonly<ISection>) => unknown;
  readonly sections?: Readonly<Record<string, SectionDecl>>;
}

export interface ElementDecl {
  readonly fields: Readonly<Record<string, FieldDecl>>;
  readonly status?: { readonly initial: string; readonly transitions: readonly ITransition[] };
  readonly meta?: ISchema;
  readonly reduceMeta?: (meta: unknown, op: SectionOp) => unknown;
  /**
   * Optional PURE per-instance predicate flagging an element of this type as awaiting a
   * human (sign-off / decision). Evaluated per element instance over its folded state —
   * same flavor as a {@link Precondition} (pure, deterministic, no clock/
   * RNG). Surfaced generically via {@link IPageView.attentionItems}; the engine never
   * inspects an element-type literal — only whether this predicate is declared and true.
   */
  readonly awaitsHuman?: (element: DeepReadonly<IItem>) => boolean;
}

/** Section-set contract. */
export interface SectionSetContract {
  readonly mode: "open" | "closed";
  readonly prohibited?: readonly string[];
  readonly cardinality?: Readonly<Record<string, { min?: number; max?: number }>>;
}

/** `arg("name")` sugar — maps a command arg to a field value. */
export type ArgRef = { readonly __arg: string };
export type FieldValueSpec = ArgRef | { readonly literal: IField };

/** A pure precondition for a transition; returns `true` or `{ unmet }`. */
export type Precondition = (
  page: DeepReadonly<PageState>,
  related: IRelatedReader,
) => true | { readonly unmet: string };

export interface DeclarativeCommand {
  readonly args: ISchema;
  readonly result?: ISchema;
  readonly description?: string;
  readonly target?: { section: string; element?: { idArg: string }; field?: string };
  readonly set?: Readonly<Record<string, FieldValueSpec>>;
  readonly transition?:
    | { readonly level: "page"; readonly event: string }
    | { readonly level: "element"; readonly event: string };
  readonly preconditions?: readonly Precondition[];
  /**
   * SIGN-OFF. When this page-transition command runs, the engine ALSO
   * drives each PINNED CHILD to its declared {@link IPageTypeDef.finalize} transition in
   * the SAME atomic commit — each child fully FSM- + precondition-validated, so a child
   * that isn't ready (e.g. a spec with undocumented decisions) rejects the whole sign-off.
   * One action lands the entire bundle in an aligned terminal state; a child already
   * finalized is skipped. Non-recursive (direct pinned children).
   */
  readonly cascadeFinalize?: boolean;
  /** Escape hatch: compute the effect as the same closed op vocabulary. */
  readonly produces?: (page: DeepReadonly<PageState>, args: unknown, ctx: ICommandContext) => SectionOp[];
}

export type DeclarativeCommandMap = Readonly<Record<string, DeclarativeCommand>>;

// ────────────────────────────────────────────────────────────────────────────
// Render config
// ────────────────────────────────────────────────────────────────────────────

export interface SectionRender {
  /** A page section key, the engine pseudo-sections `@references`/`@children`, or — when
   *  `derived` is set — ignored (the body comes from the named {@link DerivedList}). */
  readonly section?: string;
  /** Render this section's body from a model-declared {@link DerivedList} rather
   *  than a page field — a projection of cross-page state (e.g. the plan's steps). */
  readonly derived?: string;
  readonly heading?: string;
  readonly placeholder?: string;
  /** Which field of the section to render as the body. */
  readonly field?: string;
  readonly as?: "block" | "inline" | "fenced" | "link" | "bullets" | "numbered" | "table" | "blocks" | "checklist";
  /** Element template, e.g. "{text}" / "{field?}". */
  readonly item?: string;
  /** For `as: "checklist"`: the element status value that renders a checked box `[x]` (else `[ ]`). */
  readonly checkedWhen?: string;
  readonly groupBy?: string;
  readonly groups?: readonly { when: string; heading?: string; item: string }[];
}

export interface RenderConfig {
  /** e.g. "Feature: {title}" — {title} is the page title. */
  readonly title?: string;
  readonly sections: readonly SectionRender[];
  /** Whether to append the engine References + Child pages sections (default true). */
  readonly graphSections?: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Page type definition — declarative; no author apply/render/produces
// ────────────────────────────────────────────────────────────────────────────

/**
 * One row of a {@link DerivedList}: a stable `id` and display `text`, plus optional
 * presentation hints so a derived section can render either a CHECKLIST or a (possibly
 * nested) plain list such as a table of contents:
 *  - `checked` present → a checkbox `[x]`/`[ ]` (a derived checklist, e.g. the plan's
 *    steps); omitted → a plain bullet (a TOC entry / group row).
 *  - `level` → nesting depth (0 = top level); each level indents the bullet two spaces,
 *    so a grouped or recursive outline reads as a nested list. Defaults to 0.
 * Order is the projection's own order; like every renderer it must be deterministic.
 */
export interface DerivedItem {
  readonly id: string;
  readonly text: string;
  readonly checked?: boolean;
  readonly level?: number;
}

/**
 * A model-declared, PURE projection that synthesizes a checklist from folded state —
 * typically a SIBLING page's list joined to this page's local progress (the checklist
 * is a DERIVED VIEW of `plan.steps`, not a hand-duplicated copy).
 * Referenced from a render section via `derived: "<key>"`. Deterministic like every
 * renderer (no clock/RNG); order is the projection's order.
 */
export type DerivedList = (page: DeepReadonly<PageState>, ctx: IRenderCtx) => readonly DerivedItem[];

export interface IPageTypeDef<Status extends string = string> {
  readonly type: string;
  /**
   * Human-friendly display name (e.g. "Implementation plan"). Used as the DEFAULT
   * title for auto-created required children and available to UIs /
   * breadcrumbs. When omitted, a deterministic title-cased `type` id is used. This is
   * a creation-time default frozen into the page's title — editing `label` later does
   * NOT rename existing pages (their titles live in the event log).
   */
  readonly label?: string;
  readonly version: number;
  readonly initialStatus: Status;
  /** Lifecycle FSM ONLY. */
  readonly statusTransitions: readonly ITransition<Status, string>[];
  readonly sections: Readonly<Record<string, SectionDecl>>;
  readonly elements?: Readonly<Record<string, ElementDecl>>;
  readonly sectionSet?: SectionSetContract;
  readonly requiredChildren?: readonly string[];
  readonly commands: DeclarativeCommandMap;
  readonly render: RenderConfig;
  /** The page-transition command/event that drives this page to its terminal "done"
   *  status, applied when an ancestor's {@link DeclarativeCommand.cascadeFinalize} command
   *  signs the bundle off. */
  readonly finalize?: string;
  /** Named pure projections a render section materializes via `derived: "<key>"` —
   *  e.g. a checklist DERIVED from a sibling's list + local progress. */
  readonly derived?: Readonly<Record<string, DerivedList>>;
  /** Upcasters keyed by from-version, over `SectionOp` payloads. */
  readonly upcasters?: Readonly<Record<number, (payload: unknown) => unknown>>;
}

/** Opaque registration object returned by `definePageType`. */
export interface IPageType<Status extends string = string> {
  readonly __def: IPageTypeDef<Status>;
}
