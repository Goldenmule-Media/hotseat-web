import Foundation
import Observation

/// The one-word answer the menu-bar icon has to give.
///
/// Ranked the same way wiki-ui ranks it, and for the same reason: a process-wide problem
/// (no service, expired credentials, an unreachable host) explains every workspace at once, so
/// reporting it per workspace would be seven copies of one answer with the cause hidden.
enum MirrorHealth {
    case notInstalled
    case stopped
    case starting
    case signedOut
    case hostUnreachable
    case degraded
    case idle
    case healthy

    /// Menu-bar glyph. Distinct SHAPES, not colors: the menu bar renders these monochrome.
    var symbol: String {
        switch self {
        case .notInstalled: return "circle.dotted"
        case .stopped: return "pause.circle"
        case .starting: return "circle.dashed"
        case .signedOut: return "person.crop.circle.badge.exclamationmark"
        case .hostUnreachable: return "bolt.horizontal.circle"
        case .degraded: return "exclamationmark.triangle"
        case .idle: return "tray"
        case .healthy: return "arrow.triangle.2.circlepath"
        }
    }

    var summary: String {
        switch self {
        case .notInstalled: return "Mirror not installed"
        case .stopped: return "Mirror stopped"
        case .starting: return "Mirror starting…"
        case .signedOut: return "Signed out"
        case .hostUnreachable: return "Server unreachable"
        case .degraded: return "Mirror degraded"
        case .idle: return "Nothing mirrored yet"
        case .healthy: return "Mirroring"
        }
    }
}

/// Everything the UI observes: the last status poll, the launchd job's state, the catalog, and
/// whatever action is currently in flight.
@MainActor
@Observable
final class MirrorStore {
    private(set) var status: MirrorStatus?
    private(set) var probeError: String?
    private(set) var agent = AgentState(installed: false, loaded: false, running: false, lastExitCode: nil)
    private(set) var catalog: [CatalogWorkspace] = []
    private(set) var catalogError: String?
    /// A user-triggered action in flight (restart, sign-in, install) — the menu disables itself.
    private(set) var busy: String?
    /// The result of the last action, shown until the next one.
    var lastActionMessage: String?

    private var client = MirrorClient()
    private var timer: Timer?

    /// The config file the editor must target.
    ///
    /// The running mirror's own answer first. When it is down, fall back to the `--config` baked
    /// into the installed job before the per-machine default: a mirror started with `--config`
    /// elsewhere must not have a DIFFERENT file edited out from under it just because it happens
    /// to be stopped.
    var configPath: String { status?.configPath ?? LaunchAgent.configuredPath() ?? MirrorConfigFile.defaultPath }

    /// True when `configPath` is a guess rather than the running mirror's own answer.
    var configPathIsGuess: Bool { status?.configPath == nil }

    /// The local endpoint this app polls, port included — the first thing to check by hand.
    var healthURL: String { client.baseURL.absoluteString }

    var health: MirrorHealth {
        guard let status else {
            if !agent.installed { return .notInstalled }
            // Loaded is not running: a job parked by KeepAlive {SuccessfulExit:false}, or one
            // crash-looping through its throttle window, prints as bootstrapped either way.
            return agent.loaded && agent.running ? .starting : .stopped
        }
        if status.auth?.expired == true || status.server?.unauthorized == true { return .signedOut }
        if status.server?.reachable == false { return .hostUnreachable }
        if status.workspaces.isEmpty { return .idle }
        if status.workspaces.contains(where: { !$0.connected || $0.lastReconcileError != nil }) { return .degraded }
        return .healthy
    }

    /// A single line under the headline explaining the current state.
    var detail: String {
        switch health {
        case .notInstalled:
            return "No launchd agent is installed on this Mac."
        case .stopped:
            if let code = agent.lastExitCode, code != 0 {
                return "The agent is installed but stopped (last exit \(code)). Check the log."
            }
            return agent.loaded
                ? "The agent is loaded but not running. Restart it, or check the log."
                : "The agent is installed but not loaded." 
        case .starting:
            return "Waiting for \(client.baseURL.absoluteString)…"
        case .signedOut:
            let user = status?.auth?.user.map { " (was \($0))" } ?? ""
            return "Credentials for \(host) expired\(user) — sign in again."
        case .hostUnreachable:
            return status?.server?.lastError.map { "\(host): \($0)" } ?? "Can't reach \(host)."
        case .idle:
            return "Connected to \(host). Add a folder to mirror."
        case .degraded, .healthy:
            let count = status?.workspaces.count ?? 0
            let live = status?.workspaces.filter { $0.connected && $0.lastReconcileError == nil }.count ?? 0
            return "\(live) of \(count) mirroring · \(host)"
        }
    }

    var host: String {
        guard let raw = status?.streamBaseUrl, let url = URL(string: raw) else { return "the server" }
        return url.host ?? raw
    }

    /// Begin polling. Idempotent: the app calls this from its initializer AND from the config
    /// window, and a second never-invalidated 5s timer per window open is a slow leak.
    func start() {
        guard timer == nil else { return }
        Task { await refreshAll() }
        let timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in await self?.refreshAll() }
        }
        // The menu is not the only thing that matters; let this fire while menus are open.
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    func refreshAll() async {
        await refreshStatus()
        agent = await LaunchAgent.state()
    }

    func refreshStatus() async {
        do {
            status = try await client.status()
            probeError = nil
        } catch {
            status = nil
            probeError = error.localizedDescription
        }
    }

    /// Load the workspaces this account can mirror. Only the running mirror can answer — it holds
    /// the credentials — so this is unavailable while the service is down.
    func refreshCatalog() async {
        do {
            catalog = try await client.workspaces()
            catalogError = nil
        } catch {
            catalog = []
            catalogError = error.localizedDescription
        }
    }

    // ── actions ──────────────────────────────────────────────────────────────

    func restart() async {
        await perform("Restarting…") {
            try await LaunchAgent.restart()
            return "Mirror restarted."
        }
    }

    func signIn() async {
        await perform("Waiting for the browser…") {
            try await LaunchAgent.signIn()
            // A fresh grant only reaches a running mirror when it rebuilds its engine; a restart
            // makes that immediate instead of waiting for the next probe recovery.
            try? await LaunchAgent.restart()
            return "Signed in."
        }
    }

    func install(installerDirectory: String, mode: String) async {
        await perform("Installing…") {
            try await LaunchAgent.install(installerDirectory: installerDirectory, mode: mode)
            return "Service installed."
        }
    }

    func uninstall() async {
        await perform("Removing…") {
            try await LaunchAgent.uninstall()
            return "Service removed."
        }
    }

    /// Save an edited config and restart so it takes effect (the mirror reads it at startup).
    func save(config: MirrorConfigFile) async -> Bool {
        let path = configPath
        var ok = false
        await perform("Saving…") {
            try config.save(to: path)
            if LaunchAgent.isInstalled { try? await LaunchAgent.restart() }
            ok = true
            return "Saved \(path). Restarting the mirror."
        }
        return ok
    }

    private func perform(_ label: String, _ work: () async throws -> String) async {
        busy = label
        defer { busy = nil }
        do {
            lastActionMessage = try await work()
        } catch {
            lastActionMessage = error.localizedDescription
        }
        await refreshAll()
    }
}
