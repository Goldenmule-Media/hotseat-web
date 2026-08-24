#!/bin/bash
#
# Install the local Markdown mirror and its menu-bar console on this Mac.
#
#   ./install.sh              # install both, start the mirror, open the app
#   ./install.sh --app-only   # just the menu bar app (a mirror is already running)
#   ./install.sh --keep       # install, but leave the download in place
#   ./install.sh --uninstall  # remove both (your config and mirrored files are kept)
#
# Everything is COPIED to its final home, so the unpacked folder and its tarball are rubbish the
# moment the install succeeds — they are removed unless you pass --keep.
#
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_SRC="$HERE/WikiMirror.app"
APP_DEST="/Applications/WikiMirror.app"
MIRROR_HOME="$HOME/Library/Application Support/wiki-mirror"
CONFIG="$HOME/.wiki/wiki-mirror.config.json"

# Where this build of the mirror points on a machine that has never run it. The library's own
# default is localhost, which is right for someone running their own server and useless for
# everyone installing THIS release — so the product's home lives here, in the installer, rather
# than baked into a general-purpose package.
DEFAULT_STREAM_URL="https://hotseat.thegoldenmule.com"
DEFAULT_NAMESPACE="default"
MODE="all"
CLEANUP=1

while [ $# -gt 0 ]; do
  case "$1" in
    --app-only) MODE="app"; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    --keep) CLEANUP=0; shift ;;
    --help|-h) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument \"$1\" (try --help)" >&2; exit 1 ;;
  esac
done

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'install: %s\n' "$1" >&2; exit 1; }

quit_app() {
  osascript -e 'tell application "WikiMirror" to quit' >/dev/null 2>&1 || true
  pkill -x WikiMirror 2>/dev/null || true
  sleep 1
}

# Point a first-time install at the right server. Only ever writes when there is NO config: this
# file is shared by every project on the machine and hand-edited, so an installer that overwrote it
# would silently drop somebody's mirrors.
seed_config() {
  if [ -f "$CONFIG" ]; then
    echo "Kept your existing config at $CONFIG"
    return
  fi
  mkdir -p "$(dirname "$CONFIG")"
  cat > "$CONFIG" <<JSON
{
  "streamBaseUrl": "$DEFAULT_STREAM_URL",
  "namespace": "$DEFAULT_NAMESPACE",
  "emitters": []
}
JSON
  echo "Wrote $CONFIG pointing at $DEFAULT_STREAM_URL"
}

# Remove the download once everything is in its final home. Guarded on the folder actually being
# our payload, so a mis-aimed run can never delete somebody's directory — and done LAST, after the
# closing message, since it deletes the script that is printing it.
cleanup_download() {
  [ "$CLEANUP" = "1" ] || { echo "Kept the download at $HERE"; return; }
  for marker in "install.sh" "WikiMirror.app" "mirror"; do
    [ -e "$HERE/$marker" ] || { echo "Left $HERE alone (it does not look like an unpacked release)"; return; }
  done
  cd /   # never sit in the directory being removed
  rm -rf "$HERE" "$HERE.tar.gz" "$HERE.tar.gz.sha256"
  echo "Cleaned up the download."
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
  # The uninstaller has to outlive the download it came in, or removing the download would strip
  # the only thing that knows how to undo this.
  cp "$HERE/install.sh" "$MIRROR_HOME/uninstall.sh"
  chmod +x "$MIRROR_HOME/uninstall.sh"
  seed_config
  "$MIRROR_HOME/install-agent.sh" --mode portable --node "$NODE"
fi

open "$APP_DEST"

if [ "$MODE" = "all" ]; then
  UNDO="\"$MIRROR_HOME/uninstall.sh\" --uninstall"
else
  UNDO="dragging WikiMirror.app to the Trash"
fi

cat <<EOF

$(say "Done.")
Look for the mirror icon in your menu bar.

Next, in the app:
  1. Sign in… — the mirror needs its own credentials for $DEFAULT_STREAM_URL.
  2. Configure… → Add, to choose a workspace and the folder to mirror it into.
     (Configure… → Server if you use a different wiki.)

The mirror runs from a launchd agent, so it keeps working when the app is closed.
It updates itself — Check for Updates… in the menu.
Uninstall with: $UNDO
EOF

cleanup_download
