#!/bin/bash
#
# Build WikiMirror.app from the SwiftPM executable.
#
# SwiftPM emits a bare binary; a menu-bar app needs a bundle — LSUIElement (no Dock icon) and
# MenuBarExtra both read Info.plist, and SMAppService needs a bundle identifier. Ad-hoc signing
# is enough for a locally built app: nothing quarantines what you compiled yourself.
#
#   ./scripts/bundle-app.sh              # build into build/WikiMirror.app
#   ./scripts/bundle-app.sh --install    # …and copy it to /Applications, then launch it
#   ./scripts/bundle-app.sh --universal  # arm64 + x86_64, for a build other Macs will run
#   ./scripts/bundle-app.sh --version X  # stamp a version (default: wiki-mirror's package.json)
#
set -euo pipefail

APP_NAME="WikiMirror"
BUNDLE_ID="com.thegoldenmule.wiki-mirror-menubar"
INSTALL=0
UNIVERSAL=0
VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --install) INSTALL=1; shift ;;
    --universal) UNIVERSAL=1; shift ;;
    --version) [ $# -ge 2 ] || { echo "--version needs a value" >&2; exit 1; }; VERSION="$2"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    *) echo "unknown argument \"$1\"" >&2; exit 1 ;;
  esac
done

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
OUT="build/$APP_NAME.app"

# ONE version for the app and the mirror: they ship in one artifact and update together, and the
# updater compares the bundle's version against the release tag. A second hardcoded copy here
# would drift and either offer an update forever or never offer one at all.
if [ -z "$VERSION" ]; then
  VERSION="$(node -p "require('../wiki-mirror/package.json').version" 2>/dev/null || echo "0.0.0")"
fi

# A machine-local build targets this Mac; a release build has to run on Intel too.
ARCH_FLAGS=()
[ "$UNIVERSAL" = "1" ] && ARCH_FLAGS=(--arch arm64 --arch x86_64)

swift build -c release ${ARCH_FLAGS[@]+"${ARCH_FLAGS[@]}"}
BINARY="$(swift build -c release ${ARCH_FLAGS[@]+"${ARCH_FLAGS[@]}"} --show-bin-path)/WikiMirrorMenuBar"
[ -x "$BINARY" ] || { echo "no binary at $BINARY" >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"
cp "$BINARY" "$OUT/Contents/MacOS/$APP_NAME"

cat > "$OUT/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Wiki Mirror</string>
  <key>CFBundleDisplayName</key><string>Wiki Mirror</string>
  <key>CFBundleExecutable</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <!-- Menu bar only: no Dock icon, no app switcher entry. -->
  <key>LSUIElement</key><true/>
  <key>NSHumanReadableCopyright</key><string>Local tool</string>
</dict>
</plist>
PLIST

plutil -lint "$OUT/Contents/Info.plist" >/dev/null
codesign --force --sign - --identifier "$BUNDLE_ID" "$OUT" >/dev/null 2>&1 || {
  echo "warning: ad-hoc codesign failed; the app will still run locally" >&2
}

echo "built $PWD/$OUT ($(file -b "$OUT/Contents/MacOS/$APP_NAME" | sed 's/Mach-O //'))"

if [ "$INSTALL" = "1" ]; then
  DEST="/Applications/$APP_NAME.app"
  # Quit a running copy first: replacing a bundle under a live process leaves it half-updated.
  osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
  pkill -x "$APP_NAME" 2>/dev/null || true
  sleep 1
  rm -rf "$DEST"
  cp -R "$OUT" "$DEST"
  open "$DEST"
  echo "installed $DEST and launched it — look for the icon in the menu bar"
fi
