/**
 * The **emitter configuration store** (feature: "Runtime-configurable Markdown emitters").
 *
 * The set of live Markdown emitters is event-sourced on its OWN durable stream —
 * `${streamBaseUrl}/${namespace}/_emitter-config` — SEPARATE from the workspace event
 * streams. It is operational / read-side config (where to mirror a workspace on disk),
 * not wiki domain data, so it never touches the workspace event log. The engine's
 * `_catalog` stream is the precedent for per-namespace metadata on a `_`-prefixed stream,
 * but the engine's `EventLog` is internal/unexported, so `wiki-mcp` opens its OWN
 * `@durable-streams/client` to the same host (this file is the only place it does).
 *
 * One emitter = one workspace mirrored to one absolute on-disk root, keyed by a
 * caller-supplied `emitterId`. The stream is replayed + folded on boot to reconstruct the
 * live set (last-writer-wins per `emitterId`; `EmitterRemoved` deletes), and tailed live so
 * a configure/remove takes effect with no restart (see {@link EmitterRegistry}).
 *
 * Persistence model mirrors the engine's catalog stream: each `append()` stores ONE message
 * (one event object), and a read flattens the messages back into a flat event list.
 */
import { DurableStream, FetchError, stream } from "@durable-streams/client";

import type { Unsubscribe } from "wiki";

/** Stream content type (same as every workspace / catalog stream). */
const JSON_CONTENT_TYPE = "application/json";
/** DS sentinel offset that means "start of stream". */
const START_OFFSET = "-1";

/**
 * The two events on the `_emitter-config` stream. (Historical `EmitterConfigured` events also
 * carried an `archive` policy — `"drop" | "mirror"` — retired when archived pages gained their
 * one behavior, moving under `.archived/`; the fold ignores unknown fields, so old events on
 * existing streams replay fine.)
 */
export type EmitterConfigEvent =
  | {
      readonly type: "EmitterConfigured";
      readonly emitterId: string;
      readonly workspaceId: string;
      readonly root: string;
      readonly at: string;
    }
  | { readonly type: "EmitterRemoved"; readonly emitterId: string; readonly at: string };

/** One live emitter: one workspace mirrored to one absolute on-disk root. */
export interface LiveEmitter {
  readonly emitterId: string;
  readonly workspaceId: string;
  readonly root: string;
}

/** A non-live read's result: the flat event list + the cursor to resume a live tail from. */
export interface EmitterReadResult {
  readonly events: EmitterConfigEvent[];
  /** Opaque offset just past the last read event — pass to {@link EmitterConfigStore.subscribe}. */
  readonly cursor: string;
}

/**
 * Fold the config event stream into the live emitter set — **last-writer-wins per
 * `emitterId`**: a later `EmitterConfigured` replaces an earlier one (e.g. a new root), and
 * `EmitterRemoved` deletes the entry. Pure over its input (insertion order preserved by
 * `Map`), so it is the one place the live set is derived for both boot replay and the tools.
 */
export function foldEmitters(events: readonly EmitterConfigEvent[]): Map<string, LiveEmitter> {
  const live = new Map<string, LiveEmitter>();
  for (const e of events) {
    if (e.type === "EmitterConfigured") {
      live.set(e.emitterId, {
        emitterId: e.emitterId,
        workspaceId: e.workspaceId,
        root: e.root,
      });
    } else {
      live.delete(e.emitterId);
    }
  }
  return live;
}

/** Configuration for an {@link EmitterConfigStore} (mirrors the engine's `EventLogConfig`). */
export interface EmitterConfigStoreConfig {
  readonly baseUrl: string;
  readonly namespace: string;
  readonly ttlSeconds?: number;
}

/** Is this error a 409 already-exists conflict from the DS client (idempotent create)? */
function isConflict(e: unknown): boolean {
  if (e instanceof FetchError) return e.status === 409;
  if (typeof e === "object" && e !== null) {
    const o = e as { status?: unknown; code?: unknown };
    if (o.status === 409) return true;
    if (o.code === "CONFLICT_SEQ" || o.code === "CONFLICT_EXISTS") return true;
  }
  return false;
}

/**
 * The append/read/subscribe surface over the `_emitter-config` durable stream. Holds one
 * lazily, idempotently created {@link DurableStream} handle; live tails are tracked and
 * cancelled on {@link EmitterConfigStore.close}. The `at` timestamp stamped on each event is
 * informational only (the fold is by stream order, not `at`) — an injected `now` keeps it
 * deterministic in tests.
 */
export class EmitterConfigStore {
  private readonly url: string;
  private readonly ttlSeconds: number | undefined;
  private readonly now: () => string;
  private handle: DurableStream | undefined;
  /** Live tail sessions to cancel on close(). */
  private readonly liveSessions = new Set<{ cancel?: (reason?: unknown) => void }>();

  constructor(cfg: EmitterConfigStoreConfig, now: () => string = () => new Date().toISOString()) {
    this.url = `${cfg.baseUrl.replace(/\/+$/, "")}/${cfg.namespace}/_emitter-config`;
    this.ttlSeconds = cfg.ttlSeconds;
    this.now = now;
  }

  /** Get (creating idempotently) the cached stream handle. */
  private async streamHandle(): Promise<DurableStream> {
    if (this.handle !== undefined) return this.handle;
    try {
      this.handle = await DurableStream.create({
        url: this.url,
        contentType: JSON_CONTENT_TYPE,
        ...(this.ttlSeconds !== undefined ? { ttlSeconds: this.ttlSeconds } : {}),
      });
    } catch (e) {
      if (!isConflict(e)) throw e;
      // Stream already exists — a cold handle on the same url is equivalent.
      this.handle = new DurableStream({ url: this.url, contentType: JSON_CONTENT_TYPE });
    }
    return this.handle;
  }

  /** Append an `EmitterConfigured` for `emitter` (one event = one message). */
  async appendConfigured(emitter: LiveEmitter): Promise<void> {
    const handle = await this.streamHandle();
    const event: EmitterConfigEvent = { type: "EmitterConfigured", ...emitter, at: this.now() };
    await handle.append(JSON.stringify(event));
  }

  /** Append an `EmitterRemoved` for `emitterId`. */
  async appendRemoved(emitterId: string): Promise<void> {
    const handle = await this.streamHandle();
    const event: EmitterConfigEvent = { type: "EmitterRemoved", emitterId, at: this.now() };
    await handle.append(JSON.stringify(event));
  }

  /** Read the whole config stream (flattened) plus the cursor to tail live from. */
  async readAll(): Promise<EmitterReadResult> {
    await this.streamHandle();
    const res = await stream<EmitterConfigEvent | EmitterConfigEvent[]>({
      url: this.url,
      offset: START_OFFSET,
      live: false,
    });
    const items = await res.json();
    return { events: items.flat() as EmitterConfigEvent[], cursor: res.offset };
  }

  /**
   * Live tail: invoke `onEvent` for each NEW config event. Pass `opts.fromCursor` (the cursor
   * from {@link readAll}) so a boot replay isn't re-delivered; omit it to replay from the start.
   */
  async subscribe(
    onEvent: (event: EmitterConfigEvent) => void,
    opts?: { fromCursor?: string },
  ): Promise<Unsubscribe> {
    await this.streamHandle();
    const res = await stream<EmitterConfigEvent | EmitterConfigEvent[]>({
      url: this.url,
      offset: opts?.fromCursor ?? START_OFFSET,
      live: true,
    });
    this.liveSessions.add(res);
    const unsub = res.subscribeJson((batch) => {
      for (const e of (batch.items as (EmitterConfigEvent | EmitterConfigEvent[])[]).flat()) {
        onEvent(e);
      }
    });
    return () => {
      unsub();
      res.cancel?.();
      this.liveSessions.delete(res);
    };
  }

  /** Cancel every live tail and drop the cached handle. */
  async close(): Promise<void> {
    for (const session of this.liveSessions) session.cancel?.();
    this.liveSessions.clear();
    this.handle = undefined;
  }
}
