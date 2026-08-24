#!/bin/bash
#
# Build ONE downloadable artifact that installs the whole thing on any Mac: the menu-bar app,
# the portable mirror it watches, and an installer that wires them together.
#
#   ./scripts/make-release.sh            # → build/wiki-mirror-<version>-macos.tar.gz
#   ./scripts/make-release.sh --publish  # …and attach it to a GitHub release
#
# The target Mac needs macOS 14+ and Node 20+. It does NOT need this repo, npm, or Xcode.
#
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
REPO_ROOT="$PWD"
VERSION="$(node -p "require('./wiki-mirror/package.json').version")"
COMMIT="$(git rev-parse --short HEAD)"
# Must stay in step with AppVersion.tagPrefix: the in-app updater filters releases by it, so a
# release tagged anything else is invisible to every installed copy.
TAG="wiki-mirror-v$VERSION"
NAME="wiki-mirror-$VERSION-macos"
OUT="$REPO_ROOT/build/$NAME"
PUBLISH=0
[ "${1:-}" = "--publish" ] && PUBLISH=1

echo "==> building the release payload ($VERSION, $COMMIT)"
rm -rf "$REPO_ROOT/build"
mkdir -p "$OUT"

# 1. The mirror: one self-contained .mjs + its model bundles + the launchd installer.
npm run bundle -w wiki-mirror >/dev/null
cp -R "$REPO_ROOT/wiki-mirror/build/wiki-mirror-portable" "$OUT/mirror"

# 2. The app, universal so it runs on Intel too.
(cd "$REPO_ROOT/wiki-mirror-menubar" && ./scripts/bundle-app.sh --universal --version "$VERSION" >/dev/null)
cp -R "$REPO_ROOT/wiki-mirror-menubar/build/WikiMirror.app" "$OUT/WikiMirror.app"

# 3. The installer + what it is.
cp "$REPO_ROOT/scripts/release-install.sh" "$OUT/install.sh"
chmod +x "$OUT/install.sh"
sed -e "s/@VERSION@/$VERSION/g" -e "s/@COMMIT@/$COMMIT/g" \
  "$REPO_ROOT/scripts/release-README.md" > "$OUT/README.md"

# A release nobody can install is worse than no release. Check the payload holds what the
# installer needs before anything is published.
for required in "install.sh" "README.md" "WikiMirror.app/Contents/MacOS/WikiMirror" \
                "mirror/wiki-mirror.mjs" "mirror/install-agent.sh"; do
  [ -e "$OUT/$required" ] || { echo "release payload is missing $required" >&2; exit 1; }
done
[ -n "$(ls "$OUT/mirror/models"/*.js 2>/dev/null)" ] || { echo "release payload has no model bundles" >&2; exit 1; }
codesign --verify --deep --strict "$OUT/WikiMirror.app" 2>/dev/null || {
  echo "the app bundle is not validly signed — macOS would refuse to open it" >&2
  exit 1
}
STAMPED="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$OUT/WikiMirror.app/Contents/Info.plist")"
[ "$STAMPED" = "$VERSION" ] || {
  echo "the app is stamped $STAMPED but this release is $VERSION — the updater compares these" >&2
  exit 1
}

ARCHIVE="$REPO_ROOT/build/$NAME.tar.gz"
tar -czf "$ARCHIVE" -C "$REPO_ROOT/build" "$NAME"
# Published beside the tarball so the in-app updater can tell a complete download from a truncated
# one. It is an integrity check, NOT a signature: whoever can publish a release can publish a
# matching checksum. The trust anchor is HTTPS to GitHub.
(cd "$REPO_ROOT/build" && shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256")

echo
echo "  $ARCHIVE"
echo "  $ARCHIVE.sha256"
echo "  $(du -h "$ARCHIVE" | cut -f1)  ·  app: $(file -b "$OUT/WikiMirror.app/Contents/MacOS/WikiMirror" | grep -o 'universal.*' || echo 'single-arch')"
echo
echo "  install on this Mac:  tar -xzf $ARCHIVE -C /tmp && /tmp/$NAME/install.sh"

if [ "$PUBLISH" = "1" ]; then
  command -v gh >/dev/null || { echo "gh is not installed" >&2; exit 1; }
  echo
  echo "==> publishing $TAG"
  # `create` fails if the tag already exists; fall back to replacing the asset on it.
  if gh release view "$TAG" >/dev/null 2>&1; then
    gh release upload "$TAG" "$ARCHIVE" "$ARCHIVE.sha256" --clobber
  else
    gh release create "$TAG" "$ARCHIVE" "$ARCHIVE.sha256" \
      --target "$(git rev-parse HEAD)" \
      --title "wiki-mirror $VERSION" \
      --generate-notes \
      --notes "Local Markdown mirror + macOS menu-bar console. Built from \`$COMMIT\`.

Requires **macOS 14+** and **Node 20+**.

\`\`\`sh
tar -xzf $NAME.tar.gz && ./$NAME/install.sh
\`\`\`

Already have it installed? The app updates itself — **Check for Updates…** in the menu.

The app is ad-hoc signed rather than notarized, so macOS quarantines it on download; the installer clears that for the files it installs.

---
"
  fi
  gh release view "$TAG" --json url -q .url
fi
