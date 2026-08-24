import AppKit
import XCTest

@testable import WikiMirrorMenuBar

/// The menu-bar glyph is the whole UI most of the time, so a typo'd symbol name is a blank icon
/// with no other symptom.
final class MirrorHealthTests: XCTestCase {
    func testEveryStateHasASymbolThatActuallyResolves() {
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
