/**
 * The **emitter registry** (feature: "Runtime-configurable Markdown emitters").
 *
 * Turns the live emitter set (folded from the `_emitter-config` stream) into running
 * Markdown-disk mirrors WITHOUT a restart. Each live emitter becomes a
 * {@link MarkdownDiskProjector} registered as a {@link RenderSink} on the existing projection
 * tailer — the SAME one-render-per-commit fan-out the SQL read model + search index ride, so
 * there is no second render path and no second event loop for page rendering.
 *
 * Lifecycle:
 *  - **boot** — replay + {@link foldEmitters fold} the config stream and, for each live emitter,
 *    build + register a projector and {@link ProjectionService.reconcileSink back-fill} its root
 *    from the workspace stream head (so files are present immediately, before any new commit);
 *  - **live** — tail the config stream from just past the boot replay: `EmitterConfigured` adds
 *    (or REPLACES — detach the old sink, register + back-fill a new one), `EmitterRemoved`
 *    detaches the sink and drops the entry. Removal LEAVES already-mirrored files on disk (the
 *    repo checkout owns them from then on — brief constraint 5).
 */
import type { Logger } from "../logger.js";
import type { EventSource, ProjectionService } from "../tail/projection.js";
import { MarkdownDiskProjector, type IMarkdownProjectionConfig } from "../tail/markdown-projection.js";
import {
  foldEmitters,
  type EmitterConfigEvent,
  type EmitterConfigStore,
  type LiveEmitter,
} from "./config-store.js";

/**
 * Map a live emitter onto the existing per-root projector config — one workspace mirrored to
 * one absolute root, tree layout. {@link MarkdownDiskProjector} itself is unchanged; it is now
 * constructed per emitter at runtime instead of once from boot config.
 */
export function toMarkdownConfig(e: LiveEmitter): IMarkdownProjectionConfig {
  return { enabled: true, root: e.root, workspaces: [e.workspaceId], layout: "tree", archive: e.archive };
}

/** A registered emitter: its live config + the disk projector serving it. */
interface Registered {
  readonly emitter: LiveEmitter;
  readonly sink: MarkdownDiskProjector;
}

/**
 * Reconstructs and maintains the live Markdown emitters off the `_emitter-config` stream. One
 * per `wiki-mcp` instance; {@link start} after the projection live tail is running.
 */
export class EmitterRegistry {
  private readonly registered = new Map<string, Registered>();
  private unsub: (() => void) | undefined;

  constructor(
    private readonly store: EmitterConfigStore,
    private readonly projection: ProjectionService,
    private readonly source: EventSource,
    private readonly logger: Logger,
  ) {}

  /**
   * Replay + fold the config stream, register + back-fill one sink per live emitter, then tail
   * the stream (from just past the replay) for runtime add / replace / remove. Awaiting this
   * guarantees boot emitters have back-filled their roots before it returns.
   */
  async start(): Promise<void> {
    const { events, cursor } = await this.store.readAll();
    for (const emitter of foldEmitters(events).values()) await this.applyConfigured(emitter);
    this.unsub = await this.store.subscribe((event) => void this.onEvent(event), { fromCursor: cursor });
    this.logger.info("emitter registry started", { emitters: this.registered.size });
  }

  /** Detach the live tail. Leaves registered sinks (and their on-disk files) in place. */
  async stop(): Promise<void> {
    this.unsub?.();
    this.unsub = undefined;
  }

  /** Handle one live config event; best-effort — a failure is logged, never thrown to the tail. */
  private async onEvent(event: EmitterConfigEvent): Promise<void> {
    try {
      if (event.type === "EmitterConfigured") {
        await this.applyConfigured({
          emitterId: event.emitterId,
          workspaceId: event.workspaceId,
          root: event.root,
          archive: event.archive,
        });
      } else {
        this.applyRemoved(event.emitterId);
      }
    } catch (err) {
      this.logger.warn("emitter registry failed to apply event", {
        type: event.type,
        emitterId: event.emitterId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Register (or REPLACE) the sink for an emitter: detach any prior sink for this id, build +
   * init a fresh {@link MarkdownDiskProjector}, add it to the projection, and back-fill its root
   * from the workspace stream head via {@link ProjectionService.reconcileSink}.
   */
  private async applyConfigured(emitter: LiveEmitter): Promise<void> {
    const prior = this.registered.get(emitter.emitterId);
    if (prior !== undefined) this.projection.removeRenderSink(prior.sink);

    const sink = new MarkdownDiskProjector(
      toMarkdownConfig(emitter),
      this.logger.child?.({ emitter: emitter.emitterId }) ?? this.logger,
    );
    await sink.init();
    this.projection.addRenderSink(sink);
    await this.projection.reconcileSink(sink, this.source);
    this.registered.set(emitter.emitterId, { emitter, sink });
    this.logger.info(prior !== undefined ? "emitter reconfigured" : "emitter configured", {
      emitterId: emitter.emitterId,
      workspaceId: emitter.workspaceId,
      root: emitter.root,
      archive: emitter.archive,
    });
  }

  /** Detach an emitter's sink and drop its entry. A no-op for an unknown id. */
  private applyRemoved(emitterId: string): void {
    const prior = this.registered.get(emitterId);
    if (prior === undefined) return;
    this.projection.removeRenderSink(prior.sink);
    this.registered.delete(emitterId);
    this.logger.info("emitter removed", { emitterId, root: prior.emitter.root });
  }
}
