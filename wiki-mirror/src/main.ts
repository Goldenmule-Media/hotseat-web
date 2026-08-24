/**
 * `wiki-mirror` library API + standalone runtime. {@link MirrorService} assembles the engine
 * (pointed at a possibly-remote Durable Streams host), loads the model bundles, and supervises
 * one tail loop per configured emitter. It is the headless, disk-writing sibling of wiki-ui: a
 * parallel consumer of the engine that tails the stream and authors nothing back.
 *
 * It is built to run UNATTENDED (a launchd agent behind a menu-bar app), which is why it does
 * more than open N handles and hope:
 *
 *  - **A failed emitter stays visible and keeps retrying.** Dropping it made a typo, a 403, or
 *    an expired grant look exactly like "not configured", and left it dead until someone
 *    noticed the Markdown had stopped moving.
 *  - **An unreachable host is not fatal at boot.** The service comes up, reports why, and
 *    starts mirroring on its own when the host returns.
 *  - **It restarts itself.** The stream client dies permanently on a 4xx and cannot be revived
 *    through any public seam, so when the probe sees the host come back — or sees a tail fall
 *    behind and stay behind — the service rebuilds the engine (picking up freshly stored
 *    credentials) without dropping the health listener a client is watching.
 */
import { createWiki } from "wiki";
import type { IWiki, IWorkspaceSummary, WorkspaceId } from "wiki";
import { AttachmentClient } from "wiki/attachments";
import { CredentialsStore, defaultCredentialsPath, loginLoopback, resolveAuthorization } from "wiki/auth-client";
import { Registry } from "wiki/registry";
import type { IPageType } from "wiki/authoring";

import { readAuthStatus, type AuthStatus } from "./auth-status.js";
import { CatalogCache } from "./catalog-cache.js";
import { consoleLogger, type Logger } from "./logger.js";
import { resolveConfig, type IMirrorConfig } from "./config.js";
import { dedupePageTypes, loadModels, loadModelsDir } from "./models.js";
import { MarkdownDiskProjector } from "./markdown-projection.js";
import { WorkspaceMirror } from "./mirror.js";
import { ServerProbe } from "./server-probe.js";
import { EmitterSupervisor } from "./supervisor.js";
import { startHealthServer, HealthPortInUseError, type HealthServer } from "./health.js";

/** How long the service refuses to auto-restart again after restarting. */
const MIN_RESTART_INTERVAL_MS = 60_000;

/** A running mirror: the engine, every supervised emitter, the health endpoint, and a `close()`. */
export interface RunningMirror {
  readonly wiki: IWiki;
  /** One per configured emitter, running or not. */
  readonly supervisors: readonly EmitterSupervisor[];
  /** The tail loops that are actually running (a subset of {@link supervisors}). */
  readonly mirrors: readonly WorkspaceMirror[];
  readonly health: HealthServer;
  /** Rebuild the engine + every tail loop in place, keeping the health listener bound. */
  restart(reason: string): Promise<void>;
  close(): Promise<void>;
}

/** The assembled, self-healing mirror process. */
export class MirrorService implements RunningMirror {
  private engine!: { wiki: IWiki; attachments: AttachmentClient };
  private supervisorList: EmitterSupervisor[] = [];
  private probe: ServerProbe | undefined;
  private healthServer!: HealthServer;
  private readonly catalog: CatalogCache;
  private registry!: Registry;
  private pageTypes: readonly IPageType[] = [];
  private restarting: Promise<void> | undefined;
  private deferred: ReturnType<typeof setTimeout> | undefined;
  private lastRestartAt = 0;
  private closed = false;

  constructor(
    private readonly config: IMirrorConfig,
    private readonly logger: Logger,
  ) {
    this.catalog = new CatalogCache(() => this.engine.wiki.listWorkspaces());
  }

  get wiki(): IWiki {
    return this.engine.wiki;
  }

  get supervisors(): readonly EmitterSupervisor[] {
    return this.supervisorList;
  }

  get mirrors(): readonly WorkspaceMirror[] {
    return this.supervisorList.map((s) => s.mirror).filter((m): m is WorkspaceMirror => m !== undefined);
  }

  get health(): HealthServer {
    return this.healthServer;
  }

  /**
   * Bind health FIRST, then build the engine and start every emitter.
   *
   * The order is load-bearing twice over. A client watching :4440 must see the process even
   * while the first emitter is still opening its workspace, which can take a full start timeout
   * against a host that accepts connections and never answers — otherwise the app and wiki-ui
   * both report "no mirror running here", the exact misdiagnosis this service exists to prevent.
   * And the port IS the single-writer guard: discovering another mirror owns it has to happen
   * before this one starts writing to the same roots.
   */
  async start(): Promise<void> {
    // Explicit `models` win over anything discovered under `modelsDir` with the same type id.
    const explicit = await loadModels(this.config.models);
    const discovered =
      this.config.modelsDir !== undefined ? await loadModelsDir(this.config.modelsDir, this.logger) : [];
    this.pageTypes = dedupePageTypes([...explicit, ...discovered], this.logger);
    this.registry = new Registry(this.pageTypes);
    this.buildEngine();

    this.healthServer = await startHealthServer({
      host: this.config.healthHost,
      port: this.config.healthPort,
      namespace: this.config.namespace,
      streamBaseUrl: this.config.streamBaseUrl,
      configPath: this.config.configPath ?? null,
      sources: () => this.supervisorList,
      auth: () => this.authStatus(),
      server: () => this.probe?.status() ?? { reachable: true, lastProbeAt: null, lastError: null, unauthorized: false },
      probe: (id) => this.probe?.workspace(id),
      nameOf: (id) => this.catalog.nameOf(id),
      catalog: () => this.catalog.get(),
      logger: this.logger,
    });
    this.logger.info("wiki-mirror: health endpoint listening", { url: this.healthServer.url });

    await this.startEmitters();

    this.probe = new ServerProbe({
      baseUrl: this.config.streamBaseUrl,
      namespace: this.config.namespace,
      authorization: () => this.authorizationHeader(),
      snapshot: () => Promise.all(this.supervisorList.map((s) => s.status())),
      logger: this.logger,
      ...(this.config.probeIntervalMs !== undefined ? { intervalMs: this.config.probeIntervalMs } : {}),
    });
    this.probe.on((event) => {
      if (event.type === "recovered") {
        void this.restart("the stream host is reachable again");
        return;
      }
      void this.restart(`workspace ${event.workspaceId} stopped keeping pace with the stream`);
    });
    await this.probe.start();
    // Best-effort and NOT awaited past its own timeout: names make every client's output legible,
    // but a mirror runs fine without them.
    void this.catalog.refresh().catch((err: unknown) => {
      this.logger.warn("wiki-mirror: could not read the workspace catalog", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Rebuild the engine and every tail loop, keeping the health listener (and its port) bound.
   * Throttled: an auto-restart within {@link MIN_RESTART_INTERVAL_MS} of the last is dropped, so
   * a flapping host can't put the service in a restart loop.
   */
  async restart(reason: string): Promise<void> {
    if (this.closed) return;
    if (this.restarting !== undefined) return this.restarting;
    const now = Date.now();
    const sinceLast = now - this.lastRestartAt;
    if (sinceLast < MIN_RESTART_INTERVAL_MS) {
      // DEFER, never drop: the probe's `recovered` is edge-triggered and fires once, so a
      // suppressed restart would strand the mirror until the next unrelated failure.
      if (this.deferred === undefined) {
        const delay = MIN_RESTART_INTERVAL_MS - sinceLast;
        this.logger.info("wiki-mirror: restart deferred (too soon after the last)", { reason, delayMs: delay });
        this.deferred = setTimeout(() => {
          this.deferred = undefined;
          void this.restart(reason);
        }, delay);
        this.deferred.unref();
      }
      return;
    }
    this.lastRestartAt = now;
    this.restarting = this.doRestart(reason).finally(() => {
      this.restarting = undefined;
    });
    return this.restarting;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.deferred !== undefined) clearTimeout(this.deferred);
    this.deferred = undefined;
    this.probe?.stop();
    // A restart in flight is rebuilding the very things we are about to tear down; let it finish
    // (it checks `closed` between steps) rather than racing it.
    await this.restarting?.catch(() => {});
    await this.healthServer?.stop();
    await this.stopEmitters();
    await this.engine.wiki.close();
  }

  private async doRestart(reason: string): Promise<void> {
    this.logger.warn("wiki-mirror: restarting the engine", { reason });
    await this.stopEmitters();
    try {
      await this.engine.wiki.close();
    } catch (err) {
      this.logger.warn("wiki-mirror: the old engine did not close cleanly", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (this.closed) return; // close() won the race; do not rebuild what it just tore down
    // A fresh engine re-resolves credentials, so a `wiki-mirror login` in another process takes
    // effect here without a process restart.
    this.buildEngine();
    this.probe?.reset();
    await this.startEmitters();
    void this.catalog.refresh().catch(() => {});
    this.logger.info("wiki-mirror: restarted", { workspaces: this.mirrors.length });
  }

  /** Build the engine + attachment client against the CURRENT credentials on disk. */
  private buildEngine(): void {
    // Authorization, by precedence (shared with migrate-workspace): an explicit static token
    // (flags → WIKI_MIRROR_TOKEN → config file) rides every request verbatim; else a stored
    // OAuth grant for this server (`wiki-mirror login`) becomes a REFRESHING header function —
    // the engine's IStreamHeaders seam evaluates it per request, so a near-expiry access token
    // renews itself mid-tail; else no headers key at all (an open server). Never logged.
    const authorization = resolveAuthorization(this.config.streamBaseUrl, this.config.token);
    const streamHeaders = authorization !== undefined ? { authorization } : undefined;
    const wiki = createWiki({
      stream: {
        baseUrl: this.config.streamBaseUrl,
        namespace: this.config.namespace,
        ...(streamHeaders !== undefined ? { headers: streamHeaders } : {}),
      },
      pageTypes: this.pageTypes,
    });
    // Attachments ride the SAME origin and the same credentials as the stream: a mirror
    // that may read a workspace's events may read the bytes those events reference.
    const attachments = new AttachmentClient({
      baseUrl: this.config.streamBaseUrl,
      namespace: this.config.namespace,
      ...(streamHeaders !== undefined ? { headers: streamHeaders } : {}),
    });
    this.engine = { wiki, attachments };
  }

  /** One supervisor per configured emitter; a failure to start is recorded, never thrown. */
  private async startEmitters(): Promise<void> {
    const supervisors = this.config.emitters.map((entry) => {
      const sink = new MarkdownDiskProjector(
        { enabled: true, root: entry.root, workspaces: [entry.workspaceId], layout: "tree" },
        this.logger.child?.({ subsystem: "markdown-disk", workspace: entry.workspaceId, root: entry.root }) ??
          this.logger,
        this.engine.attachments,
      );
      return new EmitterSupervisor(entry.workspaceId as WorkspaceId, {
        openWorkspace: (id) => this.engine.wiki.openWorkspace(id),
        registry: this.registry,
        sink,
        logger: this.logger.child?.({ subsystem: "mirror", workspace: entry.workspaceId }) ?? this.logger,
      });
    });
    this.supervisorList = supervisors;
    await Promise.all(supervisors.map((s) => s.start()));
  }

  private async stopEmitters(): Promise<void> {
    const supervisors = this.supervisorList;
    this.supervisorList = [];
    await Promise.all(supervisors.map((s) => s.stop()));
  }

  private authStatus(): AuthStatus {
    return readAuthStatus(this.config.streamBaseUrl, {
      hasExplicitToken: this.config.token !== undefined && this.config.token.length > 0,
    });
  }

  /** Resolve the `authorization` header the probe should send, or undefined for an open server. */
  private async authorizationHeader(): Promise<string | undefined> {
    const value = resolveAuthorization(this.config.streamBaseUrl, this.config.token);
    if (value === undefined) return undefined;
    return typeof value === "function" ? await value() : value;
  }
}

/**
 * Build the engine + registry from the loaded models, then start one supervised tail loop per
 * emitter (one process, N workspaces). Throws only on a fatal boot condition — a model bundle
 * that can't load, or a health port that can't be bound; a workspace that can't be opened is
 * reported, not fatal.
 */
export async function startMirror(config: IMirrorConfig, logger: Logger = consoleLogger()): Promise<RunningMirror> {
  const service = new MirrorService(config, logger);
  await service.start();
  return service;
}

/**
 * Poll the stream host until it answers (any HTTP response counts as reachable), so the mirror
 * tolerates the server still booting — the single-command dev loop starts both at once. Unlike
 * a one-shot CLI, a SERVICE must not die because the network wasn't up yet: after `timeoutMs`
 * this gives up and returns, leaving the supervisors and the probe to bring the mirror up when
 * the host appears. Host-side wall-clock — the engine-determinism rule applies to
 * reducers/renderers, not this loop.
 */
async function waitForStreamHost(baseUrl: string, logger: Logger, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    try {
      // Per-attempt timeout so a connection that accepts but never responds (a hung/half-open
      // host) can't pin this await past the deadline — without it the retry loop never advances.
      await fetch(baseUrl, { method: "GET", signal: AbortSignal.timeout(5000) });
      return true; // any response (even a 404) means the host is up
    } catch (err) {
      if (Date.now() >= deadline) {
        logger.warn("wiki-mirror: the stream host is not reachable yet — starting anyway", {
          baseUrl,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
      if (attempt === 0) logger.warn("wiki-mirror: waiting for stream host", { baseUrl });
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/**
 * Standalone runtime: resolve config from `process.argv`/`process.env`/the config file, start
 * the service, and run until SIGINT/SIGTERM. A boot error rejects (the `./bin` wrapper exits
 * nonzero, and a supervisor restarts us); a port already owned by another mirror exits 0,
 * because respawning into the same collision helps nobody.
 */
export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  const logger = consoleLogger();
  // `wiki-mirror login [--stream-url …]`: run the OAuth loopback sign-in against the
  // resolved server and persist the grant to ~/.wiki/credentials.json, then exit. A RUNNING
  // mirror picks the new grant up on its next self-restart — no token copying, no kill.
  if (argv[0] === "login") {
    const loginConfig = resolveConfig(argv.slice(1), env);
    const credentials = await loginLoopback({ serverUrl: loginConfig.streamBaseUrl, clientName: "wiki-mirror" });
    logger.info("wiki-mirror: signed in", { server: new URL(loginConfig.streamBaseUrl).origin, user: credentials.user });
    return;
  }
  // `wiki-mirror logout [--stream-url …]`: forget the stored grant for the resolved server.
  // The running mirror keeps the token it already holds in memory until it rebuilds its engine,
  // so a caller that wants sign-out to take effect NOW restarts it afterwards.
  if (argv[0] === "logout") {
    const logoutConfig = resolveConfig(argv.slice(1), env);
    const origin = new URL(logoutConfig.streamBaseUrl).origin;
    // Resolve the path from the INJECTED env, not process.env: `main` takes an env, and a
    // credentials store that ignored it would read a different file than the rest of this run.
    const existed = new CredentialsStore(defaultCredentialsPath(env)).delete(logoutConfig.streamBaseUrl);
    if (existed) logger.info("wiki-mirror: signed out", { server: origin });
    else logger.warn("wiki-mirror: nothing to sign out of", { server: origin });
    return;
  }
  const config = resolveConfig(argv, env);
  if (config.emitters.length === 0) {
    // An EXPLICITLY named config with nothing to do is a misconfiguration — fail loud. The
    // implicit per-machine default simply not existing means "this machine mirrors nothing":
    // the service still runs, so a client can reach it, see the server + credentials, and
    // configure the first emitter.
    if (config.configWasExplicit === true) {
      throw new Error(
        "wiki-mirror: no emitters configured — add them to the --config file, or pass --workspace <id> --root <dir>",
      );
    }
    logger.warn(
      `wiki-mirror: no emitters configured in ${config.configPath} — running idle; add emitters and restart to mirror`,
      {},
    );
  }

  await waitForStreamHost(config.streamBaseUrl, logger);
  const running = await startMirror(config, logger);
  const shutdown = (): void => {
    void running.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  logger.info("wiki-mirror started", {
    namespace: config.namespace,
    streamBaseUrl: config.streamBaseUrl,
    workspaces: config.emitters.length,
    configPath: config.configPath,
    pid: process.pid,
  });
}

export { HealthPortInUseError };
