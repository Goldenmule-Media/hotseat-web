import XCTest

@testable import WikiMirrorMenuBar

/// The config writer edits `~/.wiki/wiki-mirror.config.json`, a file the CLI reads and a person
/// hand-edits. Losing a key here silently breaks somebody's mirror, so every test below is about
/// what survives a round-trip.
final class MirrorConfigTests: XCTestCase {
    private var directory: URL!
    private var path: String!

    override func setUpWithError() throws {
        directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        path = directory.appendingPathComponent("wiki-mirror.config.json").path
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func write(_ json: String) throws {
        try Data(json.utf8).write(to: URL(fileURLWithPath: path))
    }

    private func reread() throws -> [String: Any] {
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testRoundTripKeepsEveryKeyItDoesNotModel() throws {
        try write("""
        {
          "streamBaseUrl": "https://wiki.example.com",
          "namespace": "default",
          "models": ["wiki-models/feature", "wiki-models/toc"],
          "token": "secret-value",
          "healthPort": 4441,
          "nested": { "a": [1, 2], "b": true },
          "emitters": [{ "workspaceId": "ws:a", "root": "/tmp/a" }]
        }
        """)

        var config = try MirrorConfigFile.load(from: path)
        config.emitters.append(EmitterEntry(workspaceId: "ws:b", root: "/tmp/b"))
        try config.save(to: path)

        let written = try reread()
        XCTAssertEqual(written["token"] as? String, "secret-value")
        XCTAssertEqual(written["healthPort"] as? Int, 4441)
        XCTAssertEqual(written["models"] as? [String], ["wiki-models/feature", "wiki-models/toc"])
        XCTAssertEqual((written["nested"] as? [String: Any])?["b"] as? Bool, true)
        let emitters = try XCTUnwrap(written["emitters"] as? [[String: Any]])
        XCTAssertEqual(emitters.map { $0["workspaceId"] as? String }, ["ws:a", "ws:b"])
    }

    func testRoundTripKeepsPerEmitterKeysItDoesNotModel() throws {
        // A key a newer mirror added to an entry (a subtree filter, say) must survive an older
        // app's save, or the next restart mirrors more than that entry asked for.
        try write("""
        {
          "emitters": [
            { "workspaceId": "ws:a", "root": "/tmp/a", "futureKey": "page:x", "opts": { "n": 2 } },
            { "workspaceId": "ws:b", "root": "/tmp/b" }
          ]
        }
        """)

        var config = try MirrorConfigFile.load(from: path)
        config.emitters[0].root = "/tmp/a2"
        try config.save(to: path)

        let emitters = try XCTUnwrap(try reread()["emitters"] as? [[String: Any]])
        XCTAssertEqual(emitters[0]["root"] as? String, "/tmp/a2")
        XCTAssertEqual(emitters[0]["futureKey"] as? String, "page:x")
        XCTAssertEqual((emitters[0]["opts"] as? [String: Any])?["n"] as? Int, 2)
        XCTAssertEqual(Set(emitters[1].keys), ["workspaceId", "root"])
    }

    func testKeepsABackupOfWhatItReplaced() throws {
        try write(#"{"namespace":"before","emitters":[]}"#)
        var config = try MirrorConfigFile.load(from: path)
        config.namespace = "after"
        try config.save(to: path)

        XCTAssertEqual(try reread()["namespace"] as? String, "after")
        let backup = try Data(contentsOf: URL(fileURLWithPath: path + ".bak"))
        let previous = try XCTUnwrap(JSONSerialization.jsonObject(with: backup) as? [String: Any])
        XCTAssertEqual(previous["namespace"] as? String, "before")
    }

    func testSurvivesPathsThatNeedEscaping() throws {
        try write(#"{"emitters":[]}"#)
        var config = try MirrorConfigFile.load(from: path)
        config.emitters = [EmitterEntry(workspaceId: "ws:a", root: #"/tmp/a "quoted"/ünïcode\path"#)]
        try config.save(to: path)

        let emitters = try XCTUnwrap(try reread()["emitters"] as? [[String: Any]])
        XCTAssertEqual(emitters.first?["root"] as? String, #"/tmp/a "quoted"/ünïcode\path"#)
    }

    func testWritesAnEmptyEmitterListAsAnEmptyArray() throws {
        try write(#"{"emitters":[{"workspaceId":"ws:a","root":"/tmp/a"}]}"#)
        var config = try MirrorConfigFile.load(from: path)
        config.emitters = []
        try config.save(to: path)

        XCTAssertEqual((try reread()["emitters"] as? [[String: Any]])?.count, 0)
    }

    func testAMissingFileIsNotAnError() throws {
        let config = try MirrorConfigFile.load(from: directory.appendingPathComponent("nope.json").path)
        XCTAssertTrue(config.emitters.isEmpty)
        XCTAssertEqual(config.namespace, "default")
    }

    func testRefusesToReadAMalformedEmittersKey() throws {
        // Reading it as "no emitters" and then saving would erase every mirror on this machine.
        try write(#"{"emitters":"not-a-list"}"#)
        XCTAssertThrowsError(try MirrorConfigFile.load(from: path))
    }

    func testRefusesToSaveAConfigTheMirrorWouldReject() throws {
        try write(#"{"emitters":[]}"#)
        var config = try MirrorConfigFile.load(from: path)

        config.emitters = [EmitterEntry(workspaceId: "ws:a", root: "relative/path")]
        XCTAssertThrowsError(try config.save(to: path))

        // One root, two workspaces: they would clobber each other's manifest.
        config.emitters = [
            EmitterEntry(workspaceId: "ws:a", root: "/tmp/same"),
            EmitterEntry(workspaceId: "ws:b", root: "/tmp/same"),
        ]
        XCTAssertThrowsError(try config.save(to: path))
    }

    func testRoundTripsASubtreeRootAndOmitsItWhenUnset() throws {
        try write(#"{"emitters":[{"workspaceId":"ws:a","root":"/tmp/a","subtreeRootId":"toc:war"}]}"#)
        var config = try MirrorConfigFile.load(from: path)
        XCTAssertEqual(config.emitters.first?.subtreeRootId, "toc:war")

        config.emitters.append(EmitterEntry(workspaceId: "ws:a", root: "/tmp/b"))
        config.emitters.append(EmitterEntry(workspaceId: "ws:c", root: "/tmp/c", subtreeRootId: "  "))
        try config.save(to: path)

        let emitters = try XCTUnwrap(try reread()["emitters"] as? [[String: Any]])
        XCTAssertEqual(emitters[0]["subtreeRootId"] as? String, "toc:war")
        // Absent, not null or blank: an older mirror treats any present value as a filter.
        XCTAssertNil(emitters[1]["subtreeRootId"])
        XCTAssertNil(emitters[2]["subtreeRootId"])
    }

    func testOneWorkspaceOrPageMayBeMirroredIntoSeveralFolders() {
        var config = MirrorConfigFile()
        config.emitters = [
            EmitterEntry(workspaceId: "ws:a", root: "/tmp/whole"),
            EmitterEntry(workspaceId: "ws:a", root: "/tmp/war", subtreeRootId: "toc:war"),
            EmitterEntry(workspaceId: "ws:a", root: "/tmp/war2", subtreeRootId: "toc:war"),
            EmitterEntry(workspaceId: "ws:a", root: "/tmp/whole2"),
        ]
        XCTAssertEqual(config.validate(), [])

        config.emitters.append(EmitterEntry(workspaceId: "ws:a", root: "/tmp/war", subtreeRootId: "toc:war"))
        XCTAssertEqual(config.validate(), ["Two mirrors both write to /tmp/war — give each its own folder."])
    }

    func testRejectsNestedRootsButNotSiblingsWithACommonPrefix() {
        var config = MirrorConfigFile()
        config.emitters = [
            EmitterEntry(workspaceId: "ws:a", root: "/repo/wiki-mirror"),
            EmitterEntry(workspaceId: "ws:b", root: "/repo/wiki-mirror-2"),
        ]
        XCTAssertEqual(config.validate(), [])

        config.emitters.append(EmitterEntry(workspaceId: "ws:c", root: "/repo/wiki-mirror/inner/"))
        XCTAssertEqual(config.validate().count, 1)
        XCTAssertTrue(config.validate()[0].contains("can't nest"))
    }

    func testValidatesTheServerUrlAndNamespace() throws {
        var config = MirrorConfigFile()
        config.streamBaseUrl = "not-a-url"
        XCTAssertFalse(config.validate().isEmpty)

        config.streamBaseUrl = "https://wiki.example.com"
        config.namespace = "  "
        XCTAssertFalse(config.validate().isEmpty)
    }
}
