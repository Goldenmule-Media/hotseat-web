import Foundation

/// One mirrored workspace: a workspace id and the absolute directory it is written to.
struct EmitterEntry: Identifiable, Hashable {
    var id = UUID()
    var workspaceId: String = ""
    var root: String = ""
}

/// The per-machine `~/.wiki/wiki-mirror.config.json`, edited in place.
///
/// Unknown keys are carried through verbatim: this file is shared with the CLI and hand-edited,
/// and an editor that silently drops `token`, `healthPort`, or a key added by a newer mirror
/// would be worse than no editor at all.
struct MirrorConfigFile {
    var streamBaseUrl: String = "http://127.0.0.1:4437"
    var namespace: String = "default"
    var emitters: [EmitterEntry] = []
    /// Everything else the file contained, keyed as it appeared.
    var extra: [String: Any] = [:]

    /// The default location, shared by every project on this Mac.
    static var defaultPath: String {
        (NSHomeDirectory() as NSString).appendingPathComponent(".wiki/wiki-mirror.config.json")
    }

    /// Load `path`. A missing file is not an error — it means "this machine mirrors nothing yet".
    static func load(from path: String) throws -> MirrorConfigFile {
        guard FileManager.default.fileExists(atPath: path) else { return MirrorConfigFile() }
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ConfigError.notAnObject(path)
        }
        var config = MirrorConfigFile()
        var extra = object
        if let value = object["streamBaseUrl"] as? String { config.streamBaseUrl = value }
        if let value = object["namespace"] as? String { config.namespace = value }
        if let raw = object["emitters"] {
            // A malformed `emitters` must be an ERROR, not an empty list: quietly reading zero
            // emitters and then saving would erase every mirror on this machine.
            guard let entries = raw as? [[String: Any]] else { throw ConfigError.malformedEmitters(path) }
            config.emitters = entries.map {
                EmitterEntry(workspaceId: $0["workspaceId"] as? String ?? "", root: $0["root"] as? String ?? "")
            }
        }
        for key in ["streamBaseUrl", "namespace", "emitters"] { extra.removeValue(forKey: key) }
        config.extra = extra
        return config
    }

    /// Write atomically, keeping one `.bak` of what was there before.
    func save(to path: String) throws {
        let problems = validate()
        guard problems.isEmpty else { throw ConfigError.invalid(problems) }

        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if FileManager.default.fileExists(atPath: path) {
            let backup = path + ".bak"
            try? FileManager.default.removeItem(atPath: backup)
            try? FileManager.default.copyItem(atPath: path, toPath: backup)
        }
        let temp = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).tmp")
        try? FileManager.default.removeItem(at: temp)
        try Data(serialized().utf8).write(to: temp)
        _ = try FileManager.default.replaceItemAt(url, withItemAt: temp)
    }

    /// Everything wrong with this config, in the words the mirror itself would use.
    func validate() -> [String] {
        var problems: [String] = []
        var seenWorkspaces = Set<String>()
        var seenRoots = Set<String>()
        for emitter in emitters {
            let workspace = emitter.workspaceId.trimmingCharacters(in: .whitespaces)
            let root = emitter.root.trimmingCharacters(in: .whitespaces)
            if workspace.isEmpty {
                problems.append("Every mirror needs a workspace.")
            } else if !seenWorkspaces.insert(workspace).inserted {
                problems.append("\(workspace) is listed twice.")
            }
            if root.isEmpty {
                problems.append("\(workspace.isEmpty ? "A mirror" : workspace) needs a folder.")
            } else if !root.hasPrefix("/") {
                problems.append("\(root) must be an absolute path.")
            } else if !seenRoots.insert(root).inserted {
                // One root = one writer: two emitters would clobber each other's manifest.
                problems.append("Two workspaces both write to \(root) — give each its own folder.")
            }
        }
        if URL(string: streamBaseUrl)?.scheme == nil {
            problems.append("The server URL needs a scheme, e.g. https://…")
        }
        if namespace.trimmingCharacters(in: .whitespaces).isEmpty {
            problems.append("The namespace can't be empty.")
        }
        return problems
    }

    /// Serialize with a stable, human-readable key order — the CLI and a person both read this file.
    private func serialized() -> String {
        var lines: [String] = []
        lines.append("  \(Self.quote("streamBaseUrl")): \(Self.quote(streamBaseUrl))")
        lines.append("  \(Self.quote("namespace")): \(Self.quote(namespace))")
        for key in extra.keys.sorted() where key != "emitters" {
            if let value = Self.jsonText(extra[key]!, indent: "  ") {
                lines.append("  \(Self.quote(key)): \(value)")
            }
        }
        let entries = emitters.map { emitter -> String in
            let workspace = emitter.workspaceId.trimmingCharacters(in: .whitespaces)
            let root = emitter.root.trimmingCharacters(in: .whitespaces)
            return "    {\n      \(Self.quote("workspaceId")): \(Self.quote(workspace)),\n      \(Self.quote("root")): \(Self.quote(root))\n    }"
        }
        let emitterText = entries.isEmpty ? "[]" : "[\n\(entries.joined(separator: ",\n"))\n  ]"
        lines.append("  \(Self.quote("emitters")): \(emitterText)")
        return "{\n\(lines.joined(separator: ",\n"))\n}\n"
    }

    /// JSON-quote a string (escapes handled by the serializer, not by hand).
    static func quote(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
              let text = String(data: data, encoding: .utf8)
        else { return "\"\"" }
        return text
    }

    /// Pretty-print a preserved value, re-indented to sit inside the top-level object.
    private static func jsonText(_ value: Any, indent: String) -> String? {
        guard let data = try? JSONSerialization.data(
            withJSONObject: value, options: [.fragmentsAllowed, .prettyPrinted, .sortedKeys]),
            let text = String(data: data, encoding: .utf8)
        else { return nil }
        return text.split(separator: "\n", omittingEmptySubsequences: false)
            .enumerated()
            .map { $0.offset == 0 ? String($0.element) : indent + $0.element }
            .joined(separator: "\n")
    }
}

enum ConfigError: LocalizedError {
    case notAnObject(String)
    case malformedEmitters(String)
    case invalid([String])

    var errorDescription: String? {
        switch self {
        case .notAnObject(let path): return "\(path) is not a JSON object."
        case .malformedEmitters(let path): return "\(path) has an \"emitters\" key that is not a list of entries."
        case .invalid(let problems): return problems.joined(separator: "\n")
        }
    }
}
