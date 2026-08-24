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
(cd "$REPO_ROOT/wiki-mirror-menubar" && ./scripts/bundle-app.sh --universal >/dev/null)
cp -R "$REPO_ROOT/wiki-mirror-menubar/build/WikiMirror.app" "$OUT/WikiMirror.app"

# 3. The installer + what it is.
cp "$REPO_ROOT/scripts/release-install.sh" "$OUT/install.sh"
chmod +x "$OUT/install.sh"
sed -e "s/@VERSION@/$VERSION/g" -e "s/@COMMIT@/$COMMIT/g" \
  "$REPO_ROOT/scripts/release-README.md" > "$OUT/README.md"

ARCHIVE="$REPO_ROOT/build/$NAME.tar.gz"
tar -czf "$ARCHIVE" -C "$REPO_ROOT/build" "$NAME"

echo
echo "  $ARCHIVE"
echo "  $(du -h "$ARCHIVE" | cut -f1)  ·  app: $(file -b "$OUT/WikiMirror.app/Contents/MacOS/WikiMirror" | grep -o 'universal.*' || echo 'single-arch')"
echo
echo "  install on this Mac:  tar -xzf $ARCHIVE -C /tmp && /tmp/$NAME/install.sh"

if [ "$PUBLISH" = "1" ]; then
  command -v gh >/dev/null || { echo "gh is not installed" >&2; exit 1; }
  echo
  echo "==> publishing $TAG"
  # `create` fails if the tag already exists; fall back to replacing the asset on it.
  if gh release view "$TAG" >/dev/null 2>&1; then
    gh release upload "$TAG" "$ARCHIVE" --clobber
  else
    gh release create "$TAG" "$ARCHIVE" \
      --title "wiki-mirror $VERSION" \
      --notes "Local Markdown mirror + macOS menu-bar console. Built from $COMMIT.

Requires macOS 14+ and Node 20+.

    tar -xzf $NAME.tar.gz && ./$NAME/install.sh

The app is ad-hoc signed, so macOS quarantines it on download; the installer clears that for the files it installs."
  fi
  gh release view "$TAG" --json url -q .url
fi
