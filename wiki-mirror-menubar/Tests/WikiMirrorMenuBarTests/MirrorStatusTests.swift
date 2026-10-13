import XCTest

@testable import WikiMirrorMenuBar

/// The status payload comes from a separately installed mirror that may be older or newer than
/// this app, so both shapes must decode — a decode failure reads as "no mirror running".
final class MirrorStatusTests: XCTestCase {
    private func decode(_ workspaces: String) throws -> MirrorStatus {
        let json = """
        {"status":"ok","uptimeMs":1,"namespace":"default","streamBaseUrl":"https://x","workspaces":\(workspaces)}
        """
        return try JSONDecoder().decode(MirrorStatus.self, from: Data(json.utf8))
    }

    func testDecodesAnOlderMirrorWithoutSubtreeFields() throws {
        let status = try decode(#"[{"workspaceId":"ws:a","name":"Alpha","root":"/r/a","appliedVersion":3,"connected":true}]"#)
        let workspace = try XCTUnwrap(status.workspaces.first)
        XCTAssertNil(workspace.subtreeRootId)
        XCTAssertEqual(workspace.displayName, "Alpha")
    }

    func testNamesASubtreeEntryByWorkspaceAndPage() throws {
        let status = try decode("""
        [{"workspaceId":"ws:a","name":"Sovereign Axe","root":"/r/war","appliedVersion":3,"connected":true,
          "subtreeRootId":"toc:war","subtreeTitle":"War"},
         {"workspaceId":"ws:a","root":"/r/bg","appliedVersion":3,"connected":true,"subtreeRootId":"toc:bg"}]
        """)
        XCTAssertEqual(status.workspaces.map(\.displayName), ["Sovereign Axe › War", "ws:a › toc:bg"])
    }

    func testEntriesOfOneWorkspaceHaveDistinctIds() throws {
        // `ForEach` keys rows by id; keyed by workspace, two subtree mirrors would collide.
        let status = try decode("""
        [{"workspaceId":"ws:a","root":"/r/one","appliedVersion":0,"connected":true,"subtreeRootId":"toc:1"},
         {"workspaceId":"ws:a","root":"/r/two","appliedVersion":0,"connected":true,"subtreeRootId":"toc:2"}]
        """)
        XCTAssertEqual(Set(status.workspaces.map(\.id)), ["/r/one", "/r/two"])
    }

    func testDecodesThePageTree() throws {
        let json = #"{"pages":[{"id":"toc:a","title":"Core Tech","type":"toc","depth":0,"archived":false}]}"#
        struct Response: Decodable { let pages: [PageTreeNode] }
        let pages = try JSONDecoder().decode(Response.self, from: Data(json.utf8)).pages
        XCTAssertEqual(pages.first?.title, "Core Tech")
        XCTAssertEqual(pages.first?.depth, 0)
    }
}
