import Foundation

/// A dotted release version, comparable the way a person expects (0.10.0 is newer than 0.9.0,
/// which string comparison gets backwards).
struct AppVersion: Comparable, CustomStringConvertible, Equatable {
    let components: [Int]

    /// Parse "1.2.3", "v1.2.3", or the release tag "wiki-mirror-v1.2.3". Nil if there is no
    /// number in it at all.
    init?(_ raw: String) {
        let trimmed = raw
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: AppVersion.tagPrefix, with: "")
            .drop { $0 == "v" || $0 == "V" }
        var parsed: [Int] = []
        for part in trimmed.split(separator: ".") {
            let digits = part.prefix { $0.isNumber }
            guard let number = Int(digits) else { break }
            parsed.append(number)
            // A segment that is not PURELY numeric ends the version. Without this, "1.2.3-beta.1"
            // reads as 1.2.3.1 — which orders ABOVE the final 1.2.3, so a pre-release would
            // present itself as the newer release.
            if digits.count != part.count { break }
        }
        guard !parsed.isEmpty else { return nil }
        components = parsed
    }

    /// The release tag prefix, so one repo can hold releases for more than one thing.
    static let tagPrefix = "wiki-mirror-v"

    /// This bundle's version, from `CFBundleShortVersionString`.
    static var current: AppVersion? {
        guard let raw = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String else { return nil }
        return AppVersion(raw)
    }

    var description: String { components.map(String.init).joined(separator: ".") }

    static func < (lhs: AppVersion, rhs: AppVersion) -> Bool {
        // Compare position by position, treating a missing segment as 0 so 1.2 == 1.2.0.
        for index in 0 ..< max(lhs.components.count, rhs.components.count) {
            let left = index < lhs.components.count ? lhs.components[index] : 0
            let right = index < rhs.components.count ? rhs.components[index] : 0
            if left != right { return left < right }
        }
        return false
    }
}
