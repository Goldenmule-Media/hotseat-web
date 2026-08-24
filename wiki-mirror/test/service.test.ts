/**
 * The self-healing half of the service: `MirrorService.restart()` rebuilds the ENGINE in place.
 *
 * That is the only recovery path there is. The stream client dies permanently on a 4xx and the
 * refreshing auth header caches the grant it first read, so a mirror whose credentials expired
 * can never recover by retrying — every layer has to be rebuilt, and the health listener a client
 * is watching has to survive that (its port must not move, and its answers must not gap).
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IWiki, IWorkspaceHandle } from "wiki";
import { startTestServer, wikiOn } from "wiki/testing";

import { silentLogger } from "../src/logger.js";
import { HealthPortInUseError } from "../src/health.js";
import { startMirror, type RunningMirror } from "../src/main.js";

describe("wiki-mirror — the service", () => {
  let server: { url: string; stop: () => Promise<void> };
  let url: string;
  let writerWiki: IWiki;
  let writer: IWorkspaceHandle;
  const cleanup: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    server = await startTestServer();
    url = server.url;
    // No page types anywhere in this file: an EMPTY workspace folds fine with an empty registry,
    // which lets these tests be about the service's lifecycle rather than about schema.
    writerWiki = wikiOn(url, [], { namespace: "test" });
    writer = await writerWiki.createWorkspace({ name: "Docs" });
  });

  afterEach(async () => {
    for (const c of cleanup.splice(0)) {
      try {
        await c();
      } catch {
        /* best-effort teardown */
      }
    }
    await writerWiki.close();
    await server.stop();
  });

  async function freshRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "wiki-mirror-service-"));
    cleanup.push(async () => {
      await rm(root, { recursive: true, force: true });
    });
    return root;
  }

  async function start(root: string): Promise<RunningMirror> {
    const running = await startMirror(
      {
        streamBaseUrl: url,
        namespace: "test",
        models: [],
        emitters: [{ workspaceId: writer.id, root }],
        healthHost: "127.0.0.1",
        healthPort: 0,
      },
      silentLogger,
    );
    cleanup.push(() => running.close());
    return running;
  }

  /** Poll the health endpoint until `predicate` holds, so tests assert what a CLIENT would see. */
  async function until(
    healthUrl: string,
    predicate: (body: { status: string; workspaces: { appliedVersion: number; connected: boolean }[] }) => boolean,
    what: string,
    timeoutMs = 10_000,
  ): Promise<{ workspaces: { appliedVersion: number; connected: boolean }[] }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const body = await (await fetch(`${healthUrl}/_mirror/status`)).json();
      if (predicate(body)) return body;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(body)}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it("keeps tailing after a restart — a new engine, the same listener, no lost commits", async () => {
    const root = await freshRoot();
    const running = await start(root);
    const healthUrl = running.health.url;

    const before = await until(healthUrl, (b) => b.workspaces[0]?.connected === true, "the first tail");
    const startingVersion = before.workspaces[0].appliedVersion;

    await running.restart("test");

    // Same port: a client polling this URL must not notice the engine was replaced.
    expect(running.health.url).toBe(healthUrl);
    expect(running.mirrors).toHaveLength(1);
    await until(healthUrl, (b) => b.workspaces[0]?.connected === true, "the rebuilt tail");

    // The REBUILT engine's subscription is live: a commit made after the restart lands on disk
    // without anyone forcing a sync.
    await writer.rename("Docs renamed");
    const after = await until(
      healthUrl,
      (b) => b.workspaces[0].appliedVersion > startingVersion,
      "the post-restart commit to be mirrored",
    );
    expect(after.workspaces[0].appliedVersion).toBeGreaterThan(startingVersion);
  });

  it("survives back-to-back restarts without leaking tail loops", async () => {
    const running = await start(await freshRoot());
    await until(running.health.url, (b) => b.workspaces[0]?.connected === true, "the first tail");

    await running.restart("one");
    await running.restart("two"); // suppressed by the throttle, must not throw or duplicate
    await running.restart("three");

    expect(running.mirrors).toHaveLength(1);
    expect(running.supervisors).toHaveLength(1);
    const body = await until(running.health.url, (b) => b.workspaces.length === 1, "one workspace");
    expect(body.workspaces).toHaveLength(1);
  });

  it("close() stops everything, including a service that was restarted", async () => {
    const running = await start(await freshRoot());
    await running.restart("test");
    await running.close();

    await expect(fetch(`${running.health.url}/_mirror/status`)).rejects.toThrow();
    // A restart after close must be a no-op rather than resurrecting the engine.
    await running.restart("after close");
    await expect(fetch(`${running.health.url}/_mirror/status`)).rejects.toThrow();
  });

  it("refuses to start a SECOND mirror on the same health port, before it writes anything", async () => {
    // The port IS the single-writer guard: two mirrors on one root clobber each other's manifest.
    // bin.ts turns this error into a clean exit 0 so launchd parks the loser instead of respawning
    // it into the same collision every 30 seconds.
    const first = await start(await freshRoot());
    const port = Number(new URL(first.health.url).port);
    const secondRoot = await freshRoot();

    await expect(
      startMirror(
        {
          streamBaseUrl: url,
          namespace: "test",
          models: [],
          emitters: [{ workspaceId: writer.id, root: secondRoot }],
          healthHost: "127.0.0.1",
          healthPort: port,
        },
        silentLogger,
      ),
    ).rejects.toBeInstanceOf(HealthPortInUseError);

    // Nothing was written: the guard has to run BEFORE the emitters touch the root.
    expect(await readdir(secondRoot)).toEqual([]);
  });

  it("serves a config path and a pid so a client edits the right file and sees the right process", async () => {
    const running = await start(await freshRoot());
    const body = await (await fetch(`${running.health.url}/_mirror/status`)).json();
    expect(body.pid).toBe(process.pid);
    expect(body.configPath).toBeNull(); // hand-built config: no file was resolved
  });
});
