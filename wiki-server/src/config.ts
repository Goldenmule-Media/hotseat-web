/**
 * wiki-server configuration. A small, flat config resolved from
 * **flags → env → defaults** (first wins; `main` seeds unset env keys from a
 * `.env` in the cwd first, so secrets stay out of shell history). Every field
 * has a working default, so `wiki-server` runs with none.
 *
 * The host knobs map directly onto `@durable-streams/server`'s `TestServerOptions`.
 * The wrapped server has no request middleware, so when `--auth github` is on the
 * AUTH GATEWAY takes over the public port and the stream host moves to an internal
 * loopback port (see `auth/gateway.ts`); TLS still belongs to a fronting proxy.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
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
   * Port for the control listener (the log/health API) — a SEPARATE
   * `http.createServer` from the stream host, since the wrapped server hosts no
   * extra paths. Default `port + 1` (i.e. 4438).
   */
  readonly controlPort: number;
  /**
   * Port for the embedded `wiki-mcp` server over streamable HTTP — a
   * THIRD `http.createServer` (separate from the stream host and the control
   * listener), serving the MCP endpoint clients connect to at `/mcp`. Default
   * `port + 2` (i.e. 4439).
   */
  readonly mcpPort: number;
  /**
   * History ring-buffer size for `GET /_server/logs`: the most
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
  /**
   * Authentication mode. `"github"` puts the auth gateway on the public `port`
   * (GitHub OAuth + bearer sessions + per-workspace membership), moving the raw
   * stream host to an internal loopback port. `"none"` (default) is the open
   * local-dev wiring. Requires {@link githubClientId}/{@link githubClientSecret}.
   */
  readonly auth: "none" | "github";
  /** GitHub OAuth App client id (required when `auth === "github"`). */
  readonly githubClientId?: string;
  /** GitHub OAuth App client secret (required when `auth === "github"`). */
  readonly githubClientSecret?: string;
  /**
   * HMAC secret signing session tokens. Optional: when unset, one is generated
   * and persisted at `<dataDir>/auth/session-secret` (rotating it signs everyone out).
   */
  readonly sessionSecret?: string;
  /**
   * The gateway's EXTERNAL base URL — the host clients (and GitHub's OAuth
   * callback) reach it at. Default `http://{host}:{port}`; set it when the server
   * sits behind DNS/TLS. The OAuth app's callback must be `{publicUrl}/auth/github/callback`.
   */
  readonly publicUrl: string;
  /** Origins allowed as post-login redirect targets (the wiki-ui origins). */
  readonly uiOrigins: readonly string[];
  /** Session token lifetime in days. */
  readonly sessionTtlDays: number;
  /**
   * GitHub logins allowed to sign in (CSV, case-insensitive). Unset → ANY GitHub
   * account may establish a session — workspace membership still gates content,
   * but the catalog and unclaimed workspaces are open to every signed-in user,
   * so set this on any deployment that isn't intentionally public.
   */
  readonly authUsers?: readonly string[];
}

/** Loopback hosts that need no reverse proxy / auth to stay private. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"]);

/** Is `host` a loopback address (safe to run open)? */
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
        `@durable-streams/server has no "acid" mode — use the production tier for ACID)`,
    );
  }

  const dataDir = pick("data-dir", "WIKI_SERVER_DATA_DIR", "./.wiki-data");
  const longPollTimeout = toInt(pick("long-poll-ms", "WIKI_SERVER_LONG_POLL_MS", "30000"), "--long-poll-ms");

  const rawLog = flags["log-format"] ?? env.WIKI_SERVER_LOG_FORMAT ?? "auto";
  const logFormat = rawLog === "auto" ? (process.stdout.isTTY ? "pretty" : "json") : rawLog;
  if (logFormat !== "pretty" && logFormat !== "json") {
    throw new Error(`invalid --log-format "${rawLog}" (expected "pretty", "json", or "auto")`);
  }

  // The control listener (log/health API) defaults to the stream
  // port + 1 so the two never collide; explicit flag/env wins.
  const controlPort = toInt(
    pick("control-port", "WIKI_SERVER_CONTROL_PORT", String(port + 1)),
    "--control-port",
  );
  // The embedded MCP server (streamable HTTP) defaults to the stream
  // port + 2 so it never collides with the stream host (+0) or the control listener (+1).
  const mcpPort = toInt(pick("mcp-port", "WIKI_SERVER_MCP_PORT", String(port + 2)), "--mcp-port");
  const logBuffer = toInt(pick("log-buffer", "WIKI_SERVER_LOG_BUFFER", "1000"), "--log-buffer");
  const models = parseModels(pick("models", "WIKI_SERVER_MODELS", ""));
  const modelsDir = flags["models-dir"] ?? env.WIKI_SERVER_MODELS_DIR;

  const auth = pick("auth", "WIKI_SERVER_AUTH", "none");
  if (auth !== "none" && auth !== "github") {
    throw new Error(`invalid --auth "${auth}" (expected "none" or "github")`);
  }
  const githubClientId = flags["github-client-id"] ?? env.WIKI_SERVER_GITHUB_CLIENT_ID;
  const githubClientSecret = flags["github-client-secret"] ?? env.WIKI_SERVER_GITHUB_CLIENT_SECRET;
  if (auth === "github" && (githubClientId === undefined || githubClientSecret === undefined)) {
    throw new Error(
      `--auth github requires a GitHub OAuth App: set WIKI_SERVER_GITHUB_CLIENT_ID and ` +
        `WIKI_SERVER_GITHUB_CLIENT_SECRET (or the --github-client-id/--github-client-secret flags)`,
    );
  }
  const sessionSecret = flags["session-secret"] ?? env.WIKI_SERVER_SESSION_SECRET;
  const publicUrl = pick("public-url", "WIKI_SERVER_PUBLIC_URL", `http://${host}:${port}`).replace(/\/+$/, "");
  const uiOrigins = pick("ui-origins", "WIKI_SERVER_UI_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter((s) => s.length > 0);
  const sessionTtlDays = toInt(pick("session-ttl-days", "WIKI_SERVER_SESSION_TTL_DAYS", "30"), "--session-ttl-days");
  const authUsersRaw = flags["auth-users"] ?? env.WIKI_SERVER_AUTH_USERS;
  const authUsers =
    authUsersRaw !== undefined
      ? authUsersRaw
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter((s) => s.length > 0)
      : undefined;

  return {
    host,
    port,
    storage,
    dataDir,
    longPollTimeout,
    logFormat,
    controlPort,
    mcpPort,
    models,
    modelsDir,
    logBuffer,
    auth,
    ...(githubClientId !== undefined ? { githubClientId } : {}),
    ...(githubClientSecret !== undefined ? { githubClientSecret } : {}),
    ...(sessionSecret !== undefined ? { sessionSecret } : {}),
    publicUrl,
    uiOrigins,
    sessionTtlDays,
    ...(authUsers !== undefined ? { authUsers } : {}),
  };
}

/**
 * Seed UNSET keys of `env` from a `.env` file (`KEY=VALUE` lines; `#` comments
 * and blank lines ignored; surrounding single/double quotes stripped; no
 * interpolation). Real environment always wins; a missing file is a no-op.
 * `main` applies this to `process.env` before ANY config resolution so the
 * embedded wiki-mcp's own `WIKI_MCP_*` resolver sees the same file.
 */
export function applyDotEnv(env: Record<string, string | undefined>, path = ".env"): void {
  let raw: string;
  try {
    raw = readFileSync(resolve(path), "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    // Tolerate the shell-style `export KEY=VALUE` form — without this the key
    // would silently become "export KEY" and the real key stays unset.
    const trimmed = line.trim().replace(/^export\s+/, "");
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
}

/**
 * Operator-facing warnings for a resolved config. Returned (not
 * logged) so they are testable; `main.ts` prints them at startup.
 */
export function configWarnings(cfg: WikiServerConfig): string[] {
  const warnings: string[] = [];
  if (!isLoopback(cfg.host) && cfg.auth === "none") {
    warnings.push(
      `host is bound to ${cfg.host} (non-loopback) with --auth none, so anyone who can reach it ` +
        `can read and write every stream. Enable --auth github, or restrict to a private network.`,
    );
  }
  if (!isLoopback(cfg.host) && cfg.auth === "github" && cfg.publicUrl.startsWith("http://")) {
    warnings.push(
      `auth is on but publicUrl is plain http (${cfg.publicUrl}); bearer tokens cross the network ` +
        `unencrypted. Front the gateway with TLS and set WIKI_SERVER_PUBLIC_URL to the https URL.`,
    );
  }
  if (cfg.auth === "github" && cfg.authUsers === undefined) {
    warnings.push(
      `auth is on with no WIKI_SERVER_AUTH_USERS allowlist: ANY GitHub account can sign in. ` +
        `Workspace membership still gates content, but the catalog and unclaimed (pre-auth) ` +
        `workspaces are open to every signed-in user until claimed.`,
    );
  }
  if (cfg.storage === "memory") {
    warnings.push(`storage=memory is ephemeral; all data is lost on exit. Use storage=file for a durable host.`);
  }
  return warnings;
}
