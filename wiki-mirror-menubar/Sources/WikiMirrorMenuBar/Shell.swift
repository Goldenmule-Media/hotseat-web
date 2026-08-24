import Foundation

/// The result of a child process: everything a caller needs to explain a failure to a person.
struct ShellResult {
    let status: Int32
    let stdout: String
    let stderr: String

    var succeeded: Bool { status == 0 }
    /// Whatever the process said, preferring stderr — that is where tools put the reason.
    var message: String {
        let text = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? stdout.trimmingCharacters(in: .whitespacesAndNewlines) : text
    }
}

enum ShellError: LocalizedError {
    case failed(command: String, result: ShellResult)

    var errorDescription: String? {
        switch self {
        case .failed(let command, let result):
            let detail = result.message
            return detail.isEmpty ? "\(command) exited \(result.status)" : detail
        }
    }
}

/// Runs short-lived helper processes (launchctl, the installer script, `wiki-mirror login`).
///
/// Everything here is off the main actor: a menu that blocks while `launchctl` thinks is a menu
/// that beachballs.
enum Shell {
    @discardableResult
    static func run(_ executable: String, _ arguments: [String], cwd: String? = nil) async -> ShellResult {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(returning: runSync(executable, arguments, cwd: cwd))
            }
        }
    }

    /// Run and throw a message a person can act on when it fails.
    @discardableResult
    static func check(_ executable: String, _ arguments: [String], cwd: String? = nil) async throws -> ShellResult {
        let result = await run(executable, arguments, cwd: cwd)
        guard result.succeeded else {
            throw ShellError.failed(command: ([executable] + arguments).joined(separator: " "), result: result)
        }
        return result
    }

    private static func runSync(_ executable: String, _ arguments: [String], cwd: String?) -> ShellResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        if let cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err
        do {
            try process.run()
        } catch {
            return ShellResult(status: -1, stdout: "", stderr: error.localizedDescription)
        }
        // Drain BOTH pipes concurrently, then wait. Reading stdout to the end first deadlocks any
        // child that fills the 64K stderr buffer while we are still blocked on stdout — and the
        // mirror is a process that logs a JSON line per commit.
        var errData = Data()
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            errData = err.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        let outData = out.fileHandleForReading.readDataToEndOfFile()
        group.wait()
        process.waitUntilExit()
        return ShellResult(
            status: process.terminationStatus,
            stdout: String(data: outData, encoding: .utf8) ?? "",
            stderr: String(data: errData, encoding: .utf8) ?? ""
        )
    }
}
