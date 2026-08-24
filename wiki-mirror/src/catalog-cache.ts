/**
 * A TTL cache over the namespace catalog (`IWiki.listWorkspaces`). The health endpoint needs
 * workspace NAMES on every status poll and the full catalog for the config picker; neither is
 * worth a network round-trip per request, and neither may fail a status probe. Reads are served
 * from the last good snapshot, refreshed lazily when stale.
 */
import type { IWorkspaceSummary } from "wiki";

export const DEFAULT_CATALOG_TTL_MS = 300_000;

export class CatalogCache {
  private entries: readonly IWorkspaceSummary[] = [];
  private loadedAt: number | null = null;
  private inFlight: Promise<readonly IWorkspaceSummary[]> | undefined;

  constructor(
    private readonly load: () => Promise<readonly IWorkspaceSummary[]>,
    private readonly opts: {
      readonly ttlMs?: number;
      readonly now?: () => number;
      /** Give up on a load after this long. @default 15_000 */
      readonly timeoutMs?: number;
    } = {},
  ) {}

  /** The last known catalog, with NO I/O — safe on a hot status path. Empty until first loaded. */
  peek(): readonly IWorkspaceSummary[] {
    return this.entries;
  }

  /** The catalog, refreshing first if the snapshot is stale. Throws only when nothing is cached yet. */
  async get(): Promise<readonly IWorkspaceSummary[]> {
    const now = (this.opts.now ?? Date.now)();
    const ttl = this.opts.ttlMs ?? DEFAULT_CATALOG_TTL_MS;
    if (this.loadedAt !== null && now - this.loadedAt < ttl) return this.entries;
    try {
      return await this.refresh();
    } catch (err) {
      if (this.loadedAt !== null) return this.entries; // stale beats nothing
      throw err;
    }
  }

  /**
   * Force a reload (concurrent callers share one round-trip). Rejects on failure or after
   * `timeoutMs`. The timeout is load-bearing: a catalog read against a half-open socket never
   * settles, and an un-timed one would pin `inFlight` forever — hanging `/_mirror/workspaces`
   * and, worse, the service's own self-restart, which waits on this.
   */
  async refresh(): Promise<readonly IWorkspaceSummary[]> {
    this.inFlight ??= this.loadWithTimeout()
      .then((entries) => {
        this.entries = entries;
        this.loadedAt = (this.opts.now ?? Date.now)();
        return entries;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  private async loadWithTimeout(): Promise<readonly IWorkspaceSummary[]> {
    const limit = this.opts.timeoutMs ?? 15_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.load(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`the workspace catalog did not answer in ${limit}ms`)), limit);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** The display name for a workspace id, when the catalog knows it. */
  nameOf(workspaceId: string): string | undefined {
    return this.entries.find((w) => w.id === workspaceId)?.name;
  }
}
