import XCTest

@testable import WikiMirrorMenuBar

final class AppVersionTests: XCTestCase {
    func testParsesPlainTaggedAndPrefixedForms() {
        XCTAssertEqual(AppVersion("1.2.3")?.description, "1.2.3")
        XCTAssertEqual(AppVersion("v1.2.3")?.description, "1.2.3")
        XCTAssertEqual(AppVersion("wiki-mirror-v1.2.3")?.description, "1.2.3")
        XCTAssertEqual(AppVersion("  0.1.0\n")?.description, "0.1.0")
    }

    func testOrdersNumerically() {
        // The whole point: string comparison puts 0.10.0 BEFORE 0.9.0.
        XCTAssertTrue(AppVersion("0.9.0")! < AppVersion("0.10.0")!)
        XCTAssertTrue(AppVersion("1.0.0")! > AppVersion("0.99.99")!)
        XCTAssertTrue(AppVersion("0.1.1")! > AppVersion("0.1.0")!)
    }

    func testTreatsAMissingSegmentAsZero() {
        XCTAssertFalse(AppVersion("1.2")! < AppVersion("1.2.0")!)
        XCTAssertFalse(AppVersion("1.2.0")! < AppVersion("1.2")!)
        XCTAssertTrue(AppVersion("1.2")! < AppVersion("1.2.1")!)
    }

    func testAPreReleaseSuffixDoesNotMakeAVersionLookNEWER() {
        // "1.2.3-beta.1" read naively becomes 1.2.3.1, which sorts ABOVE the final 1.2.3.
        XCTAssertEqual(AppVersion("1.2.3-beta.1")?.description, "1.2.3")
        XCTAssertFalse(AppVersion("1.2.3-beta.1")! > AppVersion("1.2.3")!)
        XCTAssertTrue(AppVersion("1.2.4")! > AppVersion("1.2.3-beta.1")!)
    }

    func testRejectsSomethingWithNoNumberInIt() {
        XCTAssertNil(AppVersion("wiki-mirror-vlatest"))
        XCTAssertNil(AppVersion(""))
    }
}

/// The release picker runs against fixtures rather than the network: every branch here is a way
/// the app could offer the wrong download, or miss a real one.
final class UpdateCheckerTests: XCTestCase {
    private let current = AppVersion("0.1.0")!

    private func releases(_ items: [[String: Any]]) -> Data {
        try! JSONSerialization.data(withJSONObject: items)
    }

    private func release(
        tag: String,
        assets: [String] = ["wiki-mirror-0.2.0-macos.tar.gz", "wiki-mirror-0.2.0-macos.tar.gz.sha256"],
        draft: Bool = false,
        prerelease: Bool = false,
        host: String = "github.com"
    ) -> [String: Any] {
        [
            "tag_name": tag,
            "draft": draft,
            "prerelease": prerelease,
            "body": "notes for \(tag)",
            "html_url": "https://github.com/o/r/releases/tag/\(tag)",
            "assets": assets.map { ["name": $0, "browser_download_url": "https://\(host)/o/r/releases/download/\(tag)/\($0)"] },
        ]
    }

    func testFindsANewerRelease() throws {
        let found = try UpdateChecker.newestUpdate(in: releases([release(tag: "wiki-mirror-v0.2.0")]), current: current)
        XCTAssertEqual(found?.version, AppVersion("0.2.0"))
        XCTAssertEqual(found?.downloadURL.lastPathComponent, "wiki-mirror-0.2.0-macos.tar.gz")
        XCTAssertEqual(found?.sha256?.hasSuffix(".sha256"), true)
        XCTAssertEqual(found?.notes, "notes for wiki-mirror-v0.2.0")
    }

    func testIgnoresTheCurrentVersionAndOlderOnes() throws {
        let data = releases([release(tag: "wiki-mirror-v0.1.0"), release(tag: "wiki-mirror-v0.0.9")])
        XCTAssertNil(try UpdateChecker.newestUpdate(in: data, current: current))
    }

    func testIgnoresReleasesForSomethingElseInTheSameRepo() throws {
        // A repo holding more than one product is exactly why this filters by tag prefix instead
        // of asking GitHub for "the latest release".
        let data = releases([release(tag: "wiki-server-v9.9.9")])
        XCTAssertNil(try UpdateChecker.newestUpdate(in: data, current: current))
    }

    func testIgnoresDraftsAndPreReleases() throws {
        let data = releases([
            release(tag: "wiki-mirror-v0.3.0", draft: true),
            release(tag: "wiki-mirror-v0.4.0", prerelease: true),
        ])
        XCTAssertNil(try UpdateChecker.newestUpdate(in: data, current: current))
    }

    func testPicksTheNewestWhenSeveralAreAvailable() throws {
        let data = releases([
            release(tag: "wiki-mirror-v0.2.0"),
            release(tag: "wiki-mirror-v0.10.0"),
            release(tag: "wiki-mirror-v0.9.0"),
        ])
        XCTAssertEqual(try UpdateChecker.newestUpdate(in: data, current: current)?.version, AppVersion("0.10.0"))
    }

    func testSkipsAReleaseWithNoTarball() throws {
        let data = releases([release(tag: "wiki-mirror-v0.2.0", assets: ["notes.txt"])])
        XCTAssertNil(try UpdateChecker.newestUpdate(in: data, current: current))
    }

    func testToleratesAReleaseWithNoChecksum() throws {
        let data = releases([release(tag: "wiki-mirror-v0.2.0", assets: ["wiki-mirror-0.2.0-macos.tar.gz"])])
        XCTAssertNil(try UpdateChecker.newestUpdate(in: data, current: current)?.sha256)
    }

    func testRefusesADownloadPointedAtAnotherHost() {
        // A release can name any URL it likes; this app will only fetch from GitHub's own hosts.
        let data = releases([release(tag: "wiki-mirror-v0.2.0", host: "evil.example.com")])
        XCTAssertThrowsError(try UpdateChecker.newestUpdate(in: data, current: current)) { error in
            guard case UpdateError.untrustedHost = error else { return XCTFail("expected untrustedHost, got \(error)") }
        }
    }

    func testRejectsAPayloadThatIsNotAReleaseList() {
        let data = Data(#"{"message":"Not Found"}"#.utf8)
        XCTAssertThrowsError(try UpdateChecker.newestUpdate(in: data, current: current))
    }

    func testEveryAllowedHostIsAGitHubOne() {
        for host in UpdateChecker.allowedHosts {
            XCTAssertTrue(host.hasSuffix("github.com") || host.hasSuffix("githubusercontent.com"), host)
        }
    }
}
