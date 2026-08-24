#!/bin/bash
#
# Install `wiki-mirror` as a launchd user agent: started at login, restarted if it dies, logging
# to ~/Library/Logs/wiki-mirror/. launchd owns the process; the menu-bar app is a console for it,
# so the docs keep mirroring whether or not anything is watching.
#
#   ./install-agent.sh                 # install (auto-detects source vs portable) and start
#   ./install-agent.sh --mode source   # run the repo checkout via tsx — always current
#   ./install-agent.sh --mode dist     # run the repo's built dist/bin.js
#   ./install-agent.sh --mode portable # run the self-contained artifact next to this script
#   ./install-agent.sh --status | --restart | --logs | --uninstall | --print
#
set -euo pipefail

LABEL="com.thegoldenmule.wiki-mirror"
MODE=""
NODE_BIN=""
CONFIG=""
ACTION="install"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

die() { printf 'wiki-mirror: %s\n' "$1" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    --mode=*) MODE="${1#*=}"; shift ;;
    --node) NODE_BIN="${2:-}"; shift 2 ;;
    --node=*) NODE_BIN="${1#*=}"; shift ;;
    --label) LABEL="${2:-}"; shift 2 ;;
    --label=*) LABEL="${1#*=}"; shift ;;
    --config) CONFIG="${2:-}"; shift 2 ;;
    --config=*) CONFIG="${1#*=}"; shift ;;
    --uninstall|--status|--restart|--logs|--print) ACTION="${1#--}"; shift ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument \"$1\" (try --help)" ;;
  esac
done

PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/wiki-mirror"
DOMAIN="gui/$(id -u)"

case "$ACTION" in
  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      launchctl print "$DOMAIN/$LABEL" | grep -E '^\s+(state|pid|last exit code|program) ' || true
    else
      echo "not loaded ($LABEL)"
    fi
    # The health endpoint is the honest answer: loaded but wedged still looks "running" to launchd.
    if command -v curl >/dev/null 2>&1; then
      echo "--- http://127.0.0.1:4440/_mirror/status"
      curl -fsS --max-time 3 http://127.0.0.1:4440/_mirror/status || echo "(no health endpoint answering)"
      echo
    fi
    exit 0 ;;
  restart)
    launchctl kickstart -k "$DOMAIN/$LABEL"
    echo "wiki-mirror: restarted $LABEL"
    exit 0 ;;
  logs)
    exec tail -n 100 -f "$LOG_DIR/mirror.log" "$LOG_DIR/mirror.err.log" ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "wiki-mirror: removed $LABEL (logs kept in $LOG_DIR)"
    exit 0 ;;
esac

# ── resolve the runtime ──────────────────────────────────────────────────────
if [ -z "$MODE" ]; then
  if [ -f "$SCRIPT_DIR/wiki-mirror.mjs" ]; then MODE="portable"; else MODE="source"; fi
fi

if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
  [ -n "$NODE_BIN" ] || die "no node on PATH — install Node 20+, or pass --node /path/to/node"
fi
# launchd jobs get a bare PATH, so the plist must name node absolutely.
case "$NODE_BIN" in /*) ;; *) NODE_BIN="$(cd -- "$(dirname -- "$NODE_BIN")" && pwd)/$(basename -- "$NODE_BIN")" ;; esac
[ -x "$NODE_BIN" ] || die "\"$NODE_BIN\" is not executable"

NODE_MAJOR="$("$NODE_BIN" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
[ "$NODE_MAJOR" -ge 20 ] || die "node 20+ required (found $("$NODE_BIN" -v) at $NODE_BIN)"

ARGS=()
case "$MODE" in
  portable)
    BINARY="$SCRIPT_DIR/wiki-mirror.mjs"
    [ -f "$BINARY" ] || die "--mode portable expects wiki-mirror.mjs next to this script ($SCRIPT_DIR)"
    WORKDIR="$SCRIPT_DIR"
    # This artifact has no node_modules: clear any bare specifiers from the config file and take
    # the schema from the bundles shipped beside the binary.
    ARGS=("$BINARY" "--models=" "--models-dir" "$SCRIPT_DIR/models")
    ;;
  source)
    PKG_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
    [ -f "$PKG_DIR/src/bin.ts" ] || die "--mode source expects the wiki-mirror package at $PKG_DIR"
    WORKDIR="$PKG_DIR"
    # tsx runs the checkout as-is, so the service always reflects the working tree; restart to
    # pick up an edit.
    ARGS=("--import" "tsx" "$PKG_DIR/src/bin.ts")
    ;;
  dist)
    PKG_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
    [ -f "$PKG_DIR/dist/bin.js" ] || die "--mode dist needs a build first: npm run build -w wiki-mirror"
    WORKDIR="$PKG_DIR"
    ARGS=("$PKG_DIR/dist/bin.js")
    ;;
  *) die "unknown --mode \"$MODE\" (source | dist | portable)" ;;
esac

[ -z "$CONFIG" ] || ARGS+=("--config" "$CONFIG")

# ── the plist ────────────────────────────────────────────────────────────────
program_args=""
for arg in "$NODE_BIN" "${ARGS[@]}"; do
  escaped="${arg//&/&amp;}"; escaped="${escaped//</&lt;}"; escaped="${escaped//>/&gt;}"
  program_args="$program_args
    <string>$escaped</string>"
done

PLIST_XML="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>$program_args
  </array>
  <key>WorkingDirectory</key><string>$WORKDIR</string>
  <key>RunAtLoad</key><true/>
  <!-- Restart on a CRASH, but respect a clean exit: the mirror exits 0 when another instance
       already owns its port, and respawning into that collision every few seconds helps nobody. -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/mirror.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/mirror.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname -- "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>"

if [ "$ACTION" = "print" ]; then
  printf '%s\n' "$PLIST_XML"
  exit 0
fi

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
printf '%s\n' "$PLIST_XML" > "$PLIST"
plutil -lint "$PLIST" >/dev/null || die "generated an invalid plist at $PLIST"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true

cat <<EOF
wiki-mirror: installed $LABEL (mode: $MODE)
  plist    $PLIST
  runs     $NODE_BIN ${ARGS[*]}
  logs     $LOG_DIR/mirror.log
  status   $0 --status
  restart  $0 --restart   # config is read at startup — restart after editing it
EOF
