#!/bin/bash
#
# Install the local Markdown mirror and its menu-bar console on this Mac.
#
#   ./install.sh              # install both, start the mirror, open the app
#   ./install.sh --app-only   # just the menu bar app (a mirror is already running)
#   ./install.sh --uninstall  # remove both (your config and mirrored files are kept)
#
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_SRC="$HERE/WikiMirror.app"
APP_DEST="/Applications/WikiMirror.app"
MIRROR_HOME="$HOME/Library/Application Support/wiki-mirror"
MODE="all"

case "${1:-}" in
  --app-only) MODE="app" ;;
  --uninstall) MODE="uninstall" ;;
  --help|-h) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) echo "unknown argument \"$1\" (try --help)" >&2; exit 1 ;;
esac

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'install: %s\n' "$1" >&2; exit 1; }

quit_app() {
  osascript -e 'tell application "WikiMirror" to quit' >/dev/null 2>&1 || true
  pkill -x WikiMirror 2>/dev/null || true
  sleep 1
}

if [ "$MODE" = "uninstall" ]; then
  say "Removing the mirror service and the app"
  [ -x "$MIRROR_HOME/install-agent.sh" ] && "$MIRROR_HOME/install-agent.sh" --uninstall || true
  quit_app
  rm -rf "$APP_DEST"
  echo "Removed. Your config (~/.wiki) and every mirrored folder were left alone."
  echo "Delete $MIRROR_HOME to remove the mirror program itself."
  exit 0
fi

# ── requirements ─────────────────────────────────────────────────────────────
MACOS="$(sw_vers -productVersion)"
[ "${MACOS%%.*}" -ge 14 ] || die "needs macOS 14 or newer (this is $MACOS)"

if [ "$MODE" = "all" ]; then
  NODE="$(command -v node || true)"
  [ -n "$NODE" ] || die "needs Node 20+ on PATH. Install it (brew install node) and run this again."
  NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
  [ "$NODE_MAJOR" -ge 20 ] || die "needs Node 20+ (found $("$NODE" -v) at $NODE)"
fi

# macOS quarantines anything downloaded from the internet, and this app is ad-hoc signed rather
# than notarized — so without this it refuses to launch at all. You are already trusting this
# script; it clears the flag only on the files it installs.
/usr/bin/xattr -dr com.apple.quarantine "$HERE" 2>/dev/null || true

# ── the app ──────────────────────────────────────────────────────────────────
say "Installing WikiMirror.app"
[ -d "$APP_SRC" ] || die "WikiMirror.app is missing from $HERE"
quit_app   # replacing a bundle under a live process leaves it half-updated
rm -rf "$APP_DEST"
cp -R "$APP_SRC" "$APP_DEST"
/usr/bin/xattr -dr com.apple.quarantine "$APP_DEST" 2>/dev/null || true

# ── the mirror ───────────────────────────────────────────────────────────────
if [ "$MODE" = "all" ]; then
  say "Installing the mirror service"
  # It lives outside the download so deleting the unpacked folder can't break the running agent.
  rm -rf "$MIRROR_HOME"
  mkdir -p "$(dirname "$MIRROR_HOME")"
  cp -R "$HERE/mirror" "$MIRROR_HOME"
  "$MIRROR_HOME/install-agent.sh" --mode portable --node "$NODE"
fi

open "$APP_DEST"

cat <<EOF

$(say "Done.")
Look for the mirror icon in your menu bar.

Next, in the app:
  1. Configure… → Server: point Stream at your wiki server, Client at its web UI.
  2. Sign in… — the mirror needs its own credentials for that server.
  3. Configure… → Add, to choose a workspace and the folder to mirror it into.

The mirror runs from a launchd agent, so it keeps working when the app is closed.
Uninstall with: $HERE/install.sh --uninstall
EOF
