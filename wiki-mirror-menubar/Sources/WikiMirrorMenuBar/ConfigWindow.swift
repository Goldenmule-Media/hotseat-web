import AppKit
import ServiceManagement
import SwiftUI

/// The editor for the per-machine config, plus the launchd service controls.
///
/// It edits the file the RUNNING mirror reported reading — not a guess at the default path —
/// so a mirror started with `--config` elsewhere is still configured by the same window.
struct ConfigWindow: View {
    @Bindable var store: MirrorStore
    @Bindable var updates: UpdateController
    @State private var config = MirrorConfigFile()
    @State private var loadedFrom = ""
    @AppStorage(EmitterRow.clientBaseURLKey) private var clientBaseURL = EmitterRow.defaultClientBaseURL
    @State private var loadError: String?
    @State private var saveError: String?

    var body: some View {
        TabView {
            mirrors.tabItem { Label("Mirrors", systemImage: "folder") }
            service.tabItem { Label("Service", systemImage: "gearshape") }
        }
        // Resizable: the emitter table grows with the number of mirrors, and the paths in it are
        // long enough that a fixed 620pt window truncates them.
        .frame(minWidth: 580, idealWidth: 720, maxWidth: .infinity, minHeight: 420, idealHeight: 560, maxHeight: .infinity)
        .task {
            await store.refreshAll()
            load()
            await store.refreshCatalog()
        }
    }

    // ── mirrors ──────────────────────────────────────────────────────────────

    private var mirrors: some View {
        VStack(alignment: .leading, spacing: 0) {
            // ONE scrolling column: two independently scrolling panes made the window feel like
            // two windows, and the top one could never show more than two fields.
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    PanelSection("Server") {
                        VStack(alignment: .leading, spacing: 8) {
                            field("Stream", "https://hotseat.example.com", $config.streamBaseUrl)
                            field("Namespace", "default", $config.namespace)
                            field("Client", EmitterRow.defaultClientBaseURL, $clientBaseURL)
                            Text("Stream is the host the mirror tails. Client is where the globe button opens a "
                                + "workspace — often a different host, and this app's own setting (saved as you type).")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }

                    PanelSection(
                        "Mirrored workspaces",
                        boxed: false,
                        accessory: {
                            HStack(spacing: 8) {
                                if store.catalogError != nil {
                                    Text("Workspace list needs a running mirror")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                // These cards ARE the config file; a way to reach it belongs here,
                                // not only in the Service tab.
                                RevealButton(path: loadedFrom, help: "Show the config file in Finder")
                                Button("Add") { config.emitters.append(EmitterEntry()) }
                            }
                        }
                    ) {
                        VStack(spacing: 10) {
                            ForEach($config.emitters) { $emitter in
                                EmitterRow(
                                    emitter: $emitter,
                                    catalog: store.catalog,
                                    taken: Set(config.emitters.map(\.workspaceId))
                                ) {
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
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            Divider()

            // The footer stays put: scrolling Save off the bottom of a config editor is a way to
            // lose work.
            VStack(alignment: .leading, spacing: 8) {
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
    }

    /// A labelled text field, sharing the Service tab's label column so both tabs line up.
    private func field(_ label: String, _ placeholder: String, _ text: Binding<String>) -> some View {
        HStack(spacing: 6) {
            Text(label).frame(width: 74, alignment: .leading).foregroundStyle(.secondary)
            TextField(placeholder, text: text).textFieldStyle(.roundedBorder)
        }
        .font(.caption)
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
        ServiceTab(store: store, updates: updates)
    }
}

/// One emitter: which workspace, and the folder it is written to.
///
/// The workspace is chosen by NAME — the id is machine detail that tells a person nothing, and
/// the picker is the only thing that can produce a valid one anyway. It only ever appears as a
/// fallback label for an emitter the catalog cannot resolve (no mirror running, or a workspace
/// this account can no longer see), where it is the only truth available.
private struct EmitterRow: View {
    @Binding var emitter: EmitterEntry
    let catalog: [CatalogWorkspace]
    /// Workspace ids already claimed by another emitter — offered but not selectable.
    let taken: Set<String>
    let onDelete: () -> Void

    @AppStorage(EmitterRow.clientBaseURLKey) private var clientBaseURL = EmitterRow.defaultClientBaseURL

    static let clientBaseURLKey = "clientBaseURL"
    /// Where the globe button opens a workspace: the wiki CLIENT, which is a different host from
    /// the stream the mirror tails and cannot be derived from it. This is where this build ships
    /// pointed; change it in Configure → Server for a different deployment.
    static let defaultClientBaseURL = "https://wiki.thegoldenmule.com"

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 4) {
                picker
                Spacer()
                Button { openInWiki() } label: { Image(systemName: "globe") }
                    .buttonStyle(.borderless)
                    .help("Open this workspace in the wiki (\(clientBaseURL))")
                    .disabled(emitter.workspaceId.isEmpty)
                Button { openFolder() } label: { Image(systemName: "folder") }
                    .buttonStyle(.borderless)
                    .help("Open the mirrored folder")
                    .disabled(!folderExists)
                Button(role: .destructive, action: onDelete) { Image(systemName: "trash") }
                    .buttonStyle(.borderless)
                    .help("Stop mirroring this workspace")
            }
            HStack(spacing: 8) {
                TextField("/absolute/path/to/checkout/docs", text: $emitter.root)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.caption, design: .monospaced))
                Button("Choose…") { chooseFolder() }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.04)))
    }

    /// The workspace's name, or the bare id when nothing can resolve it.
    private var title: String {
        if let name = catalog.first(where: { $0.id == emitter.workspaceId })?.name { return name }
        return emitter.workspaceId.isEmpty ? "Choose a workspace…" : emitter.workspaceId
    }

    private var picker: some View {
        Menu {
            if catalog.isEmpty {
                Text("Start the mirror to list workspaces")
            } else {
                ForEach(catalog) { workspace in
                    Button(workspace.name) { emitter.workspaceId = workspace.id }
                        // One workspace, one emitter: the mirror rejects a duplicate anyway.
                        .disabled(taken.contains(workspace.id) && workspace.id != emitter.workspaceId)
                }
            }
        } label: {
            Text(title).font(.headline)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
    }

    private var folderExists: Bool {
        var isDirectory: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: emitter.root, isDirectory: &isDirectory)
        return exists && isDirectory.boolValue
    }

    private func openFolder() {
        NSWorkspace.shared.open(URL(fileURLWithPath: emitter.root))
    }

    private func openInWiki() {
        // Matches wiki-ui's own workspaceHref: `/${encodeURIComponent(workspaceId)}`.
        let encoded = emitter.workspaceId.addingPercentEncoding(withAllowedCharacters: Self.uriComponent)
        let trimmed = clientBaseURL.trimmingCharacters(in: .whitespaces)
        let base = trimmed.hasSuffix("/") ? String(trimmed.dropLast()) : trimmed
        guard let encoded, let url = URL(string: "\(base)/\(encoded)"), url.scheme != nil else { return }
        NSWorkspace.shared.open(url)
    }

    /// The character set `encodeURIComponent` leaves alone.
    private static let uriComponent: CharacterSet = {
        var set = CharacterSet.alphanumerics
        set.insert(charactersIn: "-_.!~*'()")
        return set
    }()

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
    @Bindable var updates: UpdateController
    @State private var mode = "source"
    @State private var installerDirectory = ""
    @State private var launchAtLogin = false
    @State private var automaticUpdates = true

    var body: some View {
        // Scrolls for the same reason the Mirrors tab does: the window is resizable now, and
        // "Runs" alone can wrap to three lines on a narrow one.
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                PanelSection("Status") {
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

                PanelSection("Install") {
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

                PanelSection("This app") {
                    VStack(alignment: .leading, spacing: 8) {
                        row("Version", updates.current.map(String.init(describing:)) ?? "unknown")
                        HStack(spacing: 8) {
                            Text("Updates").frame(width: 74, alignment: .leading).foregroundStyle(.secondary)
                            Text(updateSummary)
                            Spacer()
                            Button("Check now") { Task { await updates.check(userInitiated: true) } }
                                .disabled(updates.state == .checking || updates.state == .installing)
                            if let update = updates.pending {
                                Button("Install " + update.version.description) { Task { await updates.install(update) } }
                                    .disabled(updates.state == .installing)
                            }
                        }
                        .font(.caption)
                        Toggle("Check for updates automatically", isOn: $automaticUpdates)
                            .onChange(of: automaticUpdates) { _, on in updates.automaticallyChecks = on }
                        Divider().padding(.vertical, 2)
                        Toggle("Show this app in the menu bar at login", isOn: $launchAtLogin)
                            .onChange(of: launchAtLogin) { _, enabled in setLaunchAtLogin(enabled) }
                        Text("The mirror itself runs from the launchd agent above — it keeps mirroring whether or not this app is open.")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer()
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .onAppear {
            if let info = LaunchAgent.info() {
                mode = info.mode == "custom" ? "source" : info.mode
                installerDirectory = info.installerDirectory ?? ""
            }
            launchAtLogin = SMAppService.mainApp.status == .enabled
            automaticUpdates = updates.automaticallyChecks
        }
    }

    /// One line describing where the updater has got to.
    private var updateSummary: String {
        switch updates.state {
        case .checking: return "checking…"
        case .installing: return "installing…"
        case .available(let update): return "\(update.version) is available"
        case .failed(let message): return message
        case .upToDate, .idle:
            guard let last = updates.lastCheckedAt else { return "not checked yet" }
            let formatter = RelativeDateTimeFormatter()
            formatter.unitsStyle = .full
            return "up to date, checked \(formatter.localizedString(for: last, relativeTo: Date()))"
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
                RevealButton(path: reveal)
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

/// A titled block whose heading lines up with its own content.
///
/// `GroupBox` insets its label past the box it labels, which reads as a mistake next to every
/// other control in the window. `boxed: false` is for content that already draws its own cards.
private struct PanelSection<Content: View, Accessory: View>: View {
    private let title: String
    private let boxed: Bool
    private let accessory: () -> Accessory
    private let content: () -> Content

    init(
        _ title: String,
        boxed: Bool = true,
        @ViewBuilder accessory: @escaping () -> Accessory,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.boxed = boxed
        self.accessory = accessory
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title).font(.headline)
                Spacer()
                accessory()
            }
            if boxed {
                content()
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.04)))
            } else {
                content().frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

extension PanelSection where Accessory == EmptyView {
    init(_ title: String, boxed: Bool = true, @ViewBuilder content: @escaping () -> Content) {
        self.init(title, boxed: boxed, accessory: { EmptyView() }, content: content)
    }
}

/// Reveals a file in Finder, selected in its containing folder.
private struct RevealButton: View {
    let path: String
    var help = "Show in Finder"

    var body: some View {
        Button {
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
        } label: {
            Image(systemName: "folder")
        }
        .buttonStyle(.borderless)
        .help(help)
        // A path that does not exist yet (no log until the agent has run, no config until the
        // first save) would open the user's home folder instead, which looks like a bug.
        .disabled(path.isEmpty || !FileManager.default.fileExists(atPath: path))
    }
}
