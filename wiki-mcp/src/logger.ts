/**
 * Logging seam (DESIGN §9). `wiki-mcp` owns NO log API of its own — it emits all
 * telemetry (projection progress, tail lag, MCP requests, errors) through a
 * {@link Logger} the host injects (`createWikiMcp({ logger })`), so the host can
 * consolidate it with the stream host's logs and expose it via the host's log API
 * ([wiki-server DESIGN §8.5]). When run standalone, the {@link consoleLogger}
 * default writes structured lines to the console.
 */

/**
 * Minimal structured logger interface (DESIGN §9). Three leveled methods plus an
 * optional `child` for scoped/bound fields (e.g. one logger per workspace tail).
 */
export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Optional: a logger that stamps `fields` onto every line it emits. */
  child?(fields: Record<string, unknown>): Logger;
}

/** Levels the console logger routes to `console.*`. */
type Level = "info" | "warn" | "error";

/**
 * A default {@link Logger} that writes one JSON line per call to the matching
 * `console` method, merging any `bound` fields (from {@link Logger.child}) under
 * the per-call ones. Used only when `wiki-mcp` runs standalone; a host normally
 * injects its own consolidating logger.
 */
export function consoleLogger(bound: Record<string, unknown> = {}): Logger {
  const emit = (level: Level, msg: string, fields?: Record<string, unknown>): void => {
    const line = JSON.stringify({
      level,
      msg,
      ...bound,
      ...(fields ?? {}),
    });
    // Route by level so a host capturing stderr separates warn/error.
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.info(line);
  };

  return {
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (fields) => consoleLogger({ ...bound, ...fields }),
  };
}

/** A {@link Logger} that discards everything — convenient for tests. */
export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
