/**
 * wiki-server configuration (DESIGN §6). A small, flat config resolved from
 * **flags → env → defaults** (first wins). Every field has a working default, so
 * `wiki-server` runs with none.
 *
 * The host knobs map directly onto `@durable-streams/server`'s `TestServerOptions`
 * (DESIGN §4); there are deliberately no auth/TLS/body knobs here — the wrapped
 * server has no request middleware, so those live in a reverse proxy (DESIGN §9).
 */

import { existsSync, readdirSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

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
   * Port for the embedded `wiki-mcp` server over streamable HTTP (DESIGN §8.5) — a
   * THIRD `http.createServer` (separate from the stream host and the control
   * listener), serving the MCP endpoint clients connect to at `/mcp`. Default
   * `port + 2` (i.e. 4439).
   */
  readonly mcpPort: number;
  /**
   * History ring-buffer size for `GET /_server/logs` (DESIGN §8.5): the most
   * recent N records the consolidating logger retains for replay. Default 1000.
   */
  readonly logBuffer: number;
  /**
   * Initial model bundles to load at boot (ADR-M6): comma-separated `id=specifier`
   * entries (a bare specifier derives its id from the file basename). Loaded after the
   * embedded `wiki-mcp` starts, so the engine gains its page types via dynamic import.
   */
  readonly models: { readonly id: string; readonly specifier: string }[];
  /**
   * A DIRECTORY of model bundles to load at boot (ADR-M6). Every bundle found by
   * {@link discoverModelBundles} is loaded in addition to {@link models}; an explicit
   * `--models` entry of the same id overrides a discovered one. Point it at the source
   * tree (`wiki-models/src` — each `<bundle>/index.ts` is a bundle, run under tsx) or at a
   * built tree (`wiki-models/dist` — each `<bundle>.js`). A discovered FILE that turns out
   * not to be a bundle (a build's shared chunk / sourcemap) is skipped with a warning at
   * load time, never aborting boot. Undefined = scan nothing.
   */
  readonly modelsDir?: string;
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
 * Parse `--models` / `WIKI_SERVER_MODELS` (ADR-M6): comma-separated `id=specifier`
 * entries. A bare specifier (no `=`) derives its id from the file basename, sans extension.
 */
function parseModels(raw: string): { id: string; specifier: string }[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((entry) => {
      const eq = entry.indexOf("=");
      if (eq >= 0) return { id: entry.slice(0, eq), specifier: entry.slice(eq + 1) };
      const base = entry.split("/").pop() ?? entry;
      return { id: base.replace(/\.[^.]+$/, ""), specifier: entry };
    });
}

/** A bundle index file name (source or built). */
const BUNDLE_INDEX_NAMES = ["index.ts", "index.js", "index.mjs"] as const;
/** Bundle file extensions in a flat (built) directory layout. */
const BUNDLE_FILE_EXTS = new Set([".js", ".mjs", ".ts"]);

/**
 * Discover model bundles under a directory (`--models-dir` / `WIKI_SERVER_MODELS_DIR`),
 * returning `{ id, specifier }` (absolute path) for each, sorted by id for a deterministic
 * load order. Two layouts are supported:
 *  - SUBDIRECTORY (source, e.g. `wiki-models/src`): each `<bundle>/index.{ts,js,mjs}` is a
 *    bundle whose id is the directory name;
 *  - FLAT (built, e.g. `wiki-models/dist`): each `<bundle>.{js,mjs,ts}` is a CANDIDATE whose id
 *    is the basename (sourcemaps / `.d.ts` are skipped). A flat tree may also hold a build's
 *    shared chunks, which look like `.js` files; those aren't bundles, so the CALLER load-tests
 *    each candidate and skips one that doesn't default-export a page-type array (see main.ts).
 * Dot-prefixed entries are ignored. Throws a descriptive error if `dir` can't be read.
 */
export function discoverModelBundles(dir: string): { id: string; specifier: string }[] {
  const root = resolve(dir);
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    throw new Error(`--models-dir "${dir}" could not be read (${(err as Error).message})`);
  }
  const found: { id: string; specifier: string }[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      const index = BUNDLE_INDEX_NAMES.map((n) => join(root, entry.name, n)).find((p) => existsSync(p));
      if (index !== undefined) found.push({ id: entry.name, specifier: index });
      continue;
    }
    if (entry.isFile()) {
      const ext = extname(entry.name);
      if (!BUNDLE_FILE_EXTS.has(ext) || entry.name.endsWith(".d.ts")) continue;
      found.push({ id: basename(entry.name, ext), specifier: join(root, entry.name) });
    }
  }
  return found.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
  // The embedded MCP server (streamable HTTP, DESIGN §8.5) defaults to the stream
  // port + 2 so it never collides with the stream host (+0) or the control listener (+1).
  const mcpPort = toInt(pick("mcp-port", "WIKI_SERVER_MCP_PORT", String(port + 2)), "--mcp-port");
  const logBuffer = toInt(pick("log-buffer", "WIKI_SERVER_LOG_BUFFER", "1000"), "--log-buffer");
  const models = parseModels(pick("models", "WIKI_SERVER_MODELS", ""));
  const modelsDir = flags["models-dir"] ?? env.WIKI_SERVER_MODELS_DIR;

  return { host, port, storage, dataDir, longPollTimeout, logFormat, controlPort, mcpPort, models, modelsDir, logBuffer };
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
