import XCTest

@testable import WikiMirrorMenuBar

/// What the app infers from the installed plist. Getting `login` wrong is not a cosmetic bug: the
/// mirror only takes the login path when it is `argv[0]`, so a misplaced "login" silently starts a
/// SECOND mirror and reports success while the grant stays expired.
final class LaunchAgentTests: XCTestCase {
    private func info(_ arguments: [String], workingDirectory: String? = nil) -> LaunchAgentInfo {
        LaunchAgentInfo(programArguments: arguments, workingDirectory: workingDirectory)
    }

    func testLoginGoesRightAfterTheScriptInSourceMode() {
        let agent = info(["/opt/homebrew/bin/node", "--import", "tsx", "/repo/wiki-mirror/src/bin.ts"])
        XCTAssertEqual(agent.mode, "source")
        XCTAssertEqual(
            agent.loginCommand,
            ["/opt/homebrew/bin/node", "--import", "tsx", "/repo/wiki-mirror/src/bin.ts", "login"]
        )
    }

    func testLoginGoesBEFORETheFlagsInPortableMode() {
        let agent = info(["/usr/local/bin/node", "/art/wiki-mirror.mjs", "--models=", "--models-dir", "/art/models"])
        XCTAssertEqual(agent.mode, "portable")
        XCTAssertEqual(
            agent.loginCommand,
            ["/usr/local/bin/node", "/art/wiki-mirror.mjs", "login", "--models=", "--models-dir", "/art/models"]
        )
    }

    func testLoginKeepsAConfigFlagAfterTheSubcommand() {
        let agent = info(["/bin/node", "/repo/wiki-mirror/dist/bin.js", "--config", "/somewhere/mirror.json"])
        XCTAssertEqual(agent.mode, "dist")
        XCTAssertEqual(
            agent.loginCommand,
            ["/bin/node", "/repo/wiki-mirror/dist/bin.js", "login", "--config", "/somewhere/mirror.json"]
        )
    }

    func testAnUnrecognizableJobHasNoLoginCommand() {
        // Better to say so than to append "login" somewhere it will be read as a flag.
        XCTAssertNil(info(["/usr/bin/env", "wiki-mirror"]).loginCommand)
        XCTAssertEqual(info(["/usr/bin/env", "wiki-mirror"]).mode, "custom")
    }

    func testInstallerDirectoryPointsAtTheFolderHoldingInstallAgent() {
        let portable = info(["/bin/node", "/art/wiki-mirror.mjs", "--models-dir", "/art/models"])
        XCTAssertEqual(portable.installerDirectory, "/art")

        let source = info(["/bin/node", "--import", "tsx", "/repo/wiki-mirror/src/bin.ts"],
                          workingDirectory: "/repo/wiki-mirror")
        XCTAssertEqual(source.installerDirectory, "/repo/wiki-mirror/scripts")
    }
}
