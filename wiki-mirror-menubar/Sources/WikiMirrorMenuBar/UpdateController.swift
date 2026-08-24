import AppKit
import Foundation
import Observation

/// Drives update checks and hands an accepted update to the installer.
///
/// Checks automatically, installs only on request. A silent install would restart the mirror
/// service — and on a machine that mirrors into working checkouts, doing that mid-edit without
/// being asked is not a courtesy.
@MainActor
@Observable
final class UpdateController {
    enum State: Equatable {
        case idle
        case checking
        case upToDate
        case available(AvailableUpdate)
        case installing
        case failed(String)
    }

    private(set) var state: State = .idle
    private(set) var lastCheckedAt: Date?

    /// The version this app reports. Nil only outside a bundle (tests, `swift run`).
    let current: AppVersion? = AppVersion.current

    private var checker = UpdateChecker()
    private var timer: Timer?

    /// Whether to look for updates at all. Off means never touching the network.
    var automaticallyChecks: Bool {
        get { UserDefaults.standard.object(forKey: Self.autoKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: Self.autoKey) }
    }

    private static let autoKey = "automaticallyChecksForUpdates"
    private static let interval: TimeInterval = 24 * 60 * 60

    /// The update the user could install right now, if any.
    var pending: AvailableUpdate? {
        if case .available(let update) = state { return update }
        return nil
    }

    func start() {
        guard timer == nil else { return }
        Task { await checkIfDue() }
        let timer = Timer.scheduledTimer(withTimeInterval: 3600, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in await self?.checkIfDue() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    /// Check only when a day has passed — the hourly tick is just so a long-running app notices.
    private func checkIfDue() async {
        guard automaticallyChecks else { return }
        if let last = lastCheckedAt, Date().timeIntervalSince(last) < Self.interval { return }
        await check(userInitiated: false)
    }

    func check(userInitiated: Bool) async {
        guard let current else {
            if userInitiated { state = .failed("This build has no version to compare against.") }
            return
        }
        // Never interrupt a check or an install that is already running.
        if state == .checking || state == .installing { return }
        // An update already found stays on offer; re-checking would just re-find it.
        if !userInitiated, pending != nil { return }

        state = .checking
        do {
            let found = try await checker.check(current: current)
            lastCheckedAt = Date()
            state = found.map(State.available) ?? .upToDate
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// Download, verify, and hand off to the release's own installer.
    func install(_ update: AvailableUpdate) async {
        state = .installing
        do {
            let unpacked = try await checker.stage(update)
            try handOff(installerAt: unpacked)
            // The installer quits this app moments from now; leave the state as-is so the menu
            // keeps saying what is happening until it does.
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// Run the unpacked release's `install.sh` so that it outlives the app it is about to replace.
    private func handOff(installerAt folder: URL) throws {
        let script = folder.appendingPathComponent("install.sh").path
        // On a machine whose agent runs from a repo checkout or a local build, installing the
        // mirror half would repoint the service at a portable copy and silently orphan the
        // checkout it was built to track. Update only the app there.
        let mode = LaunchAgent.info()?.mode
        var arguments = ["/bin/bash", script]
        if mode == "source" || mode == "dist" { arguments.append("--app-only") }

        // The installer's whole job is to kill this process and replace the bundle underneath it,
        // so it is launched under `nohup`: SIGHUP-immune, and with its output on disk. Without
        // that log an install that fails AFTER the app dies leaves nothing to read.
        let log = Self.updateLogURL
        try? FileManager.default.createDirectory(
            at: log.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: log.path) {
            FileManager.default.createFile(atPath: log.path, contents: nil)
        }
        let handle = try FileHandle(forWritingTo: log)
        handle.seekToEndOfFile()

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/nohup")
        process.arguments = arguments
        process.currentDirectoryURL = folder
        process.standardOutput = handle
        process.standardError = handle
        try process.run()
    }

    /// Where a hand-off writes its output, next to the mirror's own logs.
    static var updateLogURL: URL {
        URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Logs/wiki-mirror/update.log")
    }
}
