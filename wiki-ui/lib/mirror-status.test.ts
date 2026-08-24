/**
 * The mirror badge's decision tree. This is the only place a user finds out their local Markdown
 * mirror stopped, so the ORDER matters as much as the states: process-wide failures must be
 * reported once, before any per-workspace verdict.
 */
import { describe, expect, it } from "vitest";

import { mirrorView, type MirrorStatusResponse, type MirrorWorkspaceStatus } from "./mirror-status";

const HEALTH_URL = "http://127.0.0.1:4440";
const WS = "ws:one";

const workspace = (overrides: Partial<MirrorWorkspaceStatus> = {}): MirrorWorkspaceStatus => ({
  workspaceId: WS,
  root: "/repo/docs",
  appliedVersion: 12,
  lastReconcileAt: 1,
  lastReconcileError: null,
  connected: true,
  ...overrides,
});

const payload = (overrides: Partial<MirrorStatusResponse> = {}): MirrorStatusResponse => ({
  status: "ok",
  uptimeMs: 1000,
  namespace: "default",
  streamBaseUrl: "https://wiki.example.com",
  workspaces: [workspace()],
  ...overrides,
});

const view = (data: MirrorStatusResponse, workspaceId = WS): ReturnType<typeof mirrorView> =>
  mirrorView({ phase: "ok", data }, workspaceId, HEALTH_URL);

describe("mirrorView", () => {
  it("hides entirely when the probe is disabled (https page, http loopback)", () => {
    expect(mirrorView({ phase: "disabled" }, WS, HEALTH_URL)).toBeNull();
  });

  it("names the health URL when no mirror process answers", () => {
    expect(mirrorView({ phase: "unreachable" }, WS, HEALTH_URL)).toMatchObject({
      state: "off",
      label: "Mirror off",
      title: expect.stringContaining(HEALTH_URL),
    });
  });

  it("reports a healthy mirror with its workspace name, root and version", () => {
    const v = view(payload({ workspaces: [workspace({ name: "Hotseat Wiki" })] }));
    expect(v).toMatchObject({ state: "live", label: "Mirror" });
    expect(v?.title).toBe("Mirroring Hotseat Wiki to /repo/docs (synced to v12)");
  });

  it("reports an expired grant ONCE, before any per-workspace verdict, and says how to fix it", () => {
    const v = view(
      payload({
        auth: { mode: "oauth", user: "thegoldenmule", expired: true },
        workspaces: [workspace({ connected: false, lastReconcileError: "401" })],
      }),
    );
    expect(v).toMatchObject({ state: "error", label: "Mirror signed out" });
    expect(v?.title).toContain("wiki-mirror login");
    expect(v?.title).toContain("thegoldenmule");
  });

  it("treats a 401 from the stream host the same way, even when the stored grant still looks live", () => {
    const v = view(payload({ server: { reachable: true, lastError: "401", unauthorized: true } }));
    expect(v?.label).toBe("Mirror signed out");
  });

  it("distinguishes an unreachable STREAM HOST (amber, mirror is fine) from a dead mirror", () => {
    const v = view(payload({ server: { reachable: false, lastError: "ECONNREFUSED", unauthorized: false } }));
    expect(v).toMatchObject({ state: "warn", label: "Mirror offline" });
    expect(v?.title).toContain("ECONNREFUSED");
    expect(v?.title).toContain("https://wiki.example.com");
  });

  it("says 'not mirrored' — muted, not alarming — when this workspace isn't configured here", () => {
    expect(view(payload(), "ws:other")).toMatchObject({ state: "absent", label: "Not mirrored" });
  });

  it("surfaces a workspace's own failure with its reason, and notes that it will retry", () => {
    const v = view(
      payload({
        workspaces: [workspace({ name: "Docs", connected: false, lastReconcileError: "root is read-only", nextRetryAt: 99 })],
      }),
    );
    expect(v).toMatchObject({ state: "error", label: "Mirror error" });
    expect(v?.title).toBe("Docs: root is read-only (retrying)");
  });

  it("never renders 'undefined' when an older mirror omits lastReconcileError", () => {
    const ws = { ...workspace(), lastReconcileError: undefined } as unknown as MirrorWorkspaceStatus;
    const v = view(payload({ workspaces: [ws] }));
    expect(v?.title).not.toContain("undefined");
    expect(v?.state).toBe("live");
  });

  it("calls out a mirror the stream has moved ahead of", () => {
    const v = view(payload({ workspaces: [workspace({ name: "Docs", stuck: true })] }));
    expect(v).toMatchObject({ state: "warn", label: "Mirror behind" });
  });

  it("falls back to 'this workspace' when an older mirror sends no name", () => {
    const v = view(payload({ workspaces: [workspace({ connected: false })] }));
    expect(v).toMatchObject({ state: "warn", label: "Mirror offline" });
    expect(v?.title).toContain("this workspace");
  });
});
