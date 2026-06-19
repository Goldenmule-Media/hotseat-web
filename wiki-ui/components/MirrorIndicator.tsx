"use client";

/**
 * Local Markdown-mirror (the "emitter") status, shown next to the live indicator. It polls the
 * wiki-mirror process's health endpoint at a FIXED localhost URL (`config.mirrorHealthUrl`,
 * default http://127.0.0.1:4440) — deliberately independent of the stream base URL, because the
 * mirror runs on the user's own machine even when the wiki-server is remote. Scoped to the
 * current workspace: it reports whether a mirror is running, and whether THIS workspace is being
 * mirrored and keeping pace.
 *
 */
import { useEffect, useState } from "react";
import { getConfig } from "../lib/config";

/** Mirrors wiki-mirror's status payload (kept in sync by shape; wiki-ui can't import wiki-mirror). */
interface MirrorWorkspaceStatus {
  readonly workspaceId: string;
  readonly root: string;
  readonly appliedVersion: number;
  readonly lastReconcileAt: number | null;
  readonly lastReconcileError: string | null;
  readonly connected: boolean;
}
interface MirrorStatusResponse {
  readonly status: "ok" | "degraded";
  readonly uptimeMs: number;
  readonly namespace: string;
  readonly streamBaseUrl: string;
  readonly workspaces: readonly MirrorWorkspaceStatus[];
}

const POLL_MS = 5000;

type Probe =
  | { phase: "disabled" } // https page can't fetch http://127.0.0.1 (mixed content)
  | { phase: "checking" }
  | { phase: "unreachable" }
  | { phase: "ok"; data: MirrorStatusResponse };

/** Poll `${mirrorHealthUrl}/_mirror/status` every ~5s, paused while the tab is hidden. */
function useMirrorStatus(): Probe {
  const [probe, setProbe] = useState<Probe>({ phase: "checking" });

  useEffect(() => {
    const healthUrl = getConfig().mirrorHealthUrl;
    // Only Chromium treats http-loopback as a secure context; on Firefox/Safari the fetch fails
    // opaquely (indistinguishable from "mirror down"), so hide rather than show a misleading "off".
    const isHttpsToHttp =
      typeof window !== "undefined" && window.location.protocol === "https:" && healthUrl.startsWith("http:");
    const isChromium = typeof navigator !== "undefined" && "userAgentData" in navigator;
    if (isHttpsToHttp && !isChromium) {
      setProbe({ phase: "disabled" });
      return;
    }

    let cancelled = false;
    let controller: AbortController | null = null;
    const poll = async (): Promise<void> => {
      if (typeof document !== "undefined" && document.hidden) return;
      controller?.abort();
      controller = new AbortController();
      try {
        const res = await fetch(`${healthUrl}/_mirror/status`, { signal: controller.signal });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as MirrorStatusResponse;
        if (!cancelled) setProbe({ phase: "ok", data });
      } catch (err) {
        // An abort (unmount, or a superseding poll) is not a reachability failure — ignore it,
        // or a slow request cancelled by the next tick would spuriously flash "Mirror off".
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (!cancelled) setProbe({ phase: "unreachable" });
      }
    };

    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    const onVisible = (): void => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      controller?.abort();
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return probe;
}

/** Map the probe + current workspace to a (data-state, label, tooltip) triple. */
function view(probe: Probe, workspaceId: string): { state: string; label: string; title: string } | null {
  if (probe.phase === "disabled") return null;
  if (probe.phase === "checking") return { state: "checking", label: "Mirror", title: "Checking the local mirror…" };
  if (probe.phase === "unreachable") {
    return { state: "off", label: "Mirror off", title: `No wiki-mirror process reachable at ${getConfig().mirrorHealthUrl}` };
  }
  const ws = probe.data.workspaces.find((w) => w.workspaceId === workspaceId);
  if (ws === undefined) {
    return { state: "absent", label: "Not mirrored", title: "A wiki-mirror is running but isn't mirroring this workspace" };
  }
  if (ws.lastReconcileError !== null) {
    return { state: "error", label: "Mirror error", title: `Last mirror sync failed: ${ws.lastReconcileError}` };
  }
  if (!ws.connected) {
    return { state: "error", label: "Mirror offline", title: "The mirror isn't tailing the live stream" };
  }
  return { state: "live", label: "Mirror", title: `Mirroring to ${ws.root} (synced to v${ws.appliedVersion})` };
}

export function MirrorIndicator({ workspaceId }: { workspaceId: string }): React.JSX.Element | null {
  const probe = useMirrorStatus();
  const v = view(probe, workspaceId);
  if (v === null) return null;
  return (
    <span className="mirror-indicator" data-state={v.state} title={v.title}>
      <span className="dot" />
      {v.label}
    </span>
  );
}
