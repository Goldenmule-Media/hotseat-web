/**
 * wiki-server configuration (DESIGN §6). A small, flat config resolved from
 * **flags → env → defaults** (first wins). Every field has a working default, so
 * `wiki-server` runs with none.
 *
 * The host knobs map directly onto `@durable-streams/server`'s `TestServerOptions`
 * (DESIGN §4); there are deliberately no auth/TLS/body knobs here — the wrapped
 * server has no request middleware, so those live in a reverse proxy (DESIGN §9).
 */

/** Fully-resolved server configuration. */
export interface WikiServerConfig {
  /** Bind address. Default "127.0.0.1" (loopback — explicit opt-in to expose). */
  readonly host: string;
  /** Port. Default 4437. `0` = OS-assigned ephemeral port. */
  readonly port: number;
  /** "file" (durable) or "memory" (ephemeral). Maps to `dataDir` presence on the server. */
  readonly storage: "file" | "memory";
  /** Filesystem path for file storage. Ignored when `storage === "memory"`. */
  readonly dataDir: string;
  /** Long-poll hold time (ms), passed through to the server. */
  readonly longPollTimeout: number;
  /** Log format. "auto" resolves to "pretty" on a TTY, else "json". */
  readonly logFormat: "pretty" | "json";
  /**
   * Port for the control listener (the log/health API, DESIGN §8.5) — a SEPARATE
   * `http.createServer` from the stream host, since the wrapped server hosts no
   * extra paths (DESIGN §4). Default `port + 1` (i.e. 4438).
   */
  readonly controlPort: number;
  /**
   * History ring-buffer size for `GET /_server/logs` (DESIGN §8.5): the most
   * recent N records the consolidating logger retains for replay. Default 1000.
   */
  readonly logBuffer: number;
}

/** Loopback hosts that need no reverse proxy / auth to stay private. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"]);

/** Is `host` a loopback address (safe to run open, DESIGN §9)? */
export function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/** Parse `--key value` and `--key=value` flags into a flat record. */
function parseFlags(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

/** Parse a non-negative integer or throw a descriptive error. */
function toInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`invalid ${name}: "${value}" (expected a non-negative integer)`);
  }
  return n;
}

/**
 * Resolve the effective {@link WikiServerConfig} from CLI flags and environment,
 * applying defaults. Pure over its inputs except for the `logFormat: "auto"`
 * default, which consults `process.stdout.isTTY`.
 *
 * @param argv process args WITHOUT the leading `node script` (i.e. `process.argv.slice(2)`).
 * @param env  environment map (i.e. `process.env`).
 * @throws if a value is malformed (e.g. `--storage acid` — this server has no ACID mode).
 */
export function resolveConfig(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): WikiServerConfig {
  const flags = parseFlags(argv);
  const pick = (flag: string, envKey: string, def: string): string =>
    flags[flag] ?? env[envKey] ?? def;

  const host = pick("host", "WIKI_SERVER_HOST", "127.0.0.1");
  const port = toInt(pick("port", "WIKI_SERVER_PORT", "4437"), "--port");

  const storage = pick("storage", "WIKI_SERVER_STORAGE", "file");
  if (storage !== "file" && storage !== "memory") {
    throw new Error(
      `invalid --storage "${storage}" (expected "file" or "memory"; ` +
        `@durable-streams/server has no "acid" mode — use the production tier for ACID, DESIGN §8.3)`,
    );
  }

  const dataDir = pick("data-dir", "WIKI_SERVER_DATA_DIR", "./.wiki-data");
  const longPollTimeout = toInt(pick("long-poll-ms", "WIKI_SERVER_LONG_POLL_MS", "30000"), "--long-poll-ms");

  const rawLog = flags["log-format"] ?? env.WIKI_SERVER_LOG_FORMAT ?? "auto";
  const logFormat = rawLog === "auto" ? (process.stdout.isTTY ? "pretty" : "json") : rawLog;
  if (logFormat !== "pretty" && logFormat !== "json") {
    throw new Error(`invalid --log-format "${rawLog}" (expected "pretty", "json", or "auto")`);
  }

  // The control listener (log/health API, DESIGN §8.5) defaults to the stream
  // port + 1 so the two never collide; explicit flag/env wins.
  const controlPort = toInt(
    pick("control-port", "WIKI_SERVER_CONTROL_PORT", String(port + 1)),
    "--control-port",
  );
  const logBuffer = toInt(pick("log-buffer", "WIKI_SERVER_LOG_BUFFER", "1000"), "--log-buffer");

  return { host, port, storage, dataDir, longPollTimeout, logFormat, controlPort, logBuffer };
}

/**
 * Operator-facing warnings for a resolved config (DESIGN §9). Returned (not
 * logged) so they are testable; `main.ts` prints them at startup.
 */
export function configWarnings(cfg: WikiServerConfig): string[] {
  const warnings: string[] = [];
  if (!isLoopback(cfg.host)) {
    warnings.push(
      `host is bound to ${cfg.host} (non-loopback), but this server cannot authenticate requests. ` +
        `Put a reverse proxy in front (TLS + bearer token) or restrict to a private network — DESIGN §9.`,
    );
  }
  if (cfg.storage === "memory") {
    warnings.push(`storage=memory is ephemeral; all data is lost on exit. Use storage=file for a durable host.`);
  }
  return warnings;
}
