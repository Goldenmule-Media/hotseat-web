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

        var id: String { workspaceId }
        var displayName: String { name ?? workspaceId }
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

    private func get<T: Decodable>(_ path: String, as: T.Type) async throws -> T {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
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
