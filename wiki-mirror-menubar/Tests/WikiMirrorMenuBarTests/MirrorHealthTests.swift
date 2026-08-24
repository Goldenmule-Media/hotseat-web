import AppKit
import XCTest

@testable import WikiMirrorMenuBar

/// The menu-bar glyph is the whole UI most of the time, so a typo'd symbol name is a blank icon
/// with no other symptom.
final class MirrorHealthTests: XCTestCase {
    func testEveryStateHasASymbolThatActuallyResolves() throws {
        // A headless CI runner may not be able to resolve ANY symbol; that is an environment
        // limitation, not a bug in the icon set, and failing on it would just teach us to ignore
        // this test. Prove the lookup works at all before trusting its answers.
        try XCTSkipIf(
            NSImage(systemSymbolName: "gearshape", accessibilityDescription: nil) == nil,
            "this environment cannot resolve SF Symbols"
        )
        for health in MirrorHealth.all {
            XCTAssertNotNil(
                NSImage(systemSymbolName: health.symbol, accessibilityDescription: nil),
                "\(health.symbol) is not an SF Symbol on this system"
            )
        }
    }

    func testStatesAreToldApartByShape() {
        // The menu bar renders monochrome, so two states sharing a glyph are indistinguishable.
        let symbols = MirrorHealth.all.map(\.symbol)
        XCTAssertEqual(Set(symbols).count, symbols.count)
    }

    func testOnlyTheHealthyStateIsFilled() {
        // "Filled = good" is the whole read at a glance; an outline anywhere else keeps it true.
        for health in MirrorHealth.all {
            let filled = health.symbol.hasSuffix(".fill")
            XCTAssertEqual(filled, health.symbol == MirrorHealth.healthy.symbol, "\(health.symbol)")
        }
    }

    func testEveryStateSaysSomething() {
        for health in MirrorHealth.all {
            XCTAssertFalse(health.summary.isEmpty)
        }
    }
}
