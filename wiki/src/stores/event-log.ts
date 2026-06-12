/**
 * The ONLY module that talks to `@durable-streams/client`. Everything else in
 * the engine depends on the `IEventLog` port (see `core/types.ts`), never on the
 * concrete client.
 *
 * Persistence model (verified empirically against @durable-streams 0.2.6/0.3.5):
 *  - A posted JSON array is NOT split into per-element messages: one `append()`
 *    stores exactly ONE message (the whole body). So each command's events are
 *    stored as ONE message = a JSON array `IEventEnvelope[]` (a "commit"). On read
 *    we flatten the array-messages back into a flat event sequence.
 *  - `Stream-Seq` gives strict-greater optimistic concurrency. We set
 *    `seq = pad(expectedVersion)`; an equal-or-lower seq → HTTP 409 surfaced as a
 *    `FetchError` with `.status === 409`, which we translate into `StaleAppendError`
 *    so the bus can rebase-and-retry.
 */
import { DurableStream, FetchError, stream } from "@durable-streams/client";

import type { IEventEnvelope, IStreamHeaders, Unsubscribe, WorkspaceId } from "../api";
import {
  type AppendResult,
  type CatalogEvent,
  type IEventLog,
  type ReadResult,
  type SerializedSnapshot,
  StaleAppendError,
} from "../core/types";

/** Stream content type for every workspace / snapshot / catalog stream. */
const JSON_CONTENT_TYPE = "application/json";
/** DS sentinel offset that means "start of stream". */
const START_OFFSET = "-1";

/** OCC seq is the folded head, zero-padded so lexicographic == numeric ordering. */
const pad = (n: number): string => String(n).padStart(20, "0");

/** Configuration for an EventLog (mirrors {@link IStreamConfig}). */
export interface EventLogConfig {
  readonly baseUrl: string;
  readonly namespace: string;
  readonly ttlSeconds?: number;
  /** Headers attached to every stream request; function values re-evaluate per request. */
  readonly headers?: IStreamHeaders;
}

/**
 * Is this error a 409 sequence/exists conflict from the DS client?
 * Covers `FetchError` (`.status`), `DurableStreamError` (`.status`/`.code`), and
 * any error whose message names a sequence/conflict (defensive).
 */
function isConflict(e: unknown): boolean {
  if (e instanceof FetchError) return e.status === 409;
  if (typeof e === "object" && e !== null) {
    const o = e as { status?: unknown; code?: unknown; message?: unknown };
    if (o.status === 409) return true;
    if (o.code === "CONFLICT_SEQ" || o.code === "CONFLICT_EXISTS") return true;
    if (typeof o.message === "string") {
      const m = o.message.toLowerCase();
      if (m.includes("sequence") || m.includes("conflict") || m.includes("already exists")) return true;
    }
  }
  return false;
}

/**
 * Concrete `IEventLog` over Durable Streams. Caches one `DurableStream` handle per
 * workspace stream (and the sibling snapshot / namespace catalog streams) so we do
 * not re-create handles on every call. Live subscriptions are tracked and cancelled
 * on {@link EventLog.close}.
 */
export class EventLog implements IEventLog {
  private readonly baseUrl: string;
  private readonly namespace: string;
  private readonly ttlSeconds: number | undefined;
  private readonly headers: IStreamHeaders | undefined;

  /** Workspace stream handles, keyed by workspace id. */
  private readonly handles = new Map<string, DurableStream>();
  /** Sibling snapshot stream handles, keyed by workspace id. */
  private readonly snapshotHandles = new Map<string, DurableStream>();
  /** The (single) namespace catalog stream handle, lazily created. */
  private catalogHandle: DurableStream | undefined;

  /** Live tail sessions to cancel on close(). */
  private readonly liveSessions = new Set<{ cancel?: (reason?: unknown) => void }>();

  constructor(cfg: EventLogConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.namespace = cfg.namespace;
    this.ttlSeconds = cfg.ttlSeconds;
    this.headers = cfg.headers;
  }

  /** Spread-ready `{ headers }` for a client call, or `{}` when none are configured. */
  private headerOpts(): { headers?: Record<string, string | (() => string | Promise<string>)> } {
    return this.headers !== undefined ? { headers: { ...this.headers } } : {};
  }

  // ── URLs ──────────────────────────────────────────────────────────────────

  private urlFor(ws: WorkspaceId): string {
    return `${this.baseUrl}/${this.namespace}/workspace/${encodeURIComponent(ws)}`;
  }

  private snapshotUrlFor(ws: WorkspaceId): string {
    return `${this.urlFor(ws)}/snapshot`;
  }

  private catalogUrl(): string {
    return `${this.baseUrl}/${this.namespace}/_catalog`;
  }

  // ── handle caches ───────────────────────────────────────────────────────────

  /** Get (creating idempotently) the cached workspace stream handle. */
  private async handleFor(ws: WorkspaceId): Promise<DurableStream> {
    const cached = this.handles.get(ws);
    if (cached) return cached;
    const handle = await this.createIdempotent(this.urlFor(ws));
    this.handles.set(ws, handle);
    return handle;
  }

  /** Get (creating idempotently) the cached snapshot stream handle. */
  private async snapshotHandleFor(ws: WorkspaceId): Promise<DurableStream> {
    const cached = this.snapshotHandles.get(ws);
    if (cached) return cached;
    const handle = await this.createIdempotent(this.snapshotUrlFor(ws));
    this.snapshotHandles.set(ws, handle);
    return handle;
  }

  /** Get (creating idempotently) the cached catalog stream handle. */
  private async catalog(): Promise<DurableStream> {
    if (this.catalogHandle) return this.catalogHandle;
    const handle = await this.createIdempotent(this.catalogUrl());
    this.catalogHandle = handle;
    return handle;
  }

  /**
   * `DurableStream.create` is idempotent here, but we still wrap defensively:
   * swallow an already-exists 409 and fall back to a cold handle on the same url.
   */
  private async createIdempotent(url: string): Promise<DurableStream> {
    try {
      return await DurableStream.create({
        url,
        contentType: JSON_CONTENT_TYPE,
        ...(this.ttlSeconds !== undefined ? { ttlSeconds: this.ttlSeconds } : {}),
        ...this.headerOpts(),
      });
    } catch (e) {
      if (isConflict(e)) {
        // Stream already exists — a cold handle on the same url is equivalent.
        return new DurableStream({ url, contentType: JSON_CONTENT_TYPE, ...this.headerOpts() });
      }
      throw e;
    }
  }

  // ── IEventLog: workspace stream ───────────────────────────────────────────────

  async ensure(ws: WorkspaceId): Promise<void> {
    await this.handleFor(ws);
  }

  async exists(ws: WorkspaceId): Promise<boolean> {
    const res = await DurableStream.head({ url: this.urlFor(ws), ...this.headerOpts() });
    return res.exists;
  }

  async append(
    ws: WorkspaceId,
    events: IEventEnvelope[],
    opts: { expectedVersion: number },
  ): Promise<AppendResult> {
    if (events.length === 0) {
      return { headVersion: opts.expectedVersion, cursor: undefined };
    }
    const handle = await this.handleFor(ws);
    const body = JSON.stringify(events);
    const seq = pad(opts.expectedVersion);
    try {
      await handle.append(body, { seq });
    } catch (e) {
      if (isConflict(e)) throw new StaleAppendError();
      throw e;
    }
    // The client's append() does not surface an offset; the bus tolerates an
    // undefined cursor (it resumes from its own folded cursor / a fresh read).
    return { headVersion: opts.expectedVersion + events.length, cursor: undefined };
  }

  async read(ws: WorkspaceId, fromCursor?: string): Promise<ReadResult> {
    await this.ensure(ws);
    const res = await stream<IEventEnvelope[]>({
      url: this.urlFor(ws),
      offset: fromCursor ?? START_OFFSET,
      live: false,
      ...this.headerOpts(),
    });
    const batches = await res.json();
    return { events: batches.flat(), nextCursor: res.offset };
  }

  async subscribe(
    ws: WorkspaceId,
    onBatch: (events: IEventEnvelope[], cursor: string) => void | Promise<void>,
    opts?: { fromCursor?: string },
  ): Promise<Unsubscribe> {
    await this.ensure(ws);
    const res = await stream<IEventEnvelope[]>({
      url: this.urlFor(ws),
      offset: opts?.fromCursor ?? START_OFFSET,
      live: true,
      ...this.headerOpts(),
    });
    this.liveSessions.add(res);
    const unsub = res.subscribeJson((batch) => {
      const flat = (batch.items as readonly IEventEnvelope[][]).flat();
      return onBatch(flat, batch.offset);
    });
    return () => {
      unsub();
      res.cancel?.();
      this.liveSessions.delete(res);
    };
  }

  // ── IEventLog: sibling snapshot stream ────────────────────────────────────────

  async appendSnapshot(ws: WorkspaceId, snapshot: SerializedSnapshot): Promise<void> {
    const handle = await this.snapshotHandleFor(ws);
    await handle.append(JSON.stringify(snapshot));
  }

  async readLatestSnapshot(ws: WorkspaceId): Promise<SerializedSnapshot | undefined> {
    await this.snapshotHandleFor(ws);
    const res = await stream<SerializedSnapshot>({
      url: this.snapshotUrlFor(ws),
      offset: START_OFFSET,
      live: false,
      ...this.headerOpts(),
    });
    const items = await res.json();
    return items.length > 0 ? items[items.length - 1] : undefined;
  }

  // ── IEventLog: namespace catalog stream ───────────────────────────────────────

  async appendCatalog(event: CatalogEvent): Promise<void> {
    const handle = await this.catalog();
    await handle.append(JSON.stringify(event));
  }

  async readCatalog(): Promise<CatalogEvent[]> {
    await this.catalog();
    const res = await stream<CatalogEvent>({
      url: this.catalogUrl(),
      offset: START_OFFSET,
      live: false,
      ...this.headerOpts(),
    });
    // Each append is one CatalogEvent object → one item per message; no flatten
    // needed, but tolerate accidental nesting defensively.
    const items = await res.json<CatalogEvent | CatalogEvent[]>();
    return items.flat() as CatalogEvent[];
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    for (const session of this.liveSessions) {
      session.cancel?.();
    }
    this.liveSessions.clear();
    this.handles.clear();
    this.snapshotHandles.clear();
    this.catalogHandle = undefined;
  }
}
