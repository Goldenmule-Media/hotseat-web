/**
 * One configured emitter, supervised. `startMirror` used to open each workspace inline and
 * DROP any that threw, which made a misconfigured (or auth-expired) emitter indistinguishable
 * from an unconfigured one over the health endpoint — the exact shape of the "docs went
 * silently stale" failure — and left it dead until someone restarted the process. A supervisor
 * keeps the entry VISIBLE with its boot error and re-attempts it with backoff, so an unattended
 * service self-heals on its own after, say, a `wiki-mirror login`.
 */
import type { IWorkspaceHandle, WorkspaceId } from "wiki";
import { Registry } from "wiki/registry";

import type { Logger } from "./logger.js";
import type { MarkdownDiskProjector } from "./markdown-projection.js";
import { WorkspaceMirror, type MirrorWorkspaceStatus } from "./mirror.js";

/** Anything the health endpoint can ask for a per-workspace snapshot — a live tail loop or a supervisor. */
export interface IWorkspaceStatusSource {
  status(): Promise<MirrorWorkspaceStatus>;
}

/** Backoff between re-attempts of a failed emitter (ms); the last value repeats forever. */
export const RETRY_DELAYS_MS: readonly number[] = [15_000, 30_000, 60_000, 300_000];

/** Collaborators an {@link EmitterSupervisor} needs; the timer/clock seams exist for tests. */
export interface EmitterSupervisorDeps {
  readonly openWorkspace: (id: WorkspaceId) => Promise<IWorkspaceHandle>;
  readonly registry: Registry;
  readonly sink: MarkdownDiskProjector;
  readonly logger: Logger;
  readonly retryDelaysMs?: readonly number[];
  readonly schedule?: (fn: () => void, ms: number) => unknown;
  readonly cancel?: (timer: unknown) => void;
  readonly now?: () => number;
  /**
   * How long one start attempt may take before it counts as failed. Required, not optional
   * politeness: the stream client retries transport failures FOREVER, so `openWorkspace`
   * against an unreachable host never rejects — it hangs, and an emitter that hangs looks
   * exactly like one that is working. @default 60_000
   */
  readonly startTimeoutMs?: number;
}

export class EmitterSupervisor implements IWorkspaceStatusSource {
  private tail: WorkspaceMirror | undefined;
  private bootError: string | null = null;
  private attempts = 0;
  private nextRetryAt: number | null = null;
  private timer: unknown;
  private stopped = false;

  private readonly delays: readonly number[];
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (timer: unknown) => void;
  private readonly now: () => number;

  constructor(
    private readonly workspaceId: WorkspaceId,
    private readonly deps: EmitterSupervisorDeps,
  ) {
    this.delays = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.schedule =
      deps.schedule ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        timer.unref(); // a pending retry must never be the thing keeping the process alive
        return timer;
      });
    this.cancel = deps.cancel ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.now = deps.now ?? (() => Date.now());
  }

  /** Attempt to open + start the tail loop. NEVER throws: a failure is recorded and retried. */
  async start(): Promise<void> {
    await this.attempt();
  }

  /** The running tail loop, or undefined while this emitter is failing/retrying. */
  get mirror(): WorkspaceMirror | undefined {
    return this.tail;
  }

  /** True once the tail loop is running (used by callers that want a boot summary). */
  get running(): boolean {
    return this.tail !== undefined;
  }

  /** A point-in-time snapshot — from the live loop when it is running, from the manifest when it is not. */
  async status(): Promise<MirrorWorkspaceStatus> {
    const mirror = this.tail;
    if (mirror !== undefined) {
      return { ...(await mirror.status()), nextRetryAt: null, attempts: this.attempts };
    }
    return {
      workspaceId: this.workspaceId,
      root: this.deps.sink.root,
      // The manifest still knows what was last written here, so a disconnected emitter can
      // still report how far behind it is rather than pretending it mirrors nothing.
      appliedVersion: await this.appliedVersion(),
      lastReconcileAt: null,
      lastReconcileError: this.bootError,
      connected: false,
      nextRetryAt: this.nextRetryAt,
      attempts: this.attempts,
    };
  }

  /** Cancel any pending retry and stop the tail loop. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      this.cancel(this.timer);
      this.timer = undefined;
    }
    this.nextRetryAt = null;
    await this.tail?.stop();
  }

  /** Force an immediate re-attempt (a pending backoff timer is dropped). No-op while running. */
  async retryNow(): Promise<void> {
    if (this.stopped || this.tail !== undefined) return;
    if (this.timer !== undefined) {
      this.cancel(this.timer);
      this.timer = undefined;
    }
    await this.attempt();
  }

  private async appliedVersion(): Promise<number> {
    try {
      return await this.deps.sink.appliedVersion(this.workspaceId);
    } catch {
      return 0;
    }
  }

  private async attempt(): Promise<void> {
    if (this.stopped || this.tail !== undefined) return;
    this.attempts++;
    const { logger, sink } = this.deps;
    let mirror: WorkspaceMirror | undefined;
    try {
      await sink.init();
      const handle = await this.withTimeout(this.deps.openWorkspace(this.workspaceId), "opening the workspace");
      mirror = new WorkspaceMirror(handle, this.deps.registry, sink, this.workspaceId, logger);
      await this.withTimeout(mirror.start(), "the first sync");
      if (this.stopped) {
        await mirror.stop();
        return;
      }
      this.tail = mirror;
      this.bootError = null;
      this.nextRetryAt = null;
      this.attempts = 0;
      logger.info("wiki-mirror: mirroring workspace", { workspace: this.workspaceId, root: sink.root });
    } catch (err) {
      // A half-started loop may already hold a subscription; drop it before retrying.
      await mirror?.stop().catch(() => {});
      this.bootError = err instanceof Error ? err.message : String(err);
      logger.warn("wiki-mirror: workspace is not mirroring (will retry)", {
        workspace: this.workspaceId,
        root: sink.root,
        attempt: this.attempts,
        error: this.bootError,
      });
      this.scheduleRetry();
    }
  }

  /** Fail an attempt that hangs — see {@link EmitterSupervisorDeps.startTimeoutMs}. */
  private async withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
    const limit = this.deps.startTimeoutMs ?? 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(limit / 1000)}s ${what}`)), limit);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const delay = this.delays[Math.min(this.attempts - 1, this.delays.length - 1)];
    this.nextRetryAt = this.now() + delay;
    this.timer = this.schedule(() => {
      this.timer = undefined;
      void this.attempt();
    }, delay);
  }
}
