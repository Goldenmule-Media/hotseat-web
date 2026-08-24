# wiki-mirror-menubar

A macOS menu-bar console for the local [`wiki-mirror`](../wiki-mirror) service: is the mirror
running, is it signed in, is each workspace keeping pace — and which folders get mirrored where.

**launchd owns the mirror; this app only watches and configures it.** The Markdown has to keep
tracking the wiki whether or not anyone is looking at a status icon, so quitting the app does not
stop mirroring, and the app crashing cannot take the service down. It reads the mirror's health
endpoint (`http://127.0.0.1:4440`), edits `~/.wiki/wiki-mirror.config.json`, and drives
`launchctl`. It is not a workspace member — it has its own SwiftPM build, like `wiki-ui` has its
own Next build.

## Build and install

```sh
cd wiki-mirror-menubar
./scripts/bundle-app.sh --install     # builds, copies to /Applications, launches it
```

`swift build` alone produces a bare executable; the bundler wraps it in `WikiMirror.app`, which
is what `LSUIElement` (no Dock icon) and `MenuBarExtra` need, and ad-hoc signs it. Requires
macOS 14+ and Xcode's Swift toolchain.

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

## Layout

| File | Role |
|---|---|
| `MirrorClient.swift` | decodes `/_mirror/status` + `/_mirror/workspaces` |
| `MirrorStore.swift` | the 5s poll, the launchd state, and the one-word health verdict |
| `LaunchAgent.swift` | reads the installed plist; install / restart / uninstall / sign in |
| `MirrorConfig.swift` | reads and rewrites the config file, preserving unknown keys |
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
