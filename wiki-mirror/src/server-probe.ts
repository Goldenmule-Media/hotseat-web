/**
 * The mirror's independent liveness probe.
 *
 * Nothing inside the engine can tell us whether a live tail is still alive: `handle.history()`
 * serves the in-memory projection (no I/O), and the Durable Streams client exposes no
 * connection state — it retries transport failures forever but dies PERMANENTLY on a 4xx (the
 * shape of an expired grant), and a half-open socket after a laptop sleep simply hangs. So the
 * mirror probes the stream host itself: one cheap `HEAD` per workspace, which answers three
 * questions at once —
 *
 *  1. **Reachable?** a network error means the host or the link is down.
 *  2. **Authorized?** 401/403 means the grant expired: `wiki-mirror login`, not a network hunt.
 *  3. **Keeping pace?** the response carries the stream's current offset. If the server's offset
 *     moves and our applied version does NOT follow within {@link ProbeOptions.stuckAfterMs},
 *     the tail is wedged even though every layer below still claims to be connected.
 *
 * Stream URLs follow the documented namespace layout (`{baseUrl}/{namespace}/workspace/{id}`).
 */
import type { Logger } from "./logger.js";
import type { MirrorWorkspaceStatus } from "./mirror.js";

/** Per-workspace probe outcome, merged into the workspace's health entry. */
export interface WorkspaceProbe {
  readonly workspaceId: string;
  /** The server's current stream offset, or null when unknown (missing stream, failed probe). */
  readonly offset: string | null;
  /** True when the server has moved ahead of us for longer than the stuck threshold. */
  readonly stuck: boolean;
  /** Epoch ms the server was first seen ahead of our applied version, else null. */
  readonly behindSince: number | null;
}

/** Process-level reachability of the stream host. */
export interface ServerProbeStatus {
  readonly reachable: boolean;
  /** Epoch ms of the last completed probe round, or null before the first. */
  readonly lastProbeAt: number | null;
  /** Message of the last probe failure; null while healthy. */
  readonly lastError: string | null;
  /** The last failure was a 401/403 — credentials, not connectivity. */
  readonly unauthorized: boolean;
}

export interface ProbeOptions {
  readonly baseUrl: string;
  readonly namespace: string;
  /**
   * Resolves the `authorization` header to send, or undefined for an open server. A FUNCTION
   * (not a value) so a restart that re-reads `~/.wiki/credentials.json` takes effect here too,
   * and so a grant that has expired surfaces as a throw — which is itself the answer.
   */
  readonly authorization?: () => Promise<string | undefined> | string | undefined;
  /** Live per-workspace health, read fresh each round. */
  readonly snapshot: () => Promise<readonly MirrorWorkspaceStatus[]>;
  readonly logger: Logger;
  /** Round interval. @default 30_000 */
  readonly intervalMs?: number;
  /** How far behind the server we tolerate before calling a tail wedged. @default 180_000 */
  readonly stuckAfterMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  /** Per-request timeout — a half-open socket must not pin the probe. @default 10_000 */
  readonly timeoutMs?: number;
}

export const DEFAULT_PROBE_INTERVAL_MS = 30_000;
export const DEFAULT_STUCK_AFTER_MS = 180_000;

/** Tracks whether the host is reachable, whether we are authorized, and whether each tail keeps pace. */
export class ServerProbe {
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastProbeAt: number | null = null;
  private lastError: string | null = null;
  private unauthorized = false;
  private reachable = false;
  private started = false;
  private readonly perWorkspace = new Map<
    string,
    { offset: string | null; behindSince: number | null; probedAt: number }
  >();
  private readonly listeners = new Set<(event: ProbeEvent) => void>();

  private readonly intervalMs: number;
  private readonly stuckAfterMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: ProbeOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    this.stuckAfterMs = options.stuckAfterMs ?? DEFAULT_STUCK_AFTER_MS;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? ((): number => Date.now());
  }

  /** Run one round now, then every `intervalMs`. */
  async start(): Promise<void> {
    // The first round establishes a baseline; only LATER transitions are recoveries, or every
    // boot would look like one and restart the service it just started.
    await this.round();
    this.started = true;
    const timer = setInterval(() => void this.round(), this.intervalMs);
    timer.unref(); // the probe must never be the reason the process stays up
    this.timer = timer;
  }

  /**
   * Forget the pace bookkeeping (not the reachability verdict). Called after a restart: the
   * offsets belong to tail loops that no longer exist, and re-arming from stale ones would
   * declare the fresh mirror wedged the moment it started.
   */
  reset(): void {
    this.perWorkspace.clear();
  }

  stop(): void {
    this.started = false;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.listeners.clear();
  }

  /** Subscribe to recovery/wedged transitions (the service restarts itself on these). */
  on(listener: (event: ProbeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  status(): ServerProbeStatus {
    return {
      reachable: this.reachable,
      lastProbeAt: this.lastProbeAt,
      lastError: this.lastError,
      unauthorized: this.unauthorized,
    };
  }

  /** The probe's view of one workspace, or undefined if it has not been probed yet. */
  workspace(workspaceId: string): WorkspaceProbe | undefined {
    const entry = this.perWorkspace.get(workspaceId);
    if (entry === undefined) return undefined;
    return {
      workspaceId,
      offset: entry.offset,
      behindSince: entry.behindSince,
      stuck: entry.behindSince !== null && this.now() - entry.behindSince >= this.stuckAfterMs,
    };
  }

  /** One probe round: HEAD every mirrored workspace, then re-derive reachability + pace. */
  async round(): Promise<void> {
    const workspaces = await this.options.snapshot();
    const roundAt = this.now();
    if (workspaces.length === 0) {
      // Nothing configured: probe the catalog instead, so "is the server up?" still has an answer.
      const outcome = await this.head(`${this.options.baseUrl}/${this.options.namespace}/_catalog`);
      this.record(outcome);
      return;
    }

    // Concurrent, so a round against a hung host costs one request timeout rather than N of them.
    const results = await Promise.all(workspaces.map((ws) => this.head(this.urlFor(ws.workspaceId))));
    let outcome: HeadOutcome = { kind: "ok", offset: null };
    for (const [index, ws] of workspaces.entries()) {
      const result = results[index];
      if (result.kind !== "ok") {
        outcome = result; // the last failure wins the process-level verdict
        this.perWorkspace.set(ws.workspaceId, { offset: null, behindSince: null, probedAt: roundAt });
        continue;
      }
      this.trackPace(ws, result.offset, roundAt);
    }
    this.record(outcome);
  }

  private trackPace(ws: MirrorWorkspaceStatus, offset: string | null, roundAt: number): void {
    const previous = this.perWorkspace.get(ws.workspaceId);
    // A workspace that is not tailing at all is the supervisor's problem, not the pace tracker's:
    // measuring how far behind a stopped mirror is would just re-report the same failure.
    if (!ws.connected) {
      this.perWorkspace.set(ws.workspaceId, { offset, behindSince: null, probedAt: roundAt });
      return;
    }

    let behindSince = previous?.behindSince ?? null;
    const moved = previous !== undefined && previous.offset !== null && previous.offset !== offset;
    if (moved && behindSince === null) {
      // Anchor at the last round we KNEW we were level, NOT at "now". The tail reconciles within
      // milliseconds of a commit while the probe only finds out a round later, so stamping now
      // would leave every healthy commit looking like a miss — a quiet mirror would then declare
      // itself wedged a few minutes after every editing session and rebuild its engine for nothing.
      behindSince = previous.probedAt;
    }
    if (behindSince !== null && ws.lastReconcileAt !== null && ws.lastReconcileAt >= behindSince) {
      behindSince = null; // we reconciled after that point, so we are keeping pace
    }
    this.perWorkspace.set(ws.workspaceId, { offset, behindSince, probedAt: roundAt });

    if (behindSince !== null && roundAt - behindSince >= this.stuckAfterMs) {
      this.emit({ type: "wedged", workspaceId: ws.workspaceId, behindSince });
    }
  }

  private record(outcome: HeadOutcome): void {
    const wasHealthy = this.reachable && this.lastError === null;
    this.lastProbeAt = this.now();
    if (outcome.kind === "ok") {
      this.reachable = true;
      this.lastError = null;
      this.unauthorized = false;
      if (!wasHealthy && this.started) this.emit({ type: "recovered" });
      return;
    }
    this.reachable = outcome.kind !== "unreachable";
    this.unauthorized = outcome.kind === "unauthorized";
    this.lastError = outcome.error;
  }

  private emit(event: ProbeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.options.logger.warn("wiki-mirror: probe listener threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private urlFor(workspaceId: string): string {
    return `${this.options.baseUrl}/${this.options.namespace}/workspace/${encodeURIComponent(workspaceId)}`;
  }

  private async head(url: string): Promise<HeadOutcome> {
    let authorization: string | undefined;
    try {
      authorization = await this.options.authorization?.();
    } catch (err) {
      // The refreshing header function throws when the grant itself has expired.
      return { kind: "unauthorized", error: err instanceof Error ? err.message : String(err) };
    }
    try {
      const res = await this.fetchImpl(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(authorization !== undefined ? { headers: { authorization } } : {}),
      });
      if (res.status === 401 || res.status === 403) {
        return { kind: "unauthorized", error: `the stream host answered ${res.status} (sign in again)` };
      }
      // 404 = this stream does not exist yet; the HOST is up and we are authorized.
      if (!res.ok && res.status !== 404) {
        return { kind: "error", error: `the stream host answered ${res.status}` };
      }
      return { kind: "ok", offset: res.headers.get("stream-offset") };
    } catch (err) {
      return { kind: "unreachable", error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** Transitions the service reacts to: a host that came back, or a tail that stopped keeping pace. */
export type ProbeEvent = { readonly type: "recovered" } | { readonly type: "wedged"; readonly workspaceId: string; readonly behindSince: number };

type HeadOutcome =
  | { readonly kind: "ok"; readonly offset: string | null }
  | { readonly kind: "unauthorized" | "unreachable" | "error"; readonly error: string };
