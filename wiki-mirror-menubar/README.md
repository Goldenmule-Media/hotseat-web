# wiki-mirror-menubar

A macOS menu-bar console for the local [`wiki-mirror`](../wiki-mirror) service: is the mirror
running, is it signed in, is each workspace keeping pace — and which folders get mirrored where.

**launchd owns the mirror; this app only watches and configures it.** The Markdown has to keep
tracking the wiki whether or not anyone is looking at a status icon, so quitting the app does not
stop mirroring, and the app crashing cannot take the service down. It reads the mirror's health
endpoint (`http://127.0.0.1:4440`), edits `~/.wiki/wiki-mirror.config.json`, and drives
`launchctl`. It is not a workspace member — it has its own SwiftPM build, like `wiki-ui` has its
own Next build.

## Install

The app ships **with the mirror** in one release artifact, so installing that gets you both:

```sh
gh release download --repo Goldenmule-Media/hotseat-web --pattern '*-macos.tar.gz'
tar -xzf wiki-mirror-*-macos.tar.gz
./wiki-mirror-*-macos/install.sh          # add --app-only if a mirror is already running
```

Requires macOS 14+ (and Node 20+ for the mirror half). See
[`wiki-mirror/README.md`](../wiki-mirror/README.md) for the service it watches.

## Build it from this checkout

```sh
cd wiki-mirror-menubar
./scripts/bundle-app.sh --install     # builds, copies to /Applications, launches it
./scripts/bundle-app.sh --universal   # arm64 + x86_64, what a release ships
```

`swift build` alone produces a bare executable; the bundler wraps it in `WikiMirror.app`, which
is what `LSUIElement` (no Dock icon) and `MenuBarExtra` need, and ad-hoc signs it. Requires
macOS 14+ and Xcode's Swift toolchain. `swift test` covers the two pieces that can quietly do
damage: the config round-trip (it must never drop a key it does not model) and the `login`
command inferred from the installed plist.

Install the service itself from the app's **Service** tab, or from a terminal:

```sh
../wiki-mirror/scripts/install-agent.sh --mode source      # this repo, via tsx
```

## What the icon means

The menu bar renders glyphs monochrome, so state is carried by SHAPE (color returns inside the
panel):

| Glyph | State |
|---|---|
| `arrow.triangle.2.circlepath` | mirroring, everything keeping pace |
| `tray` | connected but nothing is configured to mirror |
| `exclamationmark.triangle` | at least one workspace is failing or not tailing |
| `person.crop.circle.badge.exclamationmark` | the grant expired — **Sign in…** |
| `bolt.horizontal.circle` | the mirror is up but can't reach the wiki server |
| `pause.circle` / `circle.dotted` | the agent is stopped / not installed |

Process-wide problems outrank per-workspace ones: an expired grant is one line saying so, not
seven red workspaces pointing at the network.

## Updating itself

The app checks the repo's GitHub releases on launch and daily, and offers a one-click update: it
downloads the release tarball, verifies it against the `.sha256` published beside it, unpacks it,
and hands off to the release's own `install.sh` under `nohup` — which quits the app, replaces the
bundle, and relaunches. Output lands in `~/Library/Logs/wiki-mirror/update.log`, because an
install that fails after the app dies leaves nothing else to read.

Three things worth knowing:

- **It checks, it does not install.** Updating restarts the mirror service, and doing that
  mid-edit without asking is not a courtesy.
- **On a dev machine it updates only the app.** If the launchd job runs in `source` or `dist`
  mode, installing the mirror half would repoint the service at a portable copy and orphan the
  checkout it was built to track, so the hand-off passes `--app-only`.
- **The checksum is integrity, not authenticity.** It catches a truncated or corrupted download.
  Whoever can publish a release can publish a matching checksum; the trust anchor is HTTPS to
  GitHub plus an allow-list of GitHub hosts for the download URL.

Releases are filtered by the `wiki-mirror-v` tag prefix rather than asking GitHub for "the latest
release", so a release for anything else in the same repo cannot hijack the update.

## Layout

| File | Role |
|---|---|
| `MirrorClient.swift` | decodes `/_mirror/status` + `/_mirror/workspaces` |
| `MirrorStore.swift` | the 5s poll, the launchd state, and the one-word health verdict |
| `LaunchAgent.swift` | reads the installed plist; install / restart / uninstall / sign in |
| `MirrorConfig.swift` | reads and rewrites the config file, preserving unknown keys |
| `UpdateChecker.swift` | finds, verifies and unpacks a newer release |
| `UpdateController.swift` | when to check, and the hand-off to `install.sh` |
| `AppVersion.swift` | dotted-version parsing and ordering |
| `Tests/` | round-trip + plist-inference tests (`swift test`) |
| `MenuContent.swift` | the panel |
| `ConfigWindow.swift` | the emitter editor and the Service tab |

Two details worth keeping:

- **Config edits go to the file the RUNNING mirror reported reading** (`status.configPath`), not
  to a guess at the default path, so a mirror started with `--config` elsewhere is still
  configured by this window. Saving restarts the agent, because the mirror reads its config once
  at startup.
- **Installing always shells out to `wiki-mirror/scripts/install-agent.sh`.** An app that wrote
  its own plist would drift from the script the moment either changed; the app derives the
  runtime (source / dist / portable) by reading the installed plist back.
- **`login` is inserted right after the script, not appended.** The mirror only takes the login
  path when `login` is `argv[0]`, so appending it past `--models-dir …` starts a second mirror
  instead of signing in — and reports success.
