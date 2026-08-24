import AppKit
import ServiceManagement
import SwiftUI

/// The editor for the per-machine config, plus the launchd service controls.
///
/// It edits the file the RUNNING mirror reported reading — not a guess at the default path —
/// so a mirror started with `--config` elsewhere is still configured by the same window.
struct ConfigWindow: View {
    @Bindable var store: MirrorStore
    @State private var config = MirrorConfigFile()
    @State private var loadedFrom = ""
    @State private var loadError: String?
    @State private var saveError: String?

    var body: some View {
        TabView {
            mirrors.tabItem { Label("Mirrors", systemImage: "folder") }
            service.tabItem { Label("Service", systemImage: "gearshape") }
        }
        .frame(width: 620, height: 460)
        .task {
            await store.refreshAll()
            load()
            await store.refreshCatalog()
        }
    }

    // ── mirrors ──────────────────────────────────────────────────────────────

    private var mirrors: some View {
        VStack(alignment: .leading, spacing: 12) {
            Form {
                TextField("Server", text: $config.streamBaseUrl)
                TextField("Namespace", text: $config.namespace)
            }
            .formStyle(.grouped)
            .frame(height: 90)

            HStack {
                Text("Mirrored workspaces").font(.headline)
                Spacer()
                if store.catalogError != nil {
                    Text("Workspace list needs a running mirror")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Button("Add") { config.emitters.append(EmitterEntry()) }
            }

            ScrollView {
                VStack(spacing: 10) {
                    ForEach($config.emitters) { $emitter in
                        EmitterRow(emitter: $emitter, catalog: store.catalog) {
                            config.emitters.removeAll { $0.id == emitter.id }
                        }
                    }
                    if config.emitters.isEmpty {
                        Text("Nothing is mirrored on this Mac yet.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }

            problems

            HStack {
                Text(loadedFrom).font(.caption2).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
                Spacer()
                Button("Revert") { load() }
                Button("Save & Restart") { save() }
                    .keyboardShortcut(.defaultAction)
                    // A failed load leaves an EMPTY default in hand; saving it would erase the
                    // real file's emitters, token and every other key.
                    .disabled(loadError != nil || !config.validate().isEmpty || store.busy != nil)
            }
        }
        .padding(16)
    }

    @ViewBuilder
    private var problems: some View {
        let issues = config.validate()
        if let loadError {
            Label("Could not read \(loadedFrom): \(loadError). Fix the file by hand, then Revert.",
                  systemImage: "exclamationmark.triangle")
                .font(.caption)
                .foregroundStyle(.red)
        }
        if store.configPathIsGuess && loadError == nil {
            Label("No mirror is answering, so this is the config file the installed agent names.",
                  systemImage: "info.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        if let saveError {
            Label(saveError, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.red)
        }
        if !issues.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(issues, id: \.self) { issue in
                    Label(issue, systemImage: "exclamationmark.circle").font(.caption).foregroundStyle(.orange)
                }
            }
        }
    }

    private func load() {
        loadedFrom = store.configPath
        do {
            config = try MirrorConfigFile.load(from: loadedFrom)
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
        saveError = nil
    }

    private func save() {
        Task {
            saveError = nil
            let saved = await store.save(config: config)
            if !saved { saveError = store.lastActionMessage }
        }
    }

    // ── service ──────────────────────────────────────────────────────────────

    private var service: some View {
        ServiceTab(store: store)
    }
}

/// One emitter: which workspace, and the folder it is written to.
private struct EmitterRow: View {
    @Binding var emitter: EmitterEntry
    let catalog: [CatalogWorkspace]
    let onDelete: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                TextField("ws:…", text: $emitter.workspaceId)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.body, design: .monospaced))
                if !catalog.isEmpty {
                    Menu("Pick") {
                        ForEach(catalog) { workspace in
                            Button(workspace.name) { emitter.workspaceId = workspace.id }
                        }
                    }
                    .frame(width: 70)
                }
                Button(role: .destructive, action: onDelete) { Image(systemName: "trash") }
                    .buttonStyle(.borderless)
            }
            HStack(spacing: 8) {
                TextField("/absolute/path/to/checkout/docs", text: $emitter.root)
                    .textFieldStyle(.roundedBorder)
                Button("Choose…") { chooseFolder() }
            }
            if let name = catalog.first(where: { $0.id == emitter.workspaceId })?.name {
                Text(name).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.04)))
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Mirror here"
        if !emitter.root.isEmpty {
            panel.directoryURL = URL(fileURLWithPath: emitter.root)
        }
        if panel.runModal() == .OK, let url = panel.url {
            emitter.root = url.path
        }
    }
}

/// Install, inspect, and remove the launchd agent that keeps the mirror running.
private struct ServiceTab: View {
    @Bindable var store: MirrorStore
    @State private var mode = "source"
    @State private var installerDirectory = ""
    @State private var launchAtLogin = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            section("Status") {
                VStack(alignment: .leading, spacing: 4) {
                    row("Agent", agentSummary)
                    row("Answering", store.status != nil ? "yes, pid \(store.status?.pid.map(String.init) ?? "?")" : "no")
                    row("Endpoint", store.healthURL)
                    if let info = LaunchAgent.info() {
                        row("Mode", info.mode)
                        row("Runs", info.programArguments.joined(separator: " "))
                    }
                    row("Config", store.configPath, reveal: store.configPath)
                    row("Log", LaunchAgent.logPath, reveal: LaunchAgent.logPath)
                }
                .font(.caption)
            }

            section("Install") {
                VStack(alignment: .leading, spacing: 8) {
                    Picker("Run from", selection: $mode) {
                        Text("Repo source (tsx — always current)").tag("source")
                        Text("Repo build (dist/bin.js)").tag("dist")
                        Text("Portable artifact").tag("portable")
                    }
                    HStack(spacing: 8) {
                        TextField("folder containing install-agent.sh", text: $installerDirectory)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(.caption, design: .monospaced))
                        Button("Choose…") { chooseInstaller() }
                    }
                    Text("For repo modes pick wiki-mirror/scripts; for a portable artifact pick the unpacked folder.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    HStack {
                        Button(store.agent.installed ? "Reinstall" : "Install") {
                            Task { await store.install(installerDirectory: installerDirectory, mode: mode) }
                        }
                        .disabled(installerDirectory.isEmpty || store.busy != nil)
                        Button("Uninstall") { Task { await store.uninstall() } }
                            .disabled(!store.agent.installed || store.busy != nil)
                        Spacer()
                        if let message = store.lastActionMessage {
                            Text(message).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                }
            }

            Toggle("Show this app in the menu bar at login", isOn: $launchAtLogin)
                .onChange(of: launchAtLogin) { _, enabled in setLaunchAtLogin(enabled) }
            Text("The mirror itself runs from the launchd agent above — it keeps mirroring whether or not this app is open.")
                .font(.caption2)
                .foregroundStyle(.secondary)

            Spacer()
        }
        .padding(16)
        .onAppear {
            if let info = LaunchAgent.info() {
                mode = info.mode == "custom" ? "source" : info.mode
                installerDirectory = info.installerDirectory ?? ""
            }
            launchAtLogin = SMAppService.mainApp.status == .enabled
        }
    }

    /// A titled panel whose heading lines up with its own content. GroupBox insets its label
    /// past the box it labels, which reads as a mistake next to the controls below it.
    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.headline)
            content()
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.04)))
        }
    }

    private var agentSummary: String {
        guard store.agent.installed else { return "not installed" }
        guard store.agent.loaded else { return "installed, not loaded" }
        let exit = store.agent.lastExitCode.map { " (last exit \($0))" } ?? ""
        return store.agent.running ? "running" : "loaded, not running\(exit)"
    }

    private func row(_ label: String, _ value: String, reveal: String? = nil) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Text(label).frame(width: 74, alignment: .leading).foregroundStyle(.secondary)
            Text(value).textSelection(.enabled)
            Spacer()
            if let reveal {
                Button {
                    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: reveal)])
                } label: {
                    Image(systemName: "folder")
                }
                .buttonStyle(.borderless)
                .help("Show in Finder")
                // A path that does not exist yet (no log until the agent has run) would open the
                // user's home folder instead, which looks like a bug.
                .disabled(!FileManager.default.fileExists(atPath: reveal))
            }
        }
    }

    private func chooseInstaller() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.prompt = "Use this folder"
        if panel.runModal() == .OK, let url = panel.url {
            installerDirectory = url.path
        }
    }

    private func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            store.lastActionMessage = error.localizedDescription
            launchAtLogin = SMAppService.mainApp.status == .enabled
        }
    }
}
