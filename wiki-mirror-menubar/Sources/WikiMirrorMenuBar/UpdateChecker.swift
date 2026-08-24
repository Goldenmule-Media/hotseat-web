import CryptoKit
import Foundation

/// A release newer than the running app, with the asset to install.
struct AvailableUpdate: Equatable {
    let version: AppVersion
    let downloadURL: URL
    /// Hex SHA-256 published beside the asset, when the release carries one.
    let sha256: String?
    let notes: String
    let releaseURL: URL?
}

enum UpdateError: LocalizedError {
    case network(String)
    case badPayload(String)
    case checksumMismatch(expected: String, actual: String)
    case untrustedHost(String)

    var errorDescription: String? {
        switch self {
        case .network(let detail): return "Could not reach GitHub: \(detail)"
        case .badPayload(let detail): return detail
        case .checksumMismatch(let expected, let actual):
            return "The download didn't match its published checksum (expected \(expected.prefix(12))…, got \(actual.prefix(12))…)."
        case .untrustedHost(let host): return "The release points at an unexpected host (\(host))."
        }
    }
}

/// Finds and installs new releases from the project's public GitHub repo.
///
/// Deliberately not Sparkle: the whole update IS the release tarball we already build, and the
/// installer inside it already knows how to replace a running app and a launchd agent. This only
/// has to find the asset, check it arrived intact, and hand off.
///
/// What the checksum does and does not buy: it catches a truncated or corrupted download. It is
/// NOT a signature — whoever can publish a release can publish a matching checksum. The trust
/// anchor is HTTPS to GitHub plus the host allow-list below.
struct UpdateChecker {
    var repository = "Goldenmule-Media/hotseat-web"
    var session: URLSession = .shared

    /// Hosts a release asset may be fetched from. GitHub redirects downloads to its object store.
    static let allowedHosts: Set<String> = [
        "github.com", "api.github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com",
    ]

    /// The newest release above `current`, or nil when there is nothing newer.
    func check(current: AppVersion) async throws -> AvailableUpdate? {
        // NOT /releases/latest: that is the newest release in the whole repo, which a release for
        // something else entirely would win. Filter to this product's tag prefix instead.
        let url = URL(string: "https://api.github.com/repos/\(repository)/releases?per_page=30")!
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw UpdateError.network(error.localizedDescription)
        }
        if let http = response as? HTTPURLResponse, !(200 ..< 300).contains(http.statusCode) {
            // 403 here is nearly always the unauthenticated rate limit, which is worth naming.
            throw UpdateError.network(
                http.statusCode == 403 ? "rate limited by GitHub, try again later" : "HTTP \(http.statusCode)")
        }
        return try Self.newestUpdate(in: data, current: current)
    }

    /// Pick the newest eligible release out of a GitHub `/releases` payload. Pure, so it can be
    /// tested against fixtures rather than the network.
    static func newestUpdate(in data: Data, current: AppVersion) throws -> AvailableUpdate? {
        guard let releases = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            throw UpdateError.badPayload("GitHub returned something that isn't a release list.")
        }

        var best: AvailableUpdate?
        for release in releases {
            guard let tag = release["tag_name"] as? String, tag.hasPrefix(AppVersion.tagPrefix),
                  release["draft"] as? Bool != true,
                  release["prerelease"] as? Bool != true,
                  let version = AppVersion(tag), version > current,
                  let assets = release["assets"] as? [[String: Any]]
            else { continue }

            // The tarball is the update; the .sha256 beside it is how we know it arrived whole.
            let named = { (suffix: String) -> [String: Any]? in
                assets.first { ($0["name"] as? String)?.hasSuffix(suffix) == true }
            }
            guard let tarball = named(".tar.gz"),
                  let urlString = tarball["browser_download_url"] as? String,
                  let downloadURL = URL(string: urlString)
            else { continue }
            guard let host = downloadURL.host, allowedHosts.contains(host) else {
                throw UpdateError.untrustedHost(downloadURL.host ?? urlString)
            }

            let candidate = AvailableUpdate(
                version: version,
                downloadURL: downloadURL,
                sha256: (named(".sha256")?["browser_download_url"] as? String).flatMap { $0 },
                notes: (release["body"] as? String) ?? "",
                releaseURL: (release["html_url"] as? String).flatMap(URL.init(string:))
            )
            if best == nil || candidate.version > best!.version { best = candidate }
        }
        return best
    }

    /// Download the update, verify it, unpack it, and return the unpacked folder.
    func stage(_ update: AvailableUpdate) async throws -> URL {
        guard let host = update.downloadURL.host, Self.allowedHosts.contains(host) else {
            throw UpdateError.untrustedHost(update.downloadURL.host ?? "unknown")
        }
        let payload = try await fetch(update.downloadURL)

        if let checksumURL = update.sha256.flatMap(URL.init(string:)) {
            let published = String(decoding: try await fetch(checksumURL), as: UTF8.self)
                .split(separator: " ").first.map(String.init)?
                .trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
            let actual = SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined()
            guard !published.isEmpty, published == actual else {
                throw UpdateError.checksumMismatch(expected: published, actual: actual)
            }
        }

        let staging = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("wiki-mirror-update-\(update.version)")
        try? FileManager.default.removeItem(at: staging)
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        let archive = staging.appendingPathComponent("update.tar.gz")
        try payload.write(to: archive)

        let untar = await Shell.run("/usr/bin/tar", ["-xzf", archive.path, "-C", staging.path])
        guard untar.succeeded else { throw UpdateError.badPayload("Could not unpack the update: \(untar.message)") }

        // The tarball holds ONE folder; find the installer inside it rather than guessing its name.
        let contents = (try? FileManager.default.contentsOfDirectory(at: staging, includingPropertiesForKeys: nil)) ?? []
        guard let unpacked = contents.first(where: {
            FileManager.default.fileExists(atPath: $0.appendingPathComponent("install.sh").path)
        }) else {
            throw UpdateError.badPayload("The update has no install.sh in it.")
        }
        return unpacked
    }

    private func fetch(_ url: URL) async throws -> Data {
        var request = URLRequest(url: url)
        request.timeoutInterval = 120
        do {
            let (data, response) = try await session.data(for: request)
            if let http = response as? HTTPURLResponse, !(200 ..< 300).contains(http.statusCode) {
                throw UpdateError.network("HTTP \(http.statusCode) fetching \(url.lastPathComponent)")
            }
            return data
        } catch let error as UpdateError {
            throw error
        } catch {
            throw UpdateError.network(error.localizedDescription)
        }
    }
}
