/**
 * Emitter supervision: a workspace that cannot start must stay VISIBLE, keep its reason, and
 * retry itself — the difference between "the docs quietly stopped moving" and a service that
 * heals when you sign back in. The engine is faked (a handle with no events); timers are
 * injected, so these are millisecond tests.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { IWorkspaceHandle, WorkspaceId } from "wiki";
import { Registry } from "wiki/registry";

import { silentLogger } from "../src/logger.js";
import { MarkdownDiskProjector } from "../src/markdown-projection.js";
import { EmitterSupervisor, type EmitterSupervisorDeps } from "../src/supervisor.js";

const WS = "ws:sup-0001" as WorkspaceId;

/** A handle that holds no events — enough for a tail loop to start and reconcile to a no-op. */
function emptyHandle(): IWorkspaceHandle {
  return {
    history: async () => [],
    subscribe: async () => () => {},
  } as unknown as IWorkspaceHandle;
}

describe("wiki-mirror — emitter supervisor", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanup.splice(0)) {
      try {
        await c();
      } catch {
        /* best-effort teardown */
      }
    }
  });

  async function freshRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "wiki-mirror-sup-"));
    cleanup.push(async () => {
      await rm(root, { recursive: true, force: true });
    });
    return root;
  }

  /** A supervisor over a real disk projector, with manual timers. */
  async function makeSupervisor(
    openWorkspace: EmitterSupervisorDeps["openWorkspace"],
    overrides: Partial<EmitterSupervisorDeps> = {},
  ): Promise<{ supervisor: EmitterSupervisor; root: string; fire: () => Promise<void>; pending: () => boolean }> {
    const root = await freshRoot();
    const sink = new MarkdownDiskProjector({ enabled: true, root, workspaces: [WS], layout: "tree" }, silentLogger);
    let scheduled: (() => void) | undefined;
    const supervisor = new EmitterSupervisor(WS, {
      openWorkspace,
      registry: new Registry([]),
      sink,
      logger: silentLogger,
      retryDelaysMs: [10, 20, 40],
      schedule: (fn) => {
        scheduled = fn;
        return 1;
      },
      cancel: () => {
        scheduled = undefined;
      },
      now: () => 1_000,
      ...overrides,
    });
    cleanup.push(() => supervisor.stop());
    return {
      supervisor,
      root,
      pending: () => scheduled !== undefined,
      fire: async () => {
        const fn = scheduled;
        scheduled = undefined;
        fn?.();
        await new Promise((r) => setTimeout(r, 0));
      },
    };
  }

  it("keeps a workspace that failed to open LISTED, with its reason and a scheduled retry", async () => {
    const { supervisor, root, pending } = await makeSupervisor(async () => {
      throw new Error("Workspace \"ws:sup-0001\" does not exist.");
    });

    await supervisor.start();

    const status = await supervisor.status();
    expect(status).toMatchObject({ workspaceId: WS, root, connected: false, appliedVersion: 0, attempts: 1 });
    expect(status.lastReconcileError).toBe('Workspace "ws:sup-0001" does not exist.');
    expect(status.nextRetryAt).toBe(1_010); // now + the first backoff step
    expect(pending()).toBe(true);
    expect(supervisor.running).toBe(false);
  });

  it("never reports an undefined error — wiki-ui renders that literally", async () => {
    const { supervisor } = await makeSupervisor(async () => {
      throw new Error("boom");
    });
    await supervisor.start();
    const status = await supervisor.status();
    expect(Object.prototype.hasOwnProperty.call(status, "lastReconcileError")).toBe(true);
    expect(status.lastReconcileError).not.toBeUndefined();
  });

  it("heals on a retry: the tail starts, the error clears, and the attempt count resets", async () => {
    let attempts = 0;
    const { supervisor, fire } = await makeSupervisor(async () => {
      attempts++;
      if (attempts === 1) throw new Error("still signed out");
      return emptyHandle();
    });

    await supervisor.start();
    expect((await supervisor.status()).connected).toBe(false);

    await fire();

    const status = await supervisor.status();
    expect(status.connected).toBe(true);
    expect(status.lastReconcileError).toBeNull();
    expect(status.attempts).toBe(0);
    expect(status.nextRetryAt).toBeNull();
    expect(supervisor.mirror).toBeDefined();
  });

  it("backs off further on each consecutive failure, holding at the last step", async () => {
    const { supervisor, fire } = await makeSupervisor(async () => {
      throw new Error("nope");
    });

    await supervisor.start();
    expect((await supervisor.status()).nextRetryAt).toBe(1_010);
    await fire();
    expect((await supervisor.status()).nextRetryAt).toBe(1_020);
    await fire();
    expect((await supervisor.status()).nextRetryAt).toBe(1_040);
    await fire();
    expect((await supervisor.status()).nextRetryAt).toBe(1_040); // the last delay repeats
    expect((await supervisor.status()).attempts).toBe(4);
  });

  it("fails an attempt that HANGS — an unreachable host never rejects, it stalls forever", async () => {
    const { supervisor } = await makeSupervisor(() => new Promise<IWorkspaceHandle>(() => {}), {
      startTimeoutMs: 20,
    });

    await supervisor.start();

    const status = await supervisor.status();
    expect(status.connected).toBe(false);
    expect(status.lastReconcileError).toMatch(/timed out .* opening the workspace/);
  });

  it("stop() cancels a pending retry and leaves nothing scheduled", async () => {
    const { supervisor, pending } = await makeSupervisor(async () => {
      throw new Error("nope");
    });
    await supervisor.start();
    expect(pending()).toBe(true);

    await supervisor.stop();
    expect(pending()).toBe(false);
    expect((await supervisor.status()).nextRetryAt).toBeNull();
  });

  it("retryNow() skips the backoff and re-attempts immediately", async () => {
    let attempts = 0;
    const { supervisor } = await makeSupervisor(async () => {
      attempts++;
      if (attempts === 1) throw new Error("first");
      return emptyHandle();
    });

    await supervisor.start();
    await supervisor.retryNow();

    expect((await supervisor.status()).connected).toBe(true);
    expect(attempts).toBe(2);
  });
});
