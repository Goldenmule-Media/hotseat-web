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
import { mirrorView, type MirrorProbe, type MirrorStatusResponse } from "../lib/mirror-status";

const POLL_MS = 5000;

type Probe = MirrorProbe;

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

export function MirrorIndicator({ workspaceId }: { workspaceId: string }): React.JSX.Element | null {
  const probe = useMirrorStatus();
  const v = mirrorView(probe, workspaceId, getConfig().mirrorHealthUrl);
  if (v === null) return null;
  return (
    <span className="mirror-indicator" data-state={v.state} title={v.title}>
      <span className="dot" />
      {v.label}
    </span>
  );
}
