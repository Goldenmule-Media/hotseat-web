# wiki-mirror-menubar

**Status:** current

## Kind
package

## Summary
The **macOS menu-bar console** for the local `wiki-mirror` service: a SwiftUI `MenuBarExtra` app (SwiftPM, macOS 14+) that shows at a glance whether the mirror is running, signed in, and keeping pace, and that edits which workspaces are mirrored where. It is not a workspace member and builds on its own, exactly like `wiki-ui`.

## Purpose
Make the mirror's state legible without a terminal. The mirror is a background process whose failures are quiet by nature: an expired grant, an unreachable host, or a wedged tail all look identical from the outside, which is Markdown that simply stops changing. The app turns that into a glyph in the menu bar and one sentence naming the cause, and gives the two actions that fix almost every case, which are signing in again and restarting.

It also owns the configuration surface. The `workspaceId → root` mapping is per-machine local state that previously only existed as a hand-edited JSON file, so choosing a folder for a workspace meant knowing the file's schema and the mirror's validation rules by heart.

## Design notes
**launchd owns the process, not the app.** The app is a console, not a supervisor. The Markdown has to keep tracking the wiki whether or not anyone is looking at a status icon, so quitting the app never stops mirroring and an app crash cannot take the service down. That also makes the app simple: no child-process supervision, no output pumping, no PID files. It reads `/_mirror/status`, writes the config file, and shells out to `launchctl`.

**Installing shells out to **`wiki-mirror/scripts/install-agent.sh`**.** An app that wrote its own plist would drift from the script the moment either changed, so there is exactly one definition of the launchd job. The app reads the installed plist back to infer which runtime is in use (source, dist, or portable) and where the installer that produced it lives, which also means a user who ran the script by hand gets a fully configured app with no setup.

**Config edits target the file the RUNNING mirror reported reading** (`status.configPath`), not a guess at the default path, so a mirror started with `--config` elsewhere is still configured by this window. Saving keeps a `.bak`, writes atomically, preserves unknown keys verbatim (the file is shared with the CLI and hand-edited, so silently dropping `token` or `healthPort` would be worse than no editor), enforces the mirror's own rules (absolute roots, no duplicate workspace, one root per workspace), and then restarts the agent, because the mirror reads its config once at startup.

**State is carried by SHAPE in the menu bar and by color inside the panel.** The menu bar renders its label monochrome, so a color-coded dot would be invisible there. Each state gets a distinct SF Symbol instead. Process-wide problems outrank per-workspace ones for the same reason wiki-ui ranks them that way: an expired grant is one line saying so, not seven red workspaces pointing at the network.

## Components
_No components._

## Dependencies
- **depends-on** → [wiki-mirror](architecture:mqa0p1qp-00po-bgsbah) — Reads its health endpoint, edits its config file, and installs it via its own install-agent.sh. Ships no engine and holds no credentials of its own.

## Code references
- class `MirrorStore` in `wiki-mirror-menubar/Sources/WikiMirrorMenuBar/MirrorStore.swift`
- type `MirrorClient` in `wiki-mirror-menubar/Sources/WikiMirrorMenuBar/MirrorClient.swift`
- type `LaunchAgent` in `wiki-mirror-menubar/Sources/WikiMirrorMenuBar/LaunchAgent.swift`
- type `MirrorConfigFile` in `wiki-mirror-menubar/Sources/WikiMirrorMenuBar/MirrorConfig.swift`
- `wiki-mirror-menubar/scripts/bundle-app.sh`

## Data model
No state of its own. It decodes `MirrorStatus` and `CatalogWorkspace` from the mirror's health endpoint (every recently added field optional, because the mirror is separately installed and may be older than the app), and reads and writes `MirrorConfigFile { streamBaseUrl, namespace, emitters: { workspaceId, root }[], extra }`, where `extra` carries every key the app does not model so a round-trip loses nothing.

## Usage
Built from `wiki-mirror-menubar/` with `./scripts/bundle-app.sh --install`, which runs `swift build -c release`, wraps the executable in `WikiMirror.app` (SwiftPM emits a bare binary, and `LSUIElement` plus `MenuBarExtra` both need a bundle), ad-hoc signs it, copies it to `/Applications`, and launches it. `swift build` alone only typechecks and links.

The panel lists each mirrored workspace with its applied version, how long ago it last synced, and any error. Its actions are Restart, Sign in (which runs the mirror's own `login` command, taken from the installed plist, so the app never hardcodes a runtime), Logs, and Configure. The Configure window has a Mirrors tab (server, namespace, and the emitter table, whose workspace picker is fed by `GET /_mirror/workspaces`) and a Service tab (install, reinstall, uninstall, the inferred runtime, and a login-item toggle via `SMAppService`).

It polls `http://127.0.0.1:4440/_mirror/status` every five seconds. The endpoint is loopback and unauthenticated, matching the mirror's local-only trust model.

## Invariants & constraints
- The app never owns the mirror process: launchd starts and restarts it, so mirroring continues when the app is closed.
- Rewriting the config file preserves every key the app does not model, keeps a .bak, and refuses to write a config the mirror would reject.
- The app holds no credentials: signing in runs the mirror's own login command, and tokens live only in ~/.wiki/credentials.json.

## Synced commit
17b2335
