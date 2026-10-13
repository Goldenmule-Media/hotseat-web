/**
 * The local health endpoint. `wiki-mirror` is otherwise a headless tail-loop process; this
 * small `http.createServer` (modeled on wiki-server's control listener) lets a client — wiki-ui
 * and the macOS menu-bar app — see whether a mirror is running on this machine, whether it is
 * keeping pace, and WHY it is not:
 *
 * | Method · path | Purpose |
 * |---|---|
 * | `GET /_mirror/health` | liveness — always `200 {status:"ok"}` while the process is up |
 * | `GET /_mirror/status` | the full snapshot: process, auth, host reachability, per-workspace |
 * | `GET /_mirror/workspaces` | the namespace catalog + which entries this machine mirrors |
 * | `GET /_mirror/workspaces/{id}/tree` | a workspace's top pages, flattened, for picking a subtree root |
 *
 * Every response carries permissive CORS: wiki-ui runs at a *different* origin
 * (`localhost:3000`) and reads this cross-origin, exactly as it already reads the Durable
 * Streams host. It binds loopback by default — it is unauthenticated and exposes local
 * roots/versions, matching the mirror's local-only trust model.
 *
 * **`/_mirror/status` answers 200 even when everything is broken.** A non-2xx would tell every
 * client "no mirror is running here", which is the one thing it must never say while it is
 * running: failures belong in the body (`auth.expired`, `server.reachable`, per-workspace
 * `lastReconcileError`), never in the status line.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { IWorkspaceSummary } from "wiki";

import type { AuthStatus } from "./auth-status.js";
import type { Logger } from "./logger.js";
import type { MirrorWorkspaceStatus } from "./mirror.js";
import type { ServerProbeStatus, WorkspaceProbe } from "./server-probe.js";
import type { IWorkspaceStatusSource } from "./supervisor.js";

/** JSON shape of `GET /_mirror/status`. */
export interface MirrorStatusResponse {
  /** "degraded" when any workspace is failing/not tailing, the host is unreachable, or the grant expired. */
  readonly status: "ok" | "degraded";
  readonly uptimeMs: number;
  /** OS process id — the menu-bar app uses it to tell a stale listener from a live one. */
  readonly pid: number;
  readonly namespace: string;
  readonly streamBaseUrl: string;
  /** The config file this process actually read, so a client edits the right one. */
  readonly configPath: string | null;
  readonly auth: AuthStatus;
  readonly server: ServerProbeStatus;
  readonly workspaces: readonly MirrorWorkspaceStatus[];
}

/** One catalog entry from `GET /_mirror/workspaces`, annotated with this machine's mirror root. */
export interface CatalogWorkspaceEntry {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  /** The root this machine mirrors the WHOLE workspace to, or null when no entry covers all of it. */
  readonly mirroredRoot: string | null;
  /** Every entry mirroring this workspace here, whole or by subtree. */
  readonly mirrors: readonly { readonly root: string; readonly subtreeRootId: string | null }[];
}

/** One page of `GET /_mirror/workspaces/{id}/tree`: depth 0 is a top-level page. */
export interface MirrorTreePage {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly depth: number;
  readonly archived: boolean;
}

/** What {@link startHealthServer} needs to answer the probes. */
export interface HealthServerOptions {
  readonly host: string;
  readonly port: number;
  readonly namespace: string;
  readonly streamBaseUrl: string;
  /**
   * The per-workspace status sources, read live per request. Pass a FUNCTION when the service
   * may rebuild them (a self-restart) without dropping this listener.
   */
  readonly sources: readonly IWorkspaceStatusSource[] | (() => readonly IWorkspaceStatusSource[]);
  /** Credentials snapshot; defaults to `{mode:"none"}`. */
  readonly auth?: () => AuthStatus;
  /** Stream-host reachability; defaults to an optimistic "reachable, never probed". */
  readonly server?: () => ServerProbeStatus;
  /** Per-workspace probe detail (offset/stuck), merged into each entry. */
  readonly probe?: (workspaceId: string) => WorkspaceProbe | undefined;
  /** Workspace display names, without I/O. */
  readonly nameOf?: (workspaceId: string) => string | undefined;
  /** Backs `GET /_mirror/workspaces`; absent → the route answers 503. */
  readonly catalog?: () => Promise<readonly IWorkspaceSummary[]>;
  /** Backs `GET /_mirror/workspaces/{id}/tree`; absent or failing → the route answers 503. */
  readonly tree?: (workspaceId: string) => Promise<readonly MirrorTreePage[]>;
  readonly configPath?: string | null;
  /** Process start time (ms epoch) for `uptimeMs`; defaults to "now". */
  readonly startedAt?: number;
  readonly logger?: Logger;
}

/** A started health listener; `stop()` closes it. */
export interface HealthServer {
  /** The bound base URL (e.g. `http://127.0.0.1:4440`). */
  readonly url: string;
  stop(): Promise<void>;
}

/** Thrown when the port is already taken — very likely by another `wiki-mirror` on this machine. */
export class HealthPortInUseError extends Error {
  constructor(
    readonly host: string,
    readonly port: number,
  ) {
    super(
      `wiki-mirror: ${host}:${port} is already in use — another wiki-mirror is probably already ` +
        `running on this machine (two mirrors on one root corrupt each other's manifest). ` +
        `Stop it, or pass --health-port to run a second one.`,
    );
    this.name = "HealthPortInUseError";
  }
}

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const OPTIMISTIC_SERVER: ServerProbeStatus = {
  reachable: true,
  lastProbeAt: null,
  lastError: null,
  unauthorized: false,
};

/**
 * Start the health HTTP listener. Resolves once bound; the returned {@link HealthServer}
 * exposes its URL and a graceful `stop()`. Rejects with {@link HealthPortInUseError} when the
 * port is taken, and with the raw error for any other bind failure.
 */
export function startHealthServer(options: HealthServerOptions): Promise<HealthServer> {
  const { host, port, namespace, streamBaseUrl } = options;
  const startedAt = options.startedAt ?? Date.now();
  const sourcesOf = (): readonly IWorkspaceStatusSource[] =>
    typeof options.sources === "function" ? options.sources() : options.sources;

  const buildStatus = async (): Promise<MirrorStatusResponse> => {
    const serverStatus = options.server?.() ?? OPTIMISTIC_SERVER;
    const auth = options.auth?.() ?? { mode: "none" as const, server: originOf(streamBaseUrl), expired: false };
    const raw = await Promise.all(sourcesOf().map((s) => s.status()));
    const workspaces = raw.map((ws) => decorate(ws, serverStatus, options));
    const degraded =
      !serverStatus.reachable ||
      serverStatus.unauthorized ||
      // Any probe failure counts, including an HTTP error from a host that IS answering: a 502
      // in front of the stream means the tail is not getting commits either.
      serverStatus.lastError !== null ||
      auth.expired ||
      workspaces.some((w) => w.lastReconcileError !== null || !w.connected);
    return {
      status: degraded ? "degraded" : "ok",
      uptimeMs: Date.now() - startedAt,
      pid: process.pid,
      namespace,
      streamBaseUrl,
      configPath: options.configPath ?? null,
      auth,
      server: serverStatus,
      workspaces,
    };
  };

  const buildCatalog = async (): Promise<readonly CatalogWorkspaceEntry[]> => {
    const load = options.catalog;
    if (load === undefined) throw new Error("this mirror has no catalog source");
    const entries = await load();
    const mirrors = new Map<string, { root: string; subtreeRootId: string | null }[]>();
    for (const ws of await Promise.all(sourcesOf().map((s) => s.status()))) {
      const list = mirrors.get(ws.workspaceId) ?? [];
      list.push({ root: ws.root, subtreeRootId: ws.subtreeRootId });
      mirrors.set(ws.workspaceId, list);
    }
    return entries.map((e) => {
      const mine = mirrors.get(e.id) ?? [];
      return {
        id: e.id,
        name: e.name,
        status: e.status,
        mirroredRoot: mine.find((m) => m.subtreeRootId === null)?.root ?? null,
        mirrors: mine,
      };
    });
  };

  const buildTree = async (workspaceId: string): Promise<readonly MirrorTreePage[]> => {
    if (options.tree === undefined) throw new Error("this mirror has no tree source");
    return options.tree(workspaceId);
  };

  const server: Server = createServer((req, res) => {
    // A rejection here would be an unhandled rejection, i.e. a dead SERVICE — infinitely worse
    // than a 500 on one poll.
    handle(req, res, buildStatus, buildCatalog, buildTree).catch((err: unknown) => {
      options.logger?.error("wiki-mirror: health request failed", {
        path: req.url,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) sendJson(res, 500, { error: "internal", message: String(err) });
      else res.end();
    });
  });

  return new Promise<HealthServer>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      reject(err.code === "EADDRINUSE" ? new HealthPortInUseError(host, port) : err);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      // Read the ACTUAL bound port back — robust when `port: 0` auto-assigns (used by tests).
      const address = server.address();
      const boundPort = typeof address === "object" && address !== null ? address.port : port;
      resolve({
        url: `http://${host}:${boundPort}`,
        stop(): Promise<void> {
          return new Promise((res2, rej) => {
            server.close((err) => (err ? rej(err) : res2()));
            // close() waits forever for idle keep-alive sockets; destroy them so it fires.
            server.closeAllConnections();
          });
        },
      });
    });
  });
}

/**
 * Merge probe/catalog detail into a raw source snapshot. `connected` is narrowed here rather
 * than in the tail loop, because only this layer knows whether the HOST is reachable and
 * whether the tail is keeping pace — a subscription handle proves neither.
 */
function decorate(
  ws: MirrorWorkspaceStatus,
  server: ServerProbeStatus,
  options: HealthServerOptions,
): MirrorWorkspaceStatus {
  const probe = options.probe?.(ws.workspaceId);
  const name = options.nameOf?.(ws.workspaceId);
  const stuck = probe?.stuck === true;
  return {
    ...ws,
    ...(name !== undefined ? { name } : {}),
    ...(probe !== undefined ? { stuck, behindSince: probe.behindSince } : {}),
    connected: ws.connected && server.reachable && !server.unauthorized && !stuck,
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  buildStatus: () => Promise<MirrorStatusResponse>,
  buildCatalog: () => Promise<readonly CatalogWorkspaceEntry[]>,
  buildTree: (workspaceId: string) => Promise<readonly MirrorTreePage[]>,
): Promise<void> {
  const path = (req.url ?? "/").split("?")[0];

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed", method: req.method });
    return;
  }
  if (path === "/_mirror/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }
  if (path === "/_mirror/status") {
    sendJson(res, 200, await buildStatus());
    return;
  }
  if (path === "/_mirror/workspaces") {
    try {
      sendJson(res, 200, { workspaces: await buildCatalog() });
    } catch (err) {
      // Unlike /status, this route has no useful degraded body: a client asking for the catalog
      // needs to know it did NOT get one.
      sendJson(res, 503, { error: "catalog_unavailable", message: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  const treeMatch = /^\/_mirror\/workspaces\/([^/]+)\/tree$/.exec(path);
  if (treeMatch !== null) {
    let workspaceId: string;
    try {
      workspaceId = decodeURIComponent(treeMatch[1]);
    } catch {
      sendJson(res, 400, { error: "bad_workspace_id", path });
      return;
    }
    try {
      sendJson(res, 200, { pages: await buildTree(workspaceId) });
    } catch (err) {
      sendJson(res, 503, { error: "tree_unavailable", message: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  sendJson(res, 404, { error: "not_found", path });
}

/** Write a JSON response with the given status and permissive CORS. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...CORS_HEADERS, "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** The origin of a URL, or the input verbatim when it isn't parseable. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
