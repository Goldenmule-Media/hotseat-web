/**
 * The tab ↔ SharedWorker RPC contract (feature: shared engine in a SharedWorker).
 *
 * The engine + PGlite live in ONE SharedWorker shared across every tab; tabs are thin
 * RPC clients over the worker's `MessagePort` (via Comlink). This file is the seam between
 * them and is imported by BOTH sides, so it must stay **type-only** for the tab — the only
 * runtime value here is the error-DTO helper, which has no engine import.
 *
 * Design rules baked into these types:
 *  - The surface is FLAT and COARSE. No `IWorkspaceHandle`/`IPageView` proxy crosses the
 *    port — every call takes ids and returns plain, structured-clone-safe data, so a chatty
 *    object graph never round-trips across the boundary.
 *  - Live updates are PUSH. The worker owns the single tail + reachability probe and folds
 *    each commit once; it broadcasts a {@link WorkspaceSnapshot} (the freshly-folded tree +
 *    classified connection/error) to every subscribed port. A tab never re-reads `tree()` on
 *    an event — it mirrors the pushed snapshot.
 *  - Errors cross as DATA. `structuredClone` of an `Error` keeps only name/message/stack and
 *    drops the engine's subclass identity + own-props (`WikiError.code`,
 *    `UnknownPageTypeError.types`, …). The worker therefore throws a plain {@link WikiErrorDTO}
 *    *object* (never an `Error`): Comlink clones it verbatim and re-throws it on the tab, so
 *    `classify()` keeps the connection-vs-schema distinction it is built on.
 */
import type {
  FsmDescriptor,
  IMutationDescriptor,
  IWorkspaceSummary,
  PageId,
  SearchHit,
  WorkspaceId,
} from "wiki";

// ── live workspace state (worker → tab broadcast) ───────────────────────────────

/** Transport (live-tail) health. Distinct from a {@link LoadError}: a workspace can be
 *  fully reachable yet still fail to load because of a schema problem. */
export type ConnectionState = "connecting" | "live" | "reconnecting" | "error";

/**
 * Why a workspace view could not be built. The crucial distinction:
 * - `connection` — the wiki-server is unreachable (network/fetch failure). Retryable; the
 *   worker's probe keeps trying and the view recovers on its own.
 * - `unauthorized` — the server WAS reached but rejected our bearer token (HTTP 401 /
 *   code "UNAUTHORIZED"). Not retryable here: the AuthProvider clears the token and the
 *   gate falls back to the login page.
 * - `forbidden` — the server WAS reached and the SESSION IS VALID, but this user is not a
 *   member of the workspace (HTTP 403 / code "FORBIDDEN"). Deterministic for this session
 *   — never retried, and never routed through the sign-out path (the token is fine).
 * - `unknown-page-type` / `engine` — the server WAS reached and returned data, but this
 *   build's bundled page types can't fold it. Not a connection problem.
 * - `unsupported` — this browser lacks SharedWorker; the engine never started (tab-side only).
 */
export type LoadErrorKind = "connection" | "unauthorized" | "forbidden" | "unknown-page-type" | "engine" | "unsupported";

export interface LoadError {
  readonly kind: LoadErrorKind;
  /** Raw engine/network message — logged and shown as fallback detail. */
  readonly message: string;
  /** For `unknown-page-type`: the page/event types the engine could not resolve. */
  readonly unknownTypes: readonly string[];
}

/**
 * The authoritative, plain-data view of one workspace, computed in the worker (where the
 * engine's typed errors are real instances) and pushed to subscribed tabs. The tab mirrors
 * it straight into its React store — no tab-side classification or re-read.
 */
export interface WorkspaceSnapshot {
  readonly tree: ITreeNodeData | null;
  readonly connection: ConnectionState;
  /** Head version after the most recent applied commit; `null` before the first event. */
  readonly version: number | null;
  /** Wall-clock ms of the last applied event — drives the "live" pulse. */
  readonly lastEventAt: number | null;
  readonly error: LoadError | null;
}

/** `ITreeNode` is already plain, structured-clone-safe data; aliased for intent at the seam. */
export type ITreeNodeData = import("wiki").ITreeNode;

export type SnapshotCallback = (snapshot: WorkspaceSnapshot) => void;

/**
 * Map a thrown value to a {@link LoadError} by DUCK-TYPING `code`/`types` — never
 * `instanceof`. This is the one classifier for both sides: the worker runs it on the engine's
 * real typed-error instances (which carry `code`/`types`) to fill a snapshot; the tab runs it
 * on the marshalled {@link WikiErrorDTO} (same `code`/`types`) caught from an RPC rejection. A
 * value with no string `code` (a `fetch` rejection) is a transport/connection failure.
 */
export function classifyError(e: unknown): LoadError {
  const err = e as { code?: unknown; types?: unknown; message?: unknown; status?: unknown } | null;
  const code = typeof err?.code === "string" ? err.code : undefined;
  const message = e instanceof Error ? e.message : typeof err?.message === "string" ? err.message : String(e);
  if (code === "UNKNOWN_PAGE_TYPE") {
    const types = Array.isArray(err?.types) ? (err.types as string[]) : [];
    return { kind: "unknown-page-type", message, unknownTypes: types };
  }
  // The durable-streams client surfaces an auth rejection as `FetchError.status === 401`
  // or `DurableStreamError.code === "UNAUTHORIZED"` — distinct from both transport loss
  // (retryable) and a schema problem (deterministic).
  if (err?.status === 401 || code === "UNAUTHORIZED") return { kind: "unauthorized", message, unknownTypes: [] };
  // The gateway's membership rejection ("forbidden: not a member") — the session is
  // VALID, so it must never funnel through notifyUnauthorized; deterministic, so it is
  // never retried either. Checked before the generic code branch (code "FORBIDDEN").
  if (err?.status === 403 || code === "FORBIDDEN") return { kind: "forbidden", message, unknownTypes: [] };
  if (code !== undefined) return { kind: "engine", message, unknownTypes: [] };
  return { kind: "connection", message, unknownTypes: [] };
}

// ── the flat RPC surface the worker exposes (consumed via Comlink) ──────────────

export interface HostSearchOpts {
  readonly workspaces?: readonly WorkspaceId[];
  readonly limit?: number;
}

export interface HandshakeResult {
  /** Every registered page type's status FSM, sent ONCE so the tab's `fsmOf` stays
   *  synchronous in render (it must never become a per-call RPC). */
  readonly fsm: Record<string, FsmDescriptor>;
}

/**
 * What the worker `Comlink.expose`s, per connecting port. Every method is coarse and
 * returns plain data; rejections are {@link WikiErrorDTO} objects (see file header).
 */
export interface WikiHostApi {
  /** Supply/refresh (or clear) the bearer token for the SHARED engine. Every connecting
   *  tab calls this BEFORE its handshake so the first boot's stream config already
   *  carries the authorization header; later calls retarget the per-request header
   *  function without rebuilding the wiki — unless the engine booted WITHOUT the header
   *  function (a pre-auth boot), in which case the worker tears it down so the next call
   *  re-boots with the header installed. Never called when auth is disabled (no token
   *  stored), so the header is omitted entirely on that path. */
  setAuthToken(token: string | null): Promise<void>;

  handshake(): Promise<HandshakeResult>;

  listWorkspaces(): Promise<readonly IWorkspaceSummary[]>;
  /** Create a new workspace (engine assigns the id) and return it. The engine appends the
   *  catalog event, so the next listWorkspaces sees it. Auth ownership is claimed tab-side. */
  createWorkspace(name: string): Promise<{ readonly workspaceId: WorkspaceId }>;
  search(query: string, opts: HostSearchOpts): Promise<readonly SearchHit[]>;
  /** Fold every active workspace once so search spans all of them (the shared index is
   *  primed once for the whole worker, not per tab). Idempotent. */
  primeSearchIndex(): Promise<void>;

  /** Open + fold + start the tail/probe for a workspace (idempotent). */
  ensureWorkspace(ws: WorkspaceId): Promise<void>;
  toMarkdown(ws: WorkspaceId, page: PageId): Promise<string>;
  describeMutations(ws: WorkspaceId, page: PageId): Promise<readonly IMutationDescriptor[]>;

  mutate(ws: WorkspaceId, page: PageId, command: string, args: Record<string, unknown>): Promise<void>;
  archivePage(ws: WorkspaceId, page: PageId): Promise<void>;
  unarchivePage(ws: WorkspaceId, page: PageId): Promise<void>;
  /** Rename the workspace (its display name; the id never changes). */
  renameWorkspace(ws: WorkspaceId, name: string): Promise<void>;

  /** Register a (Comlink-proxied) snapshot callback; resolves to a subscription id. The
   *  current snapshot is delivered immediately, then on every change. */
  subscribe(ws: WorkspaceId, onSnapshot: SnapshotCallback): Promise<number>;
  unsubscribe(ws: WorkspaceId, subId: number): Promise<void>;
  /** Heartbeat: lets the worker reap a port's subscriptions when its tab goes silent
   *  (SharedWorker has no reliable port-closed event). */
  ping(): Promise<void>;
}

// ── error DTO (crosses the port as plain data) ──────────────────────────────────

/**
 * The wire shape of an engine error. A plain object — NOT an `Error` — so Comlink clones it
 * verbatim and re-throws it intact on the tab (an `Error` would be reduced to name/message/
 * stack, dropping `code`/`types`). `classify()` duck-types `code`/`types` off this.
 */
export interface WikiErrorDTO {
  readonly __wikiError: true;
  /** Stable engine code, e.g. "UNKNOWN_PAGE_TYPE", "VALIDATION"; `undefined` for a
   *  non-engine failure (a `fetch` rejection), which classifies as a connection error. */
  readonly code?: string;
  /** HTTP status off a transport-level rejection (`FetchError`/`DurableStreamError`) —
   *  carried so the tab can classify a 401 from an auth-gated server. */
  readonly status?: number;
  readonly message: string;
  /** `UnknownPageTypeError.types` — the unresolved page/event types. */
  readonly types?: readonly string[];
  /** `ValidationError.issues` — per-field schema failures. */
  readonly issues?: unknown;
  /** `PreconditionUnmetError.unmet` — the unmet precondition text. */
  readonly unmet?: string;
}

/** Read the engine's typed fields off a live error instance and marshal a plain DTO. Run
 *  worker-side, where the prototype + own-props are intact. Accepts any thrown value. */
export function toWikiErrorDTO(e: unknown): WikiErrorDTO {
  const err = e as
    | { code?: unknown; status?: unknown; message?: unknown; types?: unknown; issues?: unknown; unmet?: unknown }
    | null;
  const code = typeof err?.code === "string" ? err.code : undefined;
  return {
    __wikiError: true,
    ...(code !== undefined ? { code } : {}),
    ...(typeof err?.status === "number" ? { status: err.status } : {}),
    message: e instanceof Error ? e.message : typeof err?.message === "string" ? err.message : String(e),
    ...(Array.isArray(err?.types) ? { types: err.types as readonly string[] } : {}),
    ...(err?.issues !== undefined ? { issues: err.issues } : {}),
    ...(typeof err?.unmet === "string" ? { unmet: err.unmet } : {}),
  };
}

/** True when a caught value is a marshalled engine error (vs a transport/connection failure). */
export function isWikiErrorDTO(e: unknown): e is WikiErrorDTO {
  return typeof e === "object" && e !== null && (e as { __wikiError?: unknown }).__wikiError === true;
}
