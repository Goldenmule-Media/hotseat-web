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
    private readonly opts: { readonly ttlMs?: number; readonly now?: () => number } = {},
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

  /** Force a reload (concurrent callers share one round-trip). Rejects on failure. */
  async refresh(): Promise<readonly IWorkspaceSummary[]> {
    this.inFlight ??= this.load()
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

  /** The display name for a workspace id, when the catalog knows it. */
  nameOf(workspaceId: string): string | undefined {
    return this.entries.find((w) => w.id === workspaceId)?.name;
  }
}
