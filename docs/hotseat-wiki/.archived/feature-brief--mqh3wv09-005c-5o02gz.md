# Feature: Mirror (emitter) status in wiki-ui

**Status:** shipped

## Summary
Make the local Markdown **emitter** (the `wiki-mirror` process) report its health, and surface that status in wiki-ui. Today `wiki-mirror` is a headless tail-loop with no HTTP surface and `WorkspaceMirror` exposes nothing. We add (1) a small loopback HTTP health server in `wiki-mirror` (`GET /_mirror/health`, `GET /_mirror/status`) on a fixed configurable port (default **4440**) with permissive CORS, backed by a new per-workspace `status()` accessor; and (2) a `MirrorIndicator` in wiki-ui that **always probes a fixed localhost URL** (default `http://127.0.0.1:4440`, independent of the stream base URL — the mirror runs on the user's machine even when the wiki-server is remote), polling every ~5s and showing, for the current workspace, whether the mirror is up and keeping pace. Graceful when no mirror is running; hidden under https where the browser blocks the mixed-content fetch.

## Components affected
- wiki-mirror health server — src/health.ts (NEW): loopback http.Server, GET /_mirror/health + /_mirror/status, permissive CORS, modeled on wiki-server/src/control.ts
- WorkspaceMirror.status() — src/mirror.ts: per-workspace status (workspaceId, root, appliedVersion, lastReconcileAt, lastReconcileError, connected)
- wiki-mirror config — src/config.ts: healthPort/healthHost (defaults 4440 / 127.0.0.1), flags → env (WIKI_MIRROR_HEALTH_*) → file
- wiki-mirror runtime — src/main.ts: start/stop the health server in startMirror() and the no-emitters idle branch
- wiki-ui MirrorIndicator — components/MirrorIndicator.tsx (NEW) + useMirrorStatus poll hook + .mirror-indicator CSS
- wiki-ui wiring — lib/config.ts (mirrorHealthUrl), app/[workspaceId]/layout.tsx, .env.example

## Design constraints
1. The UI probes a FIXED localhost URL (default http://127.0.0.1:4440), resolved INDEPENDENTLY of NEXT_PUBLIC_WIKI_STREAM_BASE_URL — the mirror is local even when the wiki-server is remote.
2. The health endpoint sets permissive CORS (access-control-allow-origin: *) — a deliberate divergence from wiki-server's CORS-free loopback control listener — so the browser at localhost:3000 can read it cross-origin.
3. Bind loopback (127.0.0.1) by default; the endpoint is unauthenticated and exposes local roots/versions, matching the mirror's local-only trust model (host overridable via WIKI_MIRROR_HEALTH_HOST).
4. Under https the browser blocks fetching http://127.0.0.1 (mixed content); the indicator detects this and renders nothing rather than a false 'unreachable'. Known limitation of the deployed UI; acceptable per 'always try the localhost port'.
5. The health server runs even when zero workspaces are configured, so the UI distinguishes 'no mirror process' (unreachable) from 'mirror up, this workspace not mirrored'.
6. wiki-mirror imports use .js extensions (compiled Node); wiki-ui uses extensionless source imports. Date.now()/uptimeMs is fine here (runtime, not a reducer/renderer).
7. Config is read once at startup (the port can't change live); 4440 is a fixed configurable default, NOT derived from the stream port. node:http is a builtin — no package.json / tsdown change.

## Open questions
_None._

## Resolved questions
_None._

## References
_None._

## Child pages
- [Implementation plan — Mirror (emitter) status in wiki-ui](implementation-plan:mqh3wv09-005d-iff8c0)
- [Testing plan — Mirror (emitter) status in wiki-ui](testing-plan:mqh3wv09-005e-kqcoc8)
- [Spec — Mirror (emitter) status in wiki-ui](feature-spec:mqh3wv09-005f-lh3it)

## Commits
- `a2093b3` feat(mirror,ui): emitter health endpoint + Mirror status in wiki-ui
- `7745e21` fix(wiki-ui): move Mirror status to the sidebar foot by the account
