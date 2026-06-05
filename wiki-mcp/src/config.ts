/**
 * wiki-mcp configuration (DESIGN §10). The namespace + stream `baseUrl` the
 * projection tailer reads, the read-model database tier (PGlite local / pg prod,
 * §5.3), the read-consistency timeout (§3.3), and the injected {@link Logger}
 * (§9). Resolved from **flags → env → defaults** (first wins), so the server runs
 * with none. The host (`wiki-server`) normally supplies these directly via
 * `createWikiMcp({ … })` rather than the CLI path.
 */
import { consoleLogger, type Logger } from "./logger.js";
import type { IMarkdownProjectionConfig } from "./tail/markdown-projection.js";

/**
 * The read-model database tier (DESIGN §5.3). `pglite` is embedded
 * Postgres-in-process — `dataDir` persists, or omit it (`memory`) for tests.
 * `pg` is a real Postgres server addressed by `connectionString`.
 */
export type DbConfig =
  | { readonly kind: "pglite"; readonly dataDir?: string }
  | { readonly kind: "pg"; readonly connectionString: string };

/** Fully-resolved wiki-mcp configuration. */
export interface WikiMcpConfig {
  /** Single namespace served by this instance (DESIGN §2). */
  readonly namespace: string;
  /** Base URL of the Durable Streams host the tailer reads (localhost in v1, §8). */
  readonly streamBaseUrl: string;
  /** The read-model database tier (§5.3). */
  readonly db: DbConfig;
  /** Default `waitFor` timeout (ms) for a token-gated read before it rejects (§3.3). @default 5000 */
  readonly readConsistencyTimeoutMs: number;
  /** Backstop poll interval (ms) for `waitFor` when no in-process notify fires (§5.2). @default 50 */
  readonly waitForPollMs: number;
  /**
   * The Markdown-disk mirror (off by default). Present only when `--md-root`/`WIKI_MCP_MD_ROOT`
   * is set; the projection tailer then renders each mirrored workspace's Markdown to disk and
   * keeps it current (feature: "Markdown projection to disk"). `wiki-server` inherits this
   * (it resolves the embedded `wiki-mcp`'s config from the same flags/env).
   */
  readonly markdown?: IMarkdownProjectionConfig;
}

/** Resolved config plus the injected runtime {@link Logger} (kept off the plain config). */
export interface WikiMcpRuntime {
  readonly config: WikiMcpConfig;
  readonly logger: Logger;
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
 * Resolve the effective {@link WikiMcpConfig} from CLI flags and environment,
 * applying defaults. The DB tier is `pglite` unless `--db pg` (then
 * `--pg-url`/`WIKI_MCP_PG_URL` is required); `pglite` uses `--data-dir` if given,
 * else an in-memory store.
 *
 * @param argv process args WITHOUT the leading `node script` (`process.argv.slice(2)`).
 * @param env  environment map (`process.env`).
 */
export function resolveConfig(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): WikiMcpConfig {
  const flags = parseFlags(argv);
  const pick = (flag: string, envKey: string, def: string): string =>
    flags[flag] ?? env[envKey] ?? def;

  const namespace = pick("namespace", "WIKI_MCP_NAMESPACE", "default");
  const streamBaseUrl = pick("stream-url", "WIKI_MCP_STREAM_URL", "http://127.0.0.1:4437");

  const dbKind = pick("db", "WIKI_MCP_DB", "pglite");
  let db: DbConfig;
  if (dbKind === "pg") {
    const connectionString = flags["pg-url"] ?? env.WIKI_MCP_PG_URL;
    if (connectionString === undefined || connectionString.length === 0) {
      throw new Error(`--db pg requires --pg-url or WIKI_MCP_PG_URL (a Postgres connection string)`);
    }
    db = { kind: "pg", connectionString };
  } else if (dbKind === "pglite") {
    const dataDir = flags["data-dir"] ?? env.WIKI_MCP_DATA_DIR;
    db = dataDir !== undefined && dataDir.length > 0 ? { kind: "pglite", dataDir } : { kind: "pglite" };
  } else {
    throw new Error(`invalid --db "${dbKind}" (expected "pglite" or "pg")`);
  }

  const readConsistencyTimeoutMs = toInt(
    pick("read-timeout-ms", "WIKI_MCP_READ_TIMEOUT_MS", "5000"),
    "--read-timeout-ms",
  );
  const waitForPollMs = toInt(pick("wait-poll-ms", "WIKI_MCP_WAIT_POLL_MS", "50"), "--wait-poll-ms");

  const markdown = resolveMarkdown(flags, env);

  return { namespace, streamBaseUrl, db, readConsistencyTimeoutMs, waitForPollMs, ...(markdown !== undefined ? { markdown } : {}) };
}

/**
 * Resolve the Markdown-disk mirror config (off unless a root is given). `--md-root`/
 * `WIKI_MCP_MD_ROOT` is the master switch — presence enables it. `--md-workspaces`
 * (`WIKI_MCP_MD_WORKSPACES`) is a comma-separated allowlist of workspace ids or `all`
 * (default); `--md-archive` (`WIKI_MCP_MD_ARCHIVE`) is `drop` (default) or `mirror`.
 */
function resolveMarkdown(
  flags: Record<string, string>,
  env: Record<string, string | undefined>,
): IMarkdownProjectionConfig | undefined {
  const root = flags["md-root"] ?? env.WIKI_MCP_MD_ROOT;
  if (root === undefined || root.length === 0) return undefined;

  const wsRaw = flags["md-workspaces"] ?? env.WIKI_MCP_MD_WORKSPACES ?? "all";
  const workspaces =
    wsRaw === "all" ? "all" : wsRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);

  const archive = flags["md-archive"] ?? env.WIKI_MCP_MD_ARCHIVE ?? "drop";
  if (archive !== "drop" && archive !== "mirror") {
    throw new Error(`invalid --md-archive "${archive}" (expected "drop" or "mirror")`);
  }

  return { enabled: true, root, workspaces, layout: "tree", archive };
}

/**
 * Resolve a full {@link WikiMcpRuntime} (config + logger). Used by the standalone
 * `bin`; a host passes its own resolved config + consolidating logger directly.
 */
export function resolveRuntime(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  logger: Logger = consoleLogger(),
): WikiMcpRuntime {
  return { config: resolveConfig(argv, env), logger };
}
