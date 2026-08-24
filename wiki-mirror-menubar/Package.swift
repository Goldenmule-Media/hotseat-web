// swift-tools-version: 5.9
import PackageDescription

/**
 A menu-bar console for the local `wiki-mirror` service.

 launchd owns the mirror process; this app watches it and configures it. That split is
 deliberate: the docs must keep mirroring whether or not anything is watching, and a status
 icon that can take the service down with it is a liability, not a feature.

 SwiftPM builds the executable; `scripts/bundle-app.sh` wraps it in the .app bundle that
 `LSUIElement` and `MenuBarExtra` need.
 */
let package = Package(
    name: "WikiMirrorMenuBar",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "WikiMirrorMenuBar",
            path: "Sources/WikiMirrorMenuBar"
        )
    ]
)
