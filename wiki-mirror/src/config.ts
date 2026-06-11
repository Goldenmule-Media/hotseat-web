/**
 * `wiki-mirror` configuration. The stream the engine tails, the namespace it lives in, the
 * model bundles to load, and the per-workspace on-disk roots to mirror to. Resolved from
 * **flags → env (`WIKI_MIRROR_*`) → config file (`wiki-mirror.config.json`) → defaults**.
 *
 * The `workspaceId → root` mapping is inherently PER-MACHINE state (two developers tailing
 * the same server have different checkouts at different paths), which is exactly why it lives
 * in a LOCAL file rather than on the shared server. Roots are resolved to ABSOLUTE paths (a
 * file-entry root relative to the config file's directory, a flag/env root relative to cwd),
 * so the projector always receives an absolute root.
 */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";

/** One workspace mirrored to one absolute on-disk root. */
export interface IEmitterEntry {
  readonly workspaceId: string;
  /** Absolute output directory; the projector writes ONLY under here. */
  readonly root: string;
}

/** Fully-resolved wiki-mirror configuration. */
export interface IMirrorConfig {
  /** Base URL of the Durable Streams host the engine tails. */
  readonly streamBaseUrl: string;
  /** Namespace served — MUST match the server's `WIKI_MCP_NAMESPACE`. */
  readonly namespace: string;
  /** Model-bundle specifiers to `import()` into the engine `Registry`. */
  readonly models: readonly string[];
  /** The workspace → absolute-root mirrors; one tail loop each. */
  readonly emitters: readonly IEmitterEntry[];
}

/** The on-disk `wiki-mirror.config.json` shape (everything optional; merged under flags/env). */
interface IMirrorConfigFile {
  streamBaseUrl?: string;
  namespace?: string;
  models?: string[];
  emitters?: { workspaceId?: string; root?: string }[];
}

export const DEFAULT_CONFIG_PATH = "wiki-mirror.config.json";
export const DEFAULT_STREAM_BASE_URL = "http://127.0.0.1:4437";
export const DEFAULT_NAMESPACE = "default";

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

/**
 * Resolve the effective {@link IMirrorConfig} from CLI flags, environment, and an optional
 * config file. Fails fast on a malformed/missing EXPLICIT config file, an unpaired
 * `--workspace`/`--root`, a duplicate workspace, or an empty workspaceId/root.
 *
 * @param argv process args WITHOUT the leading `node script` (`process.argv.slice(2)`).
 * @param env  environment map (`process.env`).
 * @param cwd  base for resolving relative flag/env roots (`process.cwd()`).
 */
export function resolveConfig(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  cwd: string = process.cwd(),
): IMirrorConfig {
  const flags = parseFlags(argv);

  // ── config file (the base layer; roots in it resolve against its own directory) ──
  const explicitConfig = flags["config"] ?? env.WIKI_MIRROR_CONFIG;
  const configPath = resolvePath(cwd, explicitConfig ?? DEFAULT_CONFIG_PATH);
  const configDir = dirname(configPath);
  let file: IMirrorConfigFile = {};
  try {
    file = JSON.parse(readFileSync(configPath, "utf8")) as IMirrorConfigFile;
  } catch (err) {
    // A missing DEFAULT file is fine (flags/env can supply everything); a missing/broken
    // EXPLICITLY-requested file is a hard error.
    if (explicitConfig !== undefined) {
      throw new Error(
        `wiki-mirror: cannot read config file "${configPath}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const streamBaseUrl =
    flags["stream-url"] ?? env.WIKI_MIRROR_STREAM_URL ?? file.streamBaseUrl ?? DEFAULT_STREAM_BASE_URL;
  const namespace = flags["namespace"] ?? env.WIKI_MIRROR_NAMESPACE ?? file.namespace ?? DEFAULT_NAMESPACE;

  const modelsRaw = flags["models"] ?? env.WIKI_MIRROR_MODELS;
  const models =
    modelsRaw !== undefined
      ? modelsRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      : (file.models ?? []);

  // ── emitters: file entries (root base = config dir) + one optional flag/env entry (base = cwd) ──
  const raw: { workspaceId?: string; root?: string; base: string }[] = (file.emitters ?? []).map((e) => ({
    ...e,
    base: configDir,
  }));
  const wsFlag = flags["workspace"] ?? env.WIKI_MIRROR_WORKSPACE;
  const rootFlag = flags["root"] ?? env.WIKI_MIRROR_ROOT;
  if (wsFlag !== undefined && rootFlag !== undefined) {
    raw.push({ workspaceId: wsFlag, root: rootFlag, base: cwd });
  } else if ((wsFlag === undefined) !== (rootFlag === undefined)) {
    throw new Error(
      "wiki-mirror: --workspace and --root (or WIKI_MIRROR_WORKSPACE/WIKI_MIRROR_ROOT) must be set together",
    );
  }

  const seen = new Set<string>();
  const seenRoots = new Set<string>();
  const emitters: IEmitterEntry[] = raw.map((e) => {
    if (typeof e.workspaceId !== "string" || e.workspaceId.length === 0) {
      throw new Error(`wiki-mirror: each emitter needs a non-empty workspaceId (got ${JSON.stringify(e.workspaceId)})`);
    }
    if (typeof e.root !== "string" || e.root.length === 0) {
      throw new Error(`wiki-mirror: emitter for ${e.workspaceId} needs a non-empty root`);
    }
    if (seen.has(e.workspaceId)) {
      throw new Error(`wiki-mirror: duplicate emitter for workspace ${e.workspaceId}`);
    }
    seen.add(e.workspaceId);
    const root = isAbsolute(e.root) ? e.root : resolvePath(e.base, e.root);
    // One root = one writer: the projector is single-writer-per-root and all of a root's
    // workspaces share one `.wiki-md-manifest.json`, so two emitters on the same root would
    // clobber each other's manifest. Give each workspace its own root.
    if (seenRoots.has(root)) {
      throw new Error(`wiki-mirror: two emitters target the same root "${root}" — give each workspace its own root (single-writer-per-root)`);
    }
    seenRoots.add(root);
    return { workspaceId: e.workspaceId, root };
  });

  return { streamBaseUrl, namespace, models, emitters };
}
