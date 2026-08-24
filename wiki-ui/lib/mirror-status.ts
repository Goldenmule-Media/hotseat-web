/**
 * The wiki-mirror health payload and the rule that turns it into one badge.
 *
 * Kept out of the component (and out of `getConfig`) so it can be tested: this decision tree is
 * the only place a user learns their local Markdown mirror has stopped, and its failure modes
 * are ranked deliberately — a process-wide problem (expired credentials, an unreachable host)
 * must be reported ONCE, before any per-workspace verdict, or an expired grant turns every
 * workspace red and points the reader at the network instead of at `wiki-mirror login`.
 *
 * Every field the mirror added recently is OPTIONAL here: wiki-mirror is a separately launched
 * local process that the user may not have restarted, so this must render correctly against an
 * older one.
 */

/** Mirrors wiki-mirror's per-workspace status (kept in sync by shape; wiki-ui can't import wiki-mirror). */
export interface MirrorWorkspaceStatus {
  readonly workspaceId: string;
  readonly name?: string;
  readonly root: string;
  readonly appliedVersion: number;
  readonly lastReconcileAt: number | null;
  readonly lastReconcileError: string | null;
  readonly connected: boolean;
  /** The stream host moved ahead of this mirror and it never caught up. */
  readonly stuck?: boolean;
  /** When a failed emitter will be re-attempted (epoch ms). */
  readonly nextRetryAt?: number | null;
}

/** Mirrors wiki-mirror's `GET /_mirror/status` payload. */
export interface MirrorStatusResponse {
  readonly status: "ok" | "degraded";
  readonly uptimeMs: number;
  readonly namespace: string;
  readonly streamBaseUrl: string;
  readonly auth?: {
    readonly mode: "token" | "oauth" | "none";
    readonly user?: string;
    readonly expired: boolean;
  };
  readonly server?: {
    readonly reachable: boolean;
    readonly lastError: string | null;
    readonly unauthorized: boolean;
  };
  readonly workspaces: readonly MirrorWorkspaceStatus[];
}

/** What the probe knows so far. */
export type MirrorProbe =
  | { readonly phase: "disabled" } // https page can't fetch http://127.0.0.1 (mixed content)
  | { readonly phase: "checking" }
  | { readonly phase: "unreachable" }
  | { readonly phase: "ok"; readonly data: MirrorStatusResponse };

/** A rendered badge: the `data-state` that colors it, its label, and its tooltip. */
export interface MirrorView {
  readonly state: "checking" | "off" | "absent" | "live" | "warn" | "error";
  readonly label: string;
  readonly title: string;
}

/** Map the probe + current workspace to one badge, or null when the indicator should hide. */
export function mirrorView(probe: MirrorProbe, workspaceId: string, healthUrl: string): MirrorView | null {
  if (probe.phase === "disabled") return null;
  if (probe.phase === "checking") return { state: "checking", label: "Mirror", title: "Checking the local mirror…" };
  if (probe.phase === "unreachable") {
    return { state: "off", label: "Mirror off", title: `No wiki-mirror process reachable at ${healthUrl}` };
  }

  const { auth, server } = probe.data;
  // Process-wide problems first — one message beats N red badges saying the same thing.
  if (auth?.expired === true || server?.unauthorized === true) {
    const who = auth?.user !== undefined ? ` as ${auth.user}` : "";
    return {
      state: "error",
      label: "Mirror signed out",
      title: `The local mirror's credentials for ${probe.data.streamBaseUrl} expired — run \`wiki-mirror login\`${who ? ` (was signed in${who})` : ""}`,
    };
  }
  if (server?.reachable === false) {
    return {
      state: "warn",
      label: "Mirror offline",
      title: `The local mirror can't reach ${probe.data.streamBaseUrl}${server.lastError !== null ? `: ${server.lastError}` : ""}`,
    };
  }

  const ws = probe.data.workspaces.find((w) => w.workspaceId === workspaceId);
  if (ws === undefined) {
    return { state: "absent", label: "Not mirrored", title: "A wiki-mirror is running but isn't mirroring this workspace" };
  }
  const name = ws.name ?? "this workspace";
  // `??` normalizes an omitted field: a strict !== null against undefined renders "undefined".
  const failure = ws.lastReconcileError ?? null;
  if (failure !== null) {
    const retry = typeof ws.nextRetryAt === "number" ? " (retrying)" : "";
    return { state: "error", label: "Mirror error", title: `${name}: ${failure}${retry}` };
  }
  if (ws.stuck === true) {
    return { state: "warn", label: "Mirror behind", title: `The stream has moved ahead of the mirror for ${name}` };
  }
  if (!ws.connected) {
    return { state: "warn", label: "Mirror offline", title: `The mirror is running but isn't tailing ${name}` };
  }
  return { state: "live", label: "Mirror", title: `Mirroring ${name} to ${ws.root} (synced to v${ws.appliedVersion})` };
}
