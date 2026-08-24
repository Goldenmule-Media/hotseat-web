import AppKit
import SwiftUI

/// The panel behind the menu-bar icon: what the mirror is doing, workspace by workspace, and the
/// handful of things you actually do to it.
struct MenuContent: View {
    @Bindable var store: MirrorStore
    @Bindable var updates: UpdateController
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().padding(.vertical, 8)
            workspaces
            Divider().padding(.vertical, 8)
            updateBanner
            actions
                // Menu rows highlight nearly edge-to-edge; pull them back out of the panel's
                // content inset so the hover fill doesn't sit in a gutter.
                .padding(.horizontal, -4)
        }
        .padding(12)
        .frame(width: 380)
        .task { await store.refreshAll() }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: store.health.symbol)
                .font(.system(size: 18))
                .foregroundStyle(store.health.tint)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(store.health.summary).font(.headline)
                Text(store.detail).font(.caption).foregroundStyle(.secondary)
                if let message = store.lastActionMessage {
                    Text(message).font(.caption2).foregroundStyle(.tertiary).padding(.top, 2)
                }
            }
            Spacer()
            if store.busy != nil {
                ProgressView().controlSize(.small)
            }
        }
    }

    @ViewBuilder
    private var workspaces: some View {
        if let status = store.status, !status.workspaces.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(status.workspaces) { workspace in
                    WorkspaceRow(workspace: workspace)
                }
            }
        } else if store.status != nil {
            Text("This mirror isn't configured to mirror anything yet.")
                .font(.caption)
                .foregroundStyle(.secondary)
        } else {
            Text(store.probeError ?? "No mirror is answering on \(store.healthURL).")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    /// An update, when there is one, sits ABOVE the actions: it is the one thing here that is
    /// news rather than a control.
    @ViewBuilder
    private var updateBanner: some View {
        if let update = updates.pending {
            MenuRow("Update to " + update.version.description, systemImage: "arrow.down.circle", enabled: !installing) {
                Task { await updates.install(update) }
            }
            .padding(.horizontal, -4)
            Divider().padding(.vertical, 6)
        } else if installing {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Installing the update…").font(.caption).foregroundStyle(.secondary)
            }
            .padding(.bottom, 6)
        }
    }

    private var installing: Bool { updates.state == .installing }

    /// Actions as full-width menu rows rather than a grid of bordered buttons.
    ///
    /// This is a menu, not a dialog: bordered buttons wrapped into ragged rows, sized to their
    /// own labels, with Quit stranded on the right. Rows read top-to-bottom, hit anywhere along
    /// their width, and leave room for a keyboard hint.
    private var actions: some View {
        VStack(spacing: 1) {
            MenuRow("Restart", systemImage: "arrow.clockwise", enabled: canControlAgent) {
                Task { await store.restart() }
            }
            MenuRow("Sign in…", systemImage: "person.crop.circle", enabled: canControlAgent) {
                Task { await store.signIn() }
            }
            MenuRow(
                "Open logs",
                systemImage: "doc.text",
                enabled: FileManager.default.fileExists(atPath: LaunchAgent.logPath)
            ) {
                NSWorkspace.shared.open(URL(fileURLWithPath: LaunchAgent.logPath))
            }
            MenuRow(
                "Check for Updates…",
                systemImage: "sparkles",
                enabled: updates.state != .checking && !installing
            ) {
                Task { await updates.check(userInitiated: true) }
            }
            MenuRow("Configure…", systemImage: "gearshape", shortcut: ",") { openConfiguration() }

            Divider().padding(.vertical, 4)

            MenuRow("Quit Wiki Mirror", systemImage: "power", shortcut: "q") { NSApp.terminate(nil) }
        }
    }

    /// Restart and Sign in drive the launchd job, so they need one installed — and they must not
    /// stack up while another action is still running.
    private var canControlAgent: Bool { store.busy == nil && store.agent.installed }

    private func openConfiguration() {
        // Dismiss FIRST: the panel would otherwise sit on top of the window we are opening, and
        // closing it afterwards would close that window instead.
        dismissMenu()
        openWindow(id: WikiMirrorApp.configWindowID)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Close the menu-bar panel. `MenuBarExtra(style: .window)` exposes no dismiss API, so this
    /// closes its window directly — identified by class, with a fallback to the key window only
    /// when that is a titleless panel, so it can never close the configuration window by mistake.
    private func dismissMenu() {
        if let panel = NSApp.windows.first(where: { $0.isVisible && $0.className.contains("MenuBarExtra") }) {
            panel.close()
            return
        }
        if let key = NSApp.keyWindow, key.title.isEmpty {
            key.close()
        }
    }
}

/// One mirrored workspace: where it writes, how far it has got, and what is wrong with it.
private struct WorkspaceRow: View {
    let workspace: MirrorStatus.WorkspaceStatus

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Circle().fill(tint).frame(width: 8, height: 8).padding(.top, 4)
            VStack(alignment: .leading, spacing: 1) {
                HStack {
                    Text(workspace.displayName).font(.system(size: 12, weight: .medium))
                    Spacer()
                    Text(subtitle).font(.system(size: 11)).foregroundStyle(.secondary)
                }
                Text(abbreviatedRoot).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
                if let failure = workspace.lastReconcileError {
                    Text(failure).font(.system(size: 11)).foregroundStyle(.red).lineLimit(2)
                }
            }
        }
    }

    private var tint: Color {
        if workspace.lastReconcileError != nil { return .red }
        if !workspace.connected || workspace.stuck == true { return .orange }
        return .green
    }

    private var subtitle: String {
        if workspace.lastReconcileError != nil, let retry = workspace.nextRetryAt {
            return "retrying \(Self.relative(Date(timeIntervalSince1970: retry / 1000)))"
        }
        let version = "v\(workspace.appliedVersion)"
        guard let at = workspace.lastReconcileAt else { return version }
        return "\(version) · \(Self.relative(Date(timeIntervalSince1970: at / 1000)))"
    }

    private var abbreviatedRoot: String {
        workspace.root.hasPrefix(NSHomeDirectory())
            ? "~" + workspace.root.dropFirst(NSHomeDirectory().count)
            : workspace.root
    }

    private static let formatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter
    }()

    private static func relative(_ date: Date) -> String {
        formatter.localizedString(for: date, relativeTo: Date())
    }
}

extension MirrorHealth {
    /// The popover CAN use color even though the menu-bar glyph can't.
    var tint: Color {
        switch self {
        case .healthy: return .green
        case .idle, .starting: return .secondary
        case .degraded, .hostUnreachable: return .orange
        case .signedOut: return .red
        case .stopped, .notInstalled: return .secondary
        }
    }
}

/// One row of the menu: an icon, a label, an optional keyboard hint, and the full width as its
/// hit target. Highlights on hover the way a real menu item does.
private struct MenuRow: View {
    private let title: String
    private let systemImage: String
    /// A ⌘-shortcut, both bound and shown. An LSUIElement app has no menu bar to route the
    /// standard ones, so even ⌘Q has to be declared here.
    private let shortcut: KeyEquivalent?
    private let enabled: Bool
    private let action: () -> Void

    @State private var hovering = false

    init(
        _ title: String,
        systemImage: String,
        shortcut: KeyEquivalent? = nil,
        enabled: Bool = true,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.systemImage = systemImage
        self.shortcut = shortcut
        self.enabled = enabled
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: systemImage)
                    .frame(width: 16)
                    .foregroundStyle(.secondary)
                Text(title)
                Spacer()
                if let shortcut {
                    Text("⌘\(String(shortcut.character).uppercased())")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            // Without this the row is only clickable where it has ink.
            .contentShape(Rectangle())
            .background(
                RoundedRectangle(cornerRadius: 5)
                    .fill(hovering && enabled ? Color.accentColor.opacity(0.18) : .clear)
            )
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.4)
        .onHover { hovering = $0 }
        .modifier(OptionalShortcut(key: shortcut))
    }
}

/// Binds a ⌘-shortcut when there is one. `keyboardShortcut` takes no optional, and a
/// `if let` around the modifier would change the view's type between branches.
private struct OptionalShortcut: ViewModifier {
    let key: KeyEquivalent?

    func body(content: Content) -> some View {
        if let key {
            content.keyboardShortcut(key, modifiers: .command)
        } else {
            content
        }
    }
}
