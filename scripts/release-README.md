# wiki-mirror @VERSION@ (macOS)

Keeps a local Markdown copy of your wiki up to date, and puts its status in your menu bar.

Two pieces, both in this folder:

- **`mirror/`** — the mirror itself: it tails your wiki server and writes deterministic Markdown
  into folders you choose. Runs as a background launchd agent, so it keeps working whether or not
  anything is watching it.
- **`WikiMirror.app`** — the menu-bar console: is it connected, is it signed in, is each workspace
  keeping pace, and which folders get mirrored where.

## Install

```sh
./install.sh
```

Needs **macOS 14+** and **Node 20+** (`node --version`; `brew install node` if you have neither).
It does not need this project's source, npm, or Xcode.

Then, in the app: **Configure…** to point it at your server, **Sign in…** to give the mirror its
own credentials, and **Add** to pick a workspace and the folder to mirror it into.

## Where things go

| | |
|---|---|
| App | `/Applications/WikiMirror.app` |
| Mirror program | `~/Library/Application Support/wiki-mirror/` |
| Service | `~/Library/LaunchAgents/com.thegoldenmule.wiki-mirror.plist` |
| Config | `~/.wiki/wiki-mirror.config.json` (one per machine, shared by every project) |
| Credentials | `~/.wiki/credentials.json` |
| Logs | `~/Library/Logs/wiki-mirror/` |

Nothing is written to a mirrored folder except the Markdown tree and its manifest.

## Uninstall

```sh
./install.sh --uninstall
```

Your config and every mirrored folder are left alone.

## A note on the signature

The app is **ad-hoc signed, not notarized**, so macOS quarantines it on download and would refuse
to open it. `install.sh` clears that flag on the files it installs — which is the same trust you
extend by running the script at all. If you would rather do it by hand:

```sh
/usr/bin/xattr -dr com.apple.quarantine WikiMirror.app
```

## Troubleshooting

The mirror answers on `http://127.0.0.1:4440`, and its status says what is wrong rather than
making you guess:

```sh
curl -s localhost:4440/_mirror/status | python3 -m json.tool
```

- `auth.expired: true` — the stored grant ran out. **Sign in…** in the app, or
  `~/Library/Application\ Support/wiki-mirror/wiki-mirror.mjs login`.
- `server.reachable: false` — the mirror is fine; it can't reach your wiki server.
- a workspace with `lastReconcileError` — the reason is in the message, and it keeps retrying.

Logs: `~/Library/Logs/wiki-mirror/mirror.log`, or **Open logs** in the menu.

Built from @COMMIT@.
