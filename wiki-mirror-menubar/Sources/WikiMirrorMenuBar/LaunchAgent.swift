import Foundation

/// What the installed launchd job actually runs.
struct LaunchAgentInfo {
    let programArguments: [String]
    let workingDirectory: String?

    /// How the mirror is being run, inferred from its arguments.
    var mode: String {
        if programArguments.contains(where: { $0.hasSuffix("wiki-mirror.mjs") }) { return "portable" }
        if programArguments.contains("tsx") { return "source" }
        if programArguments.contains(where: { $0.hasSuffix("dist/bin.js") }) { return "dist" }
        return "custom"
    }

    /// The folder the installer that produced this job lives in — where `install-agent.sh` is.
    var installerDirectory: String? {
        if mode == "portable" {
            return programArguments.first { $0.hasSuffix("wiki-mirror.mjs") }
                .map { (($0 as NSString).deletingLastPathComponent) }
        }
        return workingDirectory.map { ($0 as NSString).appendingPathComponent("scripts") }
    }

    /// The index of the script/binary in `programArguments`, past any interpreter flags.
    private var scriptIndex: Int? {
        programArguments.firstIndex { $0.hasSuffix(".ts") || $0.hasSuffix(".js") || $0.hasSuffix(".mjs") }
    }

    /// The command that signs this machine in, so the app never hardcodes a runtime.
    ///
    /// `login` must sit immediately AFTER the script, because the mirror only takes the login
    /// path when it is `argv[0]`. Appending it at the end (past `--models-dir …`) silently starts
    /// a SECOND mirror instead of signing in.
    var loginCommand: [String]? {
        guard let scriptIndex else { return nil }
        var command = programArguments
        command.insert("login", at: scriptIndex + 1)
        return command
    }
}

/// The launchd side of the service: install, inspect, restart, remove.
///
/// launchd owns the mirror; this app is a console for it. Every mutation goes through the SAME
/// `install-agent.sh` the CLI uses, so there is exactly one definition of the job — an app that
/// wrote its own plist would drift from the script the moment either changed.
enum LaunchAgent {
    static let label = "com.thegoldenmule.wiki-mirror"

    static var plistPath: String {
        (NSHomeDirectory() as NSString).appendingPathComponent("Library/LaunchAgents/\(label).plist")
    }

    static var logPath: String {
        (NSHomeDirectory() as NSString).appendingPathComponent("Library/Logs/wiki-mirror/mirror.log")
    }

    static var isInstalled: Bool { FileManager.default.fileExists(atPath: plistPath) }

    /// Parse the installed plist. Nil when no agent is installed (or it is unreadable).
    static func info() -> LaunchAgentInfo? {
        guard let data = FileManager.default.contents(atPath: plistPath),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let arguments = plist["ProgramArguments"] as? [String], !arguments.isEmpty
        else { return nil }
        return LaunchAgentInfo(programArguments: arguments, workingDirectory: plist["WorkingDirectory"] as? String)
    }

    private static var domain: String { "gui/\(getuid())" }

    /// What launchd currently thinks of the job.
    ///
    /// `launchctl print` exiting 0 only means the job is BOOTSTRAPPED. A job that ran, exited 0,
    /// and is being left alone by `KeepAlive {SuccessfulExit: false}` prints exactly the same way
    /// as one that is running, which would leave the app saying "starting…" forever.
    static func state() async -> AgentState {
        guard isInstalled else { return AgentState(installed: false, loaded: false, running: false, lastExitCode: nil) }
        let result = await Shell.run("/bin/launchctl", ["print", "\(domain)/\(label)"])
        guard result.succeeded else {
            return AgentState(installed: true, loaded: false, running: false, lastExitCode: nil)
        }
        let running = result.stdout.contains("state = running")
        var lastExitCode: Int?
        for line in result.stdout.split(separator: "\n") {
            guard line.contains("last exit code =") else { continue }
            lastExitCode = Int(line.split(separator: "=").last?.trimmingCharacters(in: .whitespaces) ?? "")
            break
        }
        return AgentState(installed: true, loaded: true, running: running, lastExitCode: lastExitCode)
    }

    /// Restart the job in place — how a config change takes effect (the mirror reads it at startup).
    static func restart() async throws {
        try await Shell.check("/bin/launchctl", ["kickstart", "-k", "\(domain)/\(label)"])
    }

    /// Install (or reinstall) the agent by running the installer that ships with the mirror.
    static func install(installerDirectory: String, mode: String) async throws {
        let script = (installerDirectory as NSString).appendingPathComponent("install-agent.sh")
        guard FileManager.default.fileExists(atPath: script) else {
            throw ShellError.failed(
                command: script,
                result: ShellResult(status: -1, stdout: "", stderr: "No install-agent.sh in \(installerDirectory)")
            )
        }
        try await Shell.check("/bin/bash", [script, "--mode", mode], cwd: installerDirectory)
    }

    /// Remove the agent. Uses launchctl directly: the installer may no longer be where it was.
    static func uninstall() async throws {
        _ = await Shell.run("/bin/launchctl", ["bootout", "\(domain)/\(label)"])
        try? FileManager.default.removeItem(atPath: plistPath)
    }

    /// Run the mirror's own `login` command and wait for it (it opens a browser and serves a
    /// loopback callback). The running mirror picks the new grant up on its next self-restart.
    static func signIn() async throws {
        guard let info = info() else {
            throw ShellError.failed(
                command: "login",
                result: ShellResult(status: -1, stdout: "", stderr: "No mirror is installed to sign in with.")
            )
        }
        guard let command = info.loginCommand, let executable = command.first else {
            throw ShellError.failed(
                command: "login",
                result: ShellResult(
                    status: -1,
                    stdout: "",
                    stderr: "Could not tell which program the agent runs, so there is nothing to sign in with. "
                        + "Run `wiki-mirror login` yourself."
                )
            )
        }
        try await Shell.check(executable, Array(command.dropFirst()), cwd: info.workingDirectory)
    }

    /// The `--config` path baked into the installed job, when it names one.
    static func configuredPath() -> String? {
        guard let arguments = info()?.programArguments,
              let index = arguments.firstIndex(of: "--config"),
              index + 1 < arguments.count
        else { return nil }
        return arguments[index + 1]
    }
}

/// launchd's view of the job: bootstrapped is not the same as running.
struct AgentState {
    let installed: Bool
    let loaded: Bool
    let running: Bool
    /// The job's last exit status, when launchd has one to report.
    let lastExitCode: Int?
}
