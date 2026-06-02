/**
 * The consolidating logger (DESIGN §8.5). `wiki-server` is the natural place to
 * unify telemetry from *both* planes it runs — the stream host **and** the hosted
 * `wiki-mcp` — so it constructs ONE structured {@link Logger} (the interface
 * `wiki-mcp` injects, see wiki-mcp/DESIGN §9) and fans every record three ways:
 *
 *  1. **stdout** (`json` off a TTY, else `pretty`);
 *  2. a **bounded in-memory ring buffer** (`--log-buffer`, default 1000) backing
 *     `GET /_server/logs` history; and
 *  3. any **live tail subscribers** (the `follow=1` SSE stream).
 *
 * Each record is `{ seq, boot, ts, level, source, msg, …fields }`: `seq` is a
 * monotonic per-process counter, `boot` identifies this process run (so a tail
 * detects a restart and resyncs rather than gapping), and `source ∈ server | stream
 * | mcp` tags origin. The `control.ts` listener reads from the ring buffer and
 * subscribes here; it is NOT a durable stream — logs are ephemeral operational data
 * (DESIGN §8.5).
 *
 * This file imports the {@link Logger}/{@link ILogger} interface from `wiki-mcp`
 * (the module `wiki-server` hosts), never from `wiki` directly (G2).
 */
import type { Logger as ILogger } from "wiki-mcp";

// NOTE: `.js` extensions are required because wiki-server is COMPILED and run via
// `node dist/main.js` (raw Node ESM needs explicit extensions). The `wiki-mcp`
// import above is a bare package specifier, so it needs none.

/** Telemetry origin — which plane emitted the record (DESIGN §8.5). */
export type LogSource = "server" | "stream" | "mcp";

/** A severity level, matching the three {@link ILogger} methods. */
export type LogLevel = "info" | "warn" | "error";

/**
 * One consolidated log record (DESIGN §8.5). `seq`/`boot` let a tail detect gaps
 * and restarts; `source` tags origin; `fields` carries any structured extras
 * (merged from {@link ILogger.child} bindings + the per-call fields).
 */
export interface LogRecord {
  /** Monotonic per-process counter (strictly increasing across all sources). */
  readonly seq: number;
  /** Identifies this process run; changes on restart so tails resync. */
  readonly boot: string;
  /** Emission time (ISO-8601). */
  readonly ts: string;
  /** Severity. */
  readonly level: LogLevel;
  /** Which plane emitted this (DESIGN §8.5). */
  readonly source: LogSource;
  /** The human message. */
  readonly msg: string;
  /** Structured extras (bound `child` fields merged under the per-call ones). */
  readonly fields: Record<string, unknown>;
}

/** A live-tail subscriber; receives every record appended after it subscribes. */
export type LogSubscriber = (record: LogRecord) => void;

/**
 * The consolidating logger surface the host wires up. It IS an {@link ILogger}
 * (so it can be injected straight into `createWikiMcp`), plus it exposes the ring
 * buffer + subscription seam the control listener reads (DESIGN §8.5).
 */
export interface IConsolidatingLogger extends ILogger {
  /** This process run's boot id (stable for the lifetime of the process). */
  readonly boot: string;
  /** A {@link Logger} view that stamps `source` onto every record it emits. */
  forSource(source: LogSource): IConsolidatingLogger;
  /**
   * History from the ring buffer, oldest→newest, filtered by the given query
   * (DESIGN §8.5). `since` returns only records with `seq > since`; a `boot`
   * mismatch is the caller's signal to resync, so we still return what we have.
   */
  history(query?: LogHistoryQuery): LogHistoryResult;
  /** Subscribe to the live tail; returns an unsubscribe function. */
  subscribe(fn: LogSubscriber): () => void;
}

/** Filters for {@link IConsolidatingLogger.history} (mirrors `GET /_server/logs`). */
export interface LogHistoryQuery {
  /** Only records with `seq` strictly greater than this. */
  readonly since?: number;
  /** Caller's last-seen boot; a mismatch means "resync" (history still returned). */
  readonly boot?: string;
  /** Cap on the number of records returned (most recent within range). */
  readonly limit?: number;
  /** Only this level. */
  readonly level?: LogLevel;
  /** Only this source. */
  readonly source?: LogSource;
}

/** The shape `GET /_server/logs` (history mode) returns (DESIGN §8.5). */
export interface LogHistoryResult {
  /** This process's boot id (so the client can detect a restart). */
  readonly boot: string;
  /** The matching records, oldest→newest. */
  readonly records: LogRecord[];
  /** The highest `seq` returned (the client's next `since`); `since` if none. */
  readonly next: number;
  /** True when the ring buffer had already evicted records below `since`. */
  readonly truncated?: boolean;
}

/** Options for {@link createLogger}. */
export interface CreateLoggerOptions {
  /** Ring-buffer capacity (DESIGN §6 `--log-buffer`). */
  readonly bufferSize: number;
  /** Output format for stdout (DESIGN §6 `--log-format`). */
  readonly format: "pretty" | "json";
  /** Override the boot id (tests/determinism); defaults to a per-process value. */
  readonly boot?: string;
  /** Override the clock (tests/determinism); defaults to `Date.now()` via ISO. */
  readonly now?: () => string;
  /** Override the stdout sink (tests); defaults to `console.*` by level. */
  readonly write?: (record: LogRecord, format: "pretty" | "json") => void;
}

/**
 * Shared mutable state for one logical logger — the ring buffer, the subscriber
 * set, and the monotonic `seq`. Every `child`/`forSource` view shares this so
 * `seq` stays globally monotonic and all records land in one buffer/feed.
 */
interface LoggerCore {
  readonly boot: string;
  readonly bufferSize: number;
  readonly format: "pretty" | "json";
  readonly now: () => string;
  readonly write: (record: LogRecord, format: "pretty" | "json") => void;
  /** Bounded ring buffer (oldest→newest); evicts from the front past capacity. */
  readonly buffer: LogRecord[];
  /** How many records have been evicted from the front (for `truncated`). */
  evicted: number;
  /** Next `seq` to assign. */
  seq: number;
  /** Live tail subscribers. */
  readonly subscribers: Set<LogSubscriber>;
}

/** Default stdout sink: route by level, formatting per `format`. */
function defaultWrite(record: LogRecord, format: "pretty" | "json"): void {
  const line = format === "json" ? JSON.stringify(record) : prettyLine(record);
  if (record.level === "error") console.error(line);
  else if (record.level === "warn") console.warn(line);
  else console.log(line);
}

/** Render a record as a compact human line (used when `format === "pretty"`). */
function prettyLine(record: LogRecord): string {
  const tail = Object.entries(record.fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("");
  return `[${record.source}] ${record.level.toUpperCase()} ${record.msg}${tail}`;
}

/**
 * A {@link IConsolidatingLogger} view bound to a `source` and a set of `bound`
 * fields (accumulated via {@link ILogger.child}). All views over one
 * {@link createLogger} call share a single {@link LoggerCore}.
 */
function makeView(core: LoggerCore, source: LogSource, bound: Record<string, unknown>): IConsolidatingLogger {
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    const merged = { ...bound, ...(fields ?? {}) };
    // A `child({ source })` (or a per-call `source` field) re-tags origin so the
    // record lands under the right plane even when emitted through this view.
    const recordSource = pickSource(merged) ?? source;
    delete (merged as Record<string, unknown>).source;
    const record: LogRecord = {
      seq: core.seq++,
      boot: core.boot,
      ts: core.now(),
      level,
      source: recordSource,
      msg,
      fields: merged,
    };
    // 1) stdout
    core.write(record, core.format);
    // 2) ring buffer (evict oldest past capacity)
    core.buffer.push(record);
    while (core.buffer.length > core.bufferSize) {
      core.buffer.shift();
      core.evicted++;
    }
    // 3) live subscribers (isolate a throwing subscriber so it can't break logging)
    for (const sub of core.subscribers) {
      try {
        sub(record);
      } catch {
        // A faulty tail must not take down the logging path.
      }
    }
  };

  return {
    boot: core.boot,
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (fields) => makeView(core, pickSource(fields) ?? source, { ...bound, ...fields }),
    forSource: (next) => makeView(core, next, bound),
    history: (query) => readHistory(core, query),
    subscribe: (fn) => {
      core.subscribers.add(fn);
      return () => core.subscribers.delete(fn);
    },
  };
}

/** Extract a `LogSource` from a fields bag if it carries a valid `source`. */
function pickSource(fields: Record<string, unknown>): LogSource | undefined {
  const s = fields.source;
  return s === "server" || s === "stream" || s === "mcp" ? s : undefined;
}

/** Apply a {@link LogHistoryQuery} against the ring buffer (DESIGN §8.5). */
function readHistory(core: LoggerCore, query: LogHistoryQuery = {}): LogHistoryResult {
  const { since, limit, level, source } = query;
  let records = core.buffer.filter((r) => {
    if (since !== undefined && r.seq <= since) return false;
    if (level !== undefined && r.level !== level) return false;
    if (source !== undefined && r.source !== source) return false;
    return true;
  });
  // `truncated` iff the caller asked for `since` below what the buffer still holds.
  const oldestHeld = core.buffer.length > 0 ? core.buffer[0].seq : core.seq;
  const truncated = since !== undefined && since + 1 < oldestHeld && core.evicted > 0;
  if (limit !== undefined && records.length > limit) {
    // Keep the most recent `limit` records within the matched range.
    records = records.slice(records.length - limit);
  }
  const next = records.length > 0 ? records[records.length - 1].seq : (since ?? -1);
  return truncated ? { boot: core.boot, records, next, truncated } : { boot: core.boot, records, next };
}

/** A process-unique boot id: time + a short random suffix (startup only — not a reducer). */
function defaultBoot(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build the host's one consolidating logger (DESIGN §8.5). The returned value is
 * an {@link IConsolidatingLogger}: use {@link IConsolidatingLogger.forSource} to
 * get the `server` / `stream` / `mcp`-tagged views the host wires into the stream
 * lifecycle hooks and `createWikiMcp`. The default `source` is `server`.
 */
export function createLogger(options: CreateLoggerOptions): IConsolidatingLogger {
  const core: LoggerCore = {
    boot: options.boot ?? defaultBoot(),
    bufferSize: Math.max(1, options.bufferSize),
    format: options.format,
    now: options.now ?? (() => new Date().toISOString()),
    write: options.write ?? defaultWrite,
    buffer: [],
    evicted: 0,
    seq: 0,
    subscribers: new Set(),
  };
  return makeView(core, "server", {});
}
