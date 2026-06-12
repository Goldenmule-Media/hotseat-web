/**
 * `wiki-mirror` library API + standalone runtime. {@link startMirror} assembles the engine
 * (pointed at a possibly-remote Durable Streams host), loads the model bundles, and starts one
 * {@link WorkspaceMirror} tail loop per configured emitter. It is the headless, disk-writing
 * sibling of wiki-ui: a parallel consumer of the engine that tails the stream and authors
 * nothing back. The standalone {@link main} resolves config from flags/env/file and runs until
 * a signal; a fatal boot error (bad config, unreachable stream, unknown model) exits nonzero.
 */
import { createWiki } from "wiki";
import type { IWiki, WorkspaceId } from "wiki";
import { loginLoopback, resolveAuthorization } from "wiki/auth-client";
import { Registry } from "wiki/registry";

import { consoleLogger, type Logger } from "./logger.js";
import { resolveConfig, type IMirrorConfig } from "./config.js";
import { loadModels } from "./models.js";
import { MarkdownDiskProjector } from "./markdown-projection.js";
import { WorkspaceMirror } from "./mirror.js";

/** A running mirror: every workspace tail loop, plus a `close()` that tears them all down. */
export interface RunningMirror {
  readonly wiki: IWiki;
  readonly mirrors: readonly WorkspaceMirror[];
  close(): Promise<void>;
}

/**
 * Build the engine + registry from the loaded models, then start one {@link WorkspaceMirror}
 * per emitter entry (one process, N workspaces). Throws if a model bundle can't load or a
 * workspace can't be opened — a fatal boot condition the caller surfaces as a nonzero exit.
 */
export async function startMirror(
  config: IMirrorConfig,
  logger: Logger = consoleLogger(),
): Promise<RunningMirror> {
  const pageTypes = await loadModels(config.models);
  const registry = new Registry(pageTypes);
  // Authorization, by precedence (shared with migrate-workspace): an explicit static token
  // (flags → WIKI_MIRROR_TOKEN → config file) rides every request verbatim; else a stored
  // OAuth grant for this server (`wiki-mirror login`) becomes a REFRESHING header function —
  // the engine's IStreamHeaders seam evaluates it per request, so a near-expiry access token
  // renews itself mid-tail; else no headers key at all (an open server). Never logged.
  const authorization = resolveAuthorization(config.streamBaseUrl, config.token);
  const wiki = createWiki({
    stream: {
      baseUrl: config.streamBaseUrl,
      namespace: config.namespace,
      ...(authorization !== undefined ? { headers: { authorization } } : {}),
    },
    pageTypes,
  });

  const mirrors: WorkspaceMirror[] = [];
  for (const entry of config.emitters) {
    try {
      const handle = await wiki.openWorkspace(entry.workspaceId as WorkspaceId);
      const sink = new MarkdownDiskProjector(
        { enabled: true, root: entry.root, workspaces: [entry.workspaceId], layout: "tree" },
        logger.child?.({ subsystem: "markdown-disk", workspace: entry.workspaceId, root: entry.root }) ?? logger,
      );
      const mirror = new WorkspaceMirror(
        handle,
        registry,
        sink,
        entry.workspaceId as WorkspaceId,
        logger.child?.({ subsystem: "mirror", workspace: entry.workspaceId }) ?? logger,
      );
      await mirror.start();
      mirrors.push(mirror);
      logger.info("wiki-mirror: mirroring workspace", { workspace: entry.workspaceId, root: entry.root });
    } catch (err) {
      // One workspace failing — a missing/typo'd id, a page type this mirror didn't load, a
      // transient I/O error during the boot back-fill — must NOT strand the others (the old
      // per-workspace-resilient reconcile guaranteed this). Log and skip; a restart re-attempts
      // it. Any half-opened engine handle is reclaimed by `wiki.close()` in `close()` below.
      logger.warn("wiki-mirror: skipping workspace (boot failed)", {
        workspace: entry.workspaceId,
        root: entry.root,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    wiki,
    mirrors,
    async close(): Promise<void> {
      for (const m of mirrors) await m.stop();
      await wiki.close();
    },
  };
}

/**
 * Poll the stream host until it answers (any HTTP response counts as reachable), so the mirror
 * tolerates the server still booting — the single-command dev loop starts both at once. A host
 * that never comes up within `timeoutMs` is a fatal boot error (nonzero exit). Host-side
 * wall-clock — the engine-determinism rule applies to reducers/renderers, not this loop.
 */
async function waitForStreamHost(baseUrl: string, logger: Logger, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    try {
      // Per-attempt timeout so a connection that accepts but never responds (a hung/half-open
      // host) can't pin this await past the deadline — without it the retry loop never advances.
      await fetch(baseUrl, { method: "GET", signal: AbortSignal.timeout(5000) });
      return; // any response (even a 404) means the host is up
    } catch (err) {
      if (Date.now() >= deadline) {
        throw new Error(
          `wiki-mirror: stream host at ${baseUrl} is unreachable after ${Math.round(timeoutMs / 1000)}s: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
      if (attempt === 0) logger.warn("wiki-mirror: waiting for stream host", { baseUrl });
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/**
 * Standalone runtime: resolve config from `process.argv`/`process.env`/the config file, start
 * the mirror, and run until SIGINT/SIGTERM. A boot error rejects (the `./bin` wrapper exits
 * nonzero).
 */
export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  const logger = consoleLogger();
  // `wiki-mirror login [--stream-url …]`: run the OAuth loopback sign-in against the
  // resolved server and persist the grant to ~/.wiki/credentials.json, then exit. The
  // mirror itself picks the grant up on its next start (no token copying).
  if (argv[0] === "login") {
    const loginConfig = resolveConfig(argv.slice(1), env);
    const credentials = await loginLoopback({ serverUrl: loginConfig.streamBaseUrl, clientName: "wiki-mirror" });
    logger.info("wiki-mirror: signed in", { server: new URL(loginConfig.streamBaseUrl).origin, user: credentials.user });
    return;
  }
  const config = resolveConfig(argv, env);
  if (config.emitters.length === 0) {
    // An EXPLICITLY named config with nothing to do is a misconfiguration — fail loud.
    // The implicit per-machine default simply not existing means "this machine mirrors
    // nothing": idle instead of exiting, because the root `npm start` runs us under
    // `concurrently -k`, where ANY exit (even 0) kills the wiki-server alongside.
    if (config.configWasExplicit === true) {
      throw new Error(
        "wiki-mirror: no emitters configured — add them to the --config file, or pass --workspace <id> --root <dir>",
      );
    }
    logger.warn(
      "wiki-mirror: no emitters configured (no ~/.wiki/wiki-mirror.config.json on this machine) — idling; add emitters and restart to mirror",
      {},
    );
    await new Promise<never>(() => {});
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
  });
}
