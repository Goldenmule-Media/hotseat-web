# Implementation plan — Mirror (emitter) status in wiki-ui

**Status:** ready

## Steps
- [x] wiki-mirror/src/mirror.ts: track lastReconcileAt + lastReconcileError (set on each reconcile success/failure and in kick()'s catch); accept `root` via the constructor; add `async status(): Promise<MirrorWorkspaceStatus>` returning { workspaceId, root, appliedVersion: await sink.appliedVersion(ws), lastReconcileAt, lastReconcileError, connected }. Export the MirrorWorkspaceStatus type.
- [x] wiki-mirror/src/config.ts: add DEFAULT_HEALTH_PORT=4440 / DEFAULT_HEALTH_HOST='127.0.0.1'; add healthPort/healthHost to IMirrorConfig + IMirrorConfigFile; resolve flags['health-port'/'health-host'] → env WIKI_MIRROR_HEALTH_PORT/HOST → file → default, with a fail-fast integer guard on the port.
- [x] wiki-mirror/src/health.ts (NEW): node:http server adapted from wiki-server/src/control.ts startControlServer. GET /_mirror/health → 200 {status:'ok'}; GET /_mirror/status → {status:'ok'|'degraded', uptimeMs, namespace, streamBaseUrl, workspaces:[await each mirror.status()]} (degraded if any entry errored or disconnected). Permissive CORS on every response + OPTIONS→204; non-GET→405; unknown path→404; read bound port back when port 0; stop() closes the listener and destroys sockets.
- [x] wiki-mirror/src/main.ts: pass entry.root into the WorkspaceMirror constructor; after building mirrors in startMirror() start the health server, expose it on RunningMirror as `health`, and stop it in close(); ALSO start the health server in the no-emitters idle branch (so the UI sees an up-but-empty mirror) before awaiting forever.
- [x] wiki-ui/lib/config.ts: add mirrorHealthUrl to WikiUiConfig, read from NEXT_PUBLIC_WIKI_MIRROR_HEALTH_URL (default http://127.0.0.1:4440), resolved independently of streamBaseUrl; document it in wiki-ui/.env.example.
- [x] wiki-ui/components/MirrorIndicator.tsx (NEW): a useMirrorStatus() hook polls `${mirrorHealthUrl}/_mirror/status` ~every 5s via fetch+AbortController, pausing while document.hidden; maps the response to a state (checking | ok | degraded | unreachable) and, for the current workspace, whether its entry is present + connected (mirrored/up-to-date vs not-mirrored). Renders nothing when the page is https (mixed content); otherwise a dot+label like LiveIndicator with a tooltip carrying the overall process summary.
- [x] wiki-ui/app/[workspaceId]/layout.tsx: import and render <MirrorIndicator workspaceId={workspaceId}/> next to <LiveIndicator/> in .sidebar-head. wiki-ui/app/globals.css: add a .mirror-indicator block after .live-indicator, reusing the dot/label layout and data-state colors.
- [x] Verify: from the repo root run `npm run typecheck` and `npm run test -w wiki-mirror`; inside wiki-ui/ run `npm run typecheck` and `npm run build` (and wiki-ui's `npm test` if present). Fix and re-verify rather than flipping gates green.

## Data models & interfaces
```typescript
// wiki-mirror/src/mirror.ts — per-workspace status surfaced by WorkspaceMirror.status()
export interface MirrorWorkspaceStatus {
  readonly workspaceId: string;
  readonly root: string;            // absolute on-disk mirror root
  readonly appliedVersion: number;  // await sink.appliedVersion(ws); -1 if never applied
  readonly lastReconcileAt: number | null;     // epoch ms of last successful reconcile
  readonly lastReconcileError: string | null;  // message of the last failed reconcile, else null
  readonly connected: boolean;      // subscribed to the live stream (tailing)
}
```

```typescript
// wiki-mirror/src/health.ts — JSON shape of GET /_mirror/status
export interface MirrorStatusResponse {
  readonly status: "ok" | "degraded"; // degraded if any workspace errored or disconnected
  readonly uptimeMs: number;
  readonly namespace: string;
  readonly streamBaseUrl: string;
  readonly workspaces: readonly MirrorWorkspaceStatus[];
}
```

```typescript
// wiki-mirror/src/config.ts — fixed, configurable defaults (NOT derived from the stream port)
export const DEFAULT_HEALTH_PORT = 4440;
export const DEFAULT_HEALTH_HOST = "127.0.0.1";
// IMirrorConfig gains: readonly healthPort: number; readonly healthHost: string;

// wiki-ui/lib/config.ts — probed independently of streamBaseUrl
// WikiUiConfig gains: readonly mirrorHealthUrl: string;  // default "http://127.0.0.1:4440"
```

## Open questions
_None._

## Resolved questions
_None._

## References
_None._

## Child pages
_None._
