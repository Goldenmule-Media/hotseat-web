/**
 * The embedded `wiki` engine — the WRITE side (DESIGN §3.4, §7). Builds the
 * engine's {@link IWiki} via the engine's own `createWiki`, and keeps active
 * workspace **handles hot** behind a small LRU so a command on a recently-used
 * workspace appends with no refold (DESIGN §7 "write side — stays hot"). The LRU
 * bound is the engine's `IWikiConfig.cache.maxWorkspaces`.
 *
 * Every write returns the engine's {@link Committed} value carrying the
 * {@link ConsistencyToken} for the committed head; this module is the seam the MCP
 * write tools call, and the token it surfaces is what the per-session token manager
 * advances and the read model later catches up to (DESIGN §3.2, §6.2).
 *
 * It imports ONLY the engine's public surface (DESIGN §10, ADR-M5) — never
 * `wiki-server` and never the engine's internals.
 */
import {
  createWiki,
  type IWiki,
  type IWikiConfig,
  type IWorkspaceHandle,
  type IWorkspaceSummary,
  type PageId,
  type WorkspaceId,
} from "wiki";

import type { Logger } from "./logger.js";

/** Default hot-handle LRU bound when the host doesn't set `cache.maxWorkspaces`. */
const DEFAULT_MAX_HOT_WORKSPACES = 32;

/**
 * What the embedded engine needs from {@link WikiMcpConfig} plus the engine-shaped
 * extras the host supplies directly (page types, clock/ids for determinism, the
 * actor stamp). Kept separate from the wire config so a host can inject page types
 * + deterministic services without round-tripping through flags.
 */
export interface EngineConfig {
  /** Base URL of the Durable Streams host the engine appends to / tails (DESIGN §8). */
  readonly streamBaseUrl: string;
  /** The single namespace this instance serves (DESIGN §2). */
  readonly namespace: string;
  /** The page types this wiki understands (DESIGN §5.1, ADR-M3). */
  readonly pageTypes: IWikiConfig["pageTypes"];
  /** Injected ISO-8601 clock (determinism/testing); the engine defaults it otherwise. */
  readonly clock?: () => string;
  /** Injected id factory (determinism/testing); the engine defaults it otherwise. */
  readonly ids?: () => string;
  /** Default `actor` stamped on event metadata when a call doesn't override it. */
  readonly actor?: string;
  /** Default token-gated read `waitFor` timeout (ms) handed to the engine (DESIGN §3.3). */
  readonly readConsistencyTimeoutMs?: number;
  /**
   * Hot-handle LRU bound — the engine's `IWikiConfig.cache.maxWorkspaces`
   * (DESIGN §7). Omit for {@link DEFAULT_MAX_HOT_WORKSPACES}; `false` disables the
   * engine's projection cache entirely.
   */
  readonly cache?: { readonly maxWorkspaces?: number } | false;
}

/**
 * The embedded write-side engine with a hot-handle LRU (DESIGN §7).
 *
 * `open(id)` returns a hot {@link IWorkspaceHandle}, evicting the
 * least-recently-used handle past the bound. Handles stay open so their live tail
 * keeps the write-side aggregate fresh; a cold workspace opens once (snapshot +
 * short tail) and then stays hot. All writes flow through the handle and return the
 * engine's {@link Committed} token (DESIGN §3.2).
 */
export class EmbeddedEngine {
  private wiki: IWiki;
  private readonly maxHot: number;
  /** Hot handles in LRU order (most-recently-used last). Bounded by {@link maxHot}. */
  private readonly hot = new Map<WorkspaceId, IWorkspaceHandle>();

  constructor(private readonly config: EngineConfig, private readonly logger: Logger) {
    this.maxHot = resolveMaxHot(config.cache);
    this.wiki = createWiki(toWikiConfig(config));
  }

  /** The underlying engine (for cross-cutting reads like `listWorkspaces`). */
  get raw(): IWiki {
    return this.wiki;
  }

  /** Create a brand-new workspace and keep its handle hot. */
  async createWorkspace(input: { name: string; id?: WorkspaceId }): Promise<IWorkspaceHandle> {
    const handle = await this.wiki.createWorkspace(input);
    this.remember(handle.id, handle);
    return handle;
  }

  /**
   * Open (or reuse) a hot {@link IWorkspaceHandle}. A hit moves the handle to the
   * MRU position; a miss opens it via the engine (which folds once) and inserts it,
   * evicting the LRU handle if the cache is full (DESIGN §7).
   */
  async open(id: WorkspaceId): Promise<IWorkspaceHandle> {
    const cached = this.hot.get(id);
    if (cached !== undefined) {
      // Touch: re-insert to move to MRU.
      this.hot.delete(id);
      this.hot.set(id, cached);
      return cached;
    }
    const handle = await this.wiki.openWorkspace(id);
    this.remember(id, handle);
    return handle;
  }

  /** All workspace summaries (the namespace catalog — DESIGN §5.1). */
  listWorkspaces(): Promise<readonly IWorkspaceSummary[]> {
    return this.wiki.listWorkspaces();
  }

  /** Tear down the engine (closes every hot handle's tail). */
  async close(): Promise<void> {
    this.hot.clear();
    await this.wiki.close();
  }

  /**
   * Rebind the write side to a NEW page-type set (ADR-M6 hot-reload): rebuild the engine
   * from `pageTypes`, drop every hot handle (they were folded by the old registry), and
   * close the old engine. Subsequent `open`/`create` fold with the new types. Pair with
   * {@link ProjectionService.rebind} + `reproject` so the read side catches up.
   */
  async rebind(pageTypes: EngineConfig["pageTypes"]): Promise<void> {
    const old = this.wiki;
    this.hot.clear();
    this.wiki = createWiki(toWikiConfig({ ...this.config, pageTypes }));
    await old.close();
    this.logger.info("engine rebound to a new page-type set", { pageTypes: pageTypes.length });
  }

  /** Insert a handle at MRU, evicting the LRU entry past the bound (DESIGN §7). */
  private remember(id: WorkspaceId, handle: IWorkspaceHandle): void {
    this.hot.delete(id);
    this.hot.set(id, handle);
    while (this.hot.size > this.maxHot) {
      // First key in insertion order is the least-recently-used.
      const lru = this.hot.keys().next().value as WorkspaceId | undefined;
      if (lru === undefined) break;
      this.hot.delete(lru);
      // The engine keeps its own open-handle map keyed by id; dropping our LRU
      // reference simply lets it fall out of our hot set. We log for tail-lag /
      // capacity visibility (DESIGN §9).
      this.logger.info("evicted hot workspace handle", { workspace: lru });
    }
  }
}

/** Resolve the hot-handle LRU bound from the engine `cache` knob (DESIGN §7). */
function resolveMaxHot(cache: EngineConfig["cache"]): number {
  if (cache === false) return 0;
  return cache?.maxWorkspaces ?? DEFAULT_MAX_HOT_WORKSPACES;
}

/** Map {@link EngineConfig} onto the engine's `IWikiConfig`. */
function toWikiConfig(config: EngineConfig): IWikiConfig {
  return {
    stream: { baseUrl: config.streamBaseUrl, namespace: config.namespace },
    pageTypes: config.pageTypes,
    ...(config.clock !== undefined ? { clock: config.clock } : {}),
    ...(config.ids !== undefined ? { ids: config.ids } : {}),
    ...(config.actor !== undefined ? { actor: config.actor } : {}),
    ...(config.readConsistencyTimeoutMs !== undefined
      ? { readConsistencyTimeoutMs: config.readConsistencyTimeoutMs }
      : {}),
    ...(config.cache !== undefined ? { cache: config.cache } : {}),
  };
}

/** A `PageId` cast helper for tool/resource code that holds a raw string id. */
export function asPageId(id: string): PageId {
  return id as PageId;
}

/** A `WorkspaceId` cast helper for tool/resource code that holds a raw string id. */
export function asWorkspaceId(id: string): WorkspaceId {
  return id as WorkspaceId;
}
