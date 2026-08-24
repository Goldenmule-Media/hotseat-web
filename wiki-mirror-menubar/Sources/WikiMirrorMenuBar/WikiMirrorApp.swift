import SwiftUI

/// A menu-bar console for the local `wiki-mirror` service.
///
/// The mirror is a launchd agent, not a child of this app: the Markdown has to keep tracking the
/// wiki whether or not anyone is looking at a status icon. So this process only reads the
/// mirror's health endpoint, edits its config file, and drives launchctl.
@main
struct WikiMirrorApp: App {
    static let configWindowID = "mirror-config"

    @State private var store = MirrorStore()

    var body: some Scene {
        MenuBarExtra {
            MenuContent(store: store)
        } label: {
            // Menu-bar glyphs render monochrome, so state is carried by SHAPE, not color.
            Image(systemName: store.health.symbol)
                .accessibilityLabel(store.health.summary)
        }
        .menuBarExtraStyle(.window)

        Window("Wiki Mirror", id: Self.configWindowID) {
            ConfigWindow(store: store)
                .onAppear { store.start() }
        }
        .windowResizability(.contentMinSize)
    }

    init() {
        // The poll has to run whether or not the window was ever opened.
        let store = self.store
        Task { @MainActor in store.start() }
    }
}
