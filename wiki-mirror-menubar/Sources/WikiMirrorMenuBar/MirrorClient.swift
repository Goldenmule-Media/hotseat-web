import Foundation

/// The `wiki-mirror` health payload, decoded.
///
/// Every field the mirror gained recently is optional here for the same reason wiki-ui keeps
/// them optional: the mirror is a separately installed process that may be older than this app,
/// and a decode failure would render as "no mirror running" — the one thing that must never be
/// said about a mirror that is, in fact, running.
struct MirrorStatus: Decodable {
    let status: String
    let uptimeMs: Double
    let pid: Int?
    let namespace: String
    let streamBaseUrl: String
    let configPath: String?
    let auth: AuthStatus?
    let server: ServerStatus?
    let workspaces: [WorkspaceStatus]

    struct AuthStatus: Decodable {
        let mode: String
        let server: String?
        let user: String?
        let accessTokenExpiresAt: Double?
        let refreshTokenExpiresAt: Double?
        let expired: Bool
    }

    struct ServerStatus: Decodable {
        let reachable: Bool
        let lastProbeAt: Double?
        let lastError: String?
        let unauthorized: Bool
    }

    struct WorkspaceStatus: Decodable, Identifiable {
        let workspaceId: String
        let name: String?
        let root: String
        let appliedVersion: Int
        let lastReconcileAt: Double?
        let lastReconcileError: String?
        let connected: Bool
        let stuck: Bool?
        let nextRetryAt: Double?
        let attempts: Int?
        /// Set when this entry mirrors one page's subtree rather than the whole workspace.
        let subtreeRootId: String?
        let subtreeTitle: String?

        /// The root, not the workspace: several entries may mirror subtrees of one workspace,
        /// and every entry owns a distinct root.
        var id: String { root }

        var displayName: String {
            let workspace = name ?? workspaceId
            guard let subtree = subtreeTitle ?? subtreeRootId else { return workspace }
            return "\(workspace) › \(subtree)"
        }
    }
}

/// One entry from `GET /_mirror/workspaces`: everything on the server, and where we mirror it.
struct CatalogWorkspace: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let status: String
    let mirroredRoot: String?
}

private struct CatalogResponse: Decodable {
    let workspaces: [CatalogWorkspace]
}

/// One page from `GET /_mirror/workspaces/{id}/tree`: a candidate subtree root, depth-first.
struct PageTreeNode: Decodable, Identifiable, Hashable {
    let id: String
    let title: String
    let type: String
    let depth: Int
    let archived: Bool
}

private struct PageTreeResponse: Decodable {
    let pages: [PageTreeNode]
}

enum MirrorClientError: LocalizedError {
    case unreachable(String)
    case http(Int)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .unreachable(let detail): return "No mirror answered: \(detail)"
        case .http(let code): return "The mirror answered \(code)"
        case .decoding(let detail): return "Could not read the mirror's answer: \(detail)"
        }
    }
}

/// Reads the local mirror's health endpoint. Loopback only, unauthenticated — the same
/// local-trust model the endpoint itself is built on.
struct MirrorClient {
    var baseURL: URL

    static let defaultBaseURL = URL(string: "http://127.0.0.1:4440")!

    init(baseURL: URL = MirrorClient.defaultBaseURL) {
        self.baseURL = baseURL
    }

    func status() async throws -> MirrorStatus {
        try await get("/_mirror/status", as: MirrorStatus.self)
    }

    func workspaces() async throws -> [CatalogWorkspace] {
        try await get("/_mirror/workspaces", as: CatalogResponse.self).workspaces
    }

    /// The pages a mirror can be scoped to. 503 while the mirror can't open the workspace.
    func pageTree(workspaceId: String) async throws -> [PageTreeNode] {
        let encoded = workspaceId.addingPercentEncoding(withAllowedCharacters: Self.pathSegment) ?? workspaceId
        return try await get("/_mirror/workspaces/\(encoded)/tree", as: PageTreeResponse.self).pages
    }

    /// Unreserved characters plus `:`, which workspace ids carry and a path segment allows.
    private static let pathSegment: CharacterSet = {
        var set = CharacterSet.alphanumerics
        set.insert(charactersIn: "-_.~:")
        return set
    }()

    private func get<T: Decodable>(_ path: String, as: T.Type) async throws -> T {
        // Joined as text: `appendingPathComponent` would re-encode an already-encoded segment.
        let base = baseURL.absoluteString.hasSuffix("/") ? String(baseURL.absoluteString.dropLast()) : baseURL.absoluteString
        guard let url = URL(string: base + path) else {
            throw MirrorClientError.unreachable("bad URL for \(path)")
        }
        var request = URLRequest(url: url)
        // Short: this is a loopback poll behind a 5s timer, and a hung request would stall the
        // whole menu rather than showing the mirror as unreachable.
        request.timeoutInterval = 4
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw MirrorClientError.unreachable(error.localizedDescription)
        }
        if let http = response as? HTTPURLResponse, !(200 ..< 300).contains(http.statusCode) {
            throw MirrorClientError.http(http.statusCode)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw MirrorClientError.decoding(error.localizedDescription)
        }
    }
}
