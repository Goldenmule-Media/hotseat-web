# Testing plan — Mirror (emitter) status in wiki-ui

**Status:** draft

## Planned
_None._

## Passed
- GET /_mirror/health returns 200 {status:'ok'} (start the health server on port 0 over one WorkspaceMirror built via wiki/testing startTestServer + wikiOn).
- GET /_mirror/status returns status, a numeric uptimeMs, and a workspaces[] entry whose root + appliedVersion match the workspace head after a write + sync.
- After a successful reconcile the workspace entry's lastReconcileAt is a number and lastReconcileError is null; a forced reconcile failure flips overall status to 'degraded' with a non-null lastReconcileError.
- CORS: GET /_mirror/status carries access-control-allow-origin:* and an OPTIONS preflight returns 204 with the CORS headers.
- Unknown path → 404; POST /_mirror/status → 405.
- startMirror exposes running.health.url and close() stops the listener (a follow-up fetch is refused); the no-emitters idle path still serves /_mirror/health.
- resolveConfig prefers --health-port / WIKI_MIRROR_HEALTH_PORT over the 4440 default; a non-integer port value throws.
- wiki-ui gate: `npm run typecheck` and `npm run build` pass with MirrorIndicator wired into app/[workspaceId]/layout.tsx (the UI has no component test runner for this; build is the gate).

## Failed
_None._

## References
_None._

## Child pages
_None._
