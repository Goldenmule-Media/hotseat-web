import AppKit
import SwiftUI

/// The panel behind the menu-bar icon: what the mirror is doing, per workspace, and the four
/// things you actually do to it (restart, sign in, read the log, configure).
struct MenuContent: View {
    @Bindable var store: MirrorStore
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().padding(.vertical, 8)
            workspaces
            Divider().padding(.vertical, 8)
            actions
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
            Text(store.probeError ?? "No mirror is answering on 127.0.0.1:4440.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var actions: some View {
        VStack(spacing: 6) {
            HStack(spacing: 8) {
                Button("Restart") { Task { await store.restart() } }
                    .disabled(store.busy != nil || !store.agent.installed)
                Button("Sign in…") { Task { await store.signIn() } }
                    .disabled(store.busy != nil || !store.agent.installed)
                Button("Logs") { NSWorkspace.shared.open(URL(fileURLWithPath: LaunchAgent.logPath)) }
                    .disabled(!FileManager.default.fileExists(atPath: LaunchAgent.logPath))
                Spacer()
            }
            HStack(spacing: 8) {
                Button("Configure…") { openConfiguration() }
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }
            }
        }
    }

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
