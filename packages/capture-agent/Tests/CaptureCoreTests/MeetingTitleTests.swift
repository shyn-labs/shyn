import Testing
import Foundation
@testable import CaptureCore

// The ladder itself, which is where the 2026-09-06 bug actually lived.
//
// Every individual rung was tested and every rung worked. What nobody tested
// was the COMPOSITION — and the composition was a single `??` chain inlined in
// runTranscription, inside shyn-meeting, which had no test target at all. Two
// rungs returned nil at once for a week and the only symptom was seven
// meetings called "Google Chrome meeting".
//
// So the chain lives here now, and .none is a first-class outcome a caller can
// see and report rather than a silent fall-through to a dated app name.

@Test func manualBeatsEverything() {
    let c = chooseMeetingTitle(manual: "Board prep", tab: "Weekly Ops Review",
                               eventKit: "Q3 Planning", window: "Meet")
    #expect(c == MeetingTitleChoice(title: "Board prep", rung: .manual))
}

@Test func tabBeatsCalendarAndWindow() {
    // Decided 2026-09-06: a tab that was open is evidence of what happened; a
    // calendar entry records what was planned, and the two diverge constantly.
    let c = chooseMeetingTitle(manual: nil, tab: "Weekly Ops Review",
                               eventKit: "Occupied", window: "Chrome")
    #expect(c == MeetingTitleChoice(title: "Weekly Ops Review", rung: .tab))
}

@Test func calendarBeatsWindow() {
    let c = chooseMeetingTitle(manual: nil, tab: nil,
                               eventKit: "Q3 Planning", window: "Some Window")
    #expect(c == MeetingTitleChoice(title: "Q3 Planning", rung: .eventkit))
}

@Test func windowIsTheLastNamedRung() {
    let c = chooseMeetingTitle(manual: nil, tab: nil, eventKit: nil, window: "Design Review")
    #expect(c == MeetingTitleChoice(title: "Design Review", rung: .window))
}

// THE regression test. This exact state — every rung nil — shipped for a week
// and was invisible, because the caller just took the nil and formatted a
// dated fallback without anyone noticing the ladder had bottomed out.
@Test func allRungsEmptyIsAReportableOutcomeNotSilence() {
    let c = chooseMeetingTitle(manual: nil, tab: nil, eventKit: nil, window: nil)
    #expect(c.title == nil)
    #expect(c.rung == .none)
}

@Test func blankAndWhitespaceCountAsAbsent() {
    // Upstream cleaners already reject these, but the ladder must not depend
    // on that: an empty string reaching a document title is worse than the
    // dated fallback, and "which rung won" would be a lie.
    let c = chooseMeetingTitle(manual: "   ", tab: "", eventKit: "\n\t",
                               window: "Real Title")
    #expect(c == MeetingTitleChoice(title: "Real Title", rung: .window))

    let empty = chooseMeetingTitle(manual: "", tab: "  ", eventKit: nil, window: nil)
    #expect(empty.title == nil)
    #expect(empty.rung == .none)
}

@Test func titlesAreTrimmedSoTheRungAndTheTextAgree() {
    let c = chooseMeetingTitle(manual: nil, tab: "  Weekly Ops Review  ",
                               eventKit: nil, window: nil)
    #expect(c == MeetingTitleChoice(title: "Weekly Ops Review", rung: .tab))
}

@Test func everyRungIsReachableFromTheBottomUp() {
    // Walks the ladder one rung at a time: each addition must take over, which
    // pins the ORDER rather than just each pair. A reordering that still
    // passed the pairwise tests would fail here.
    var c = chooseMeetingTitle(manual: nil, tab: nil, eventKit: nil, window: nil)
    #expect(c.rung == .none)
    c = chooseMeetingTitle(manual: nil, tab: nil, eventKit: nil, window: "w")
    #expect(c.rung == .window)
    c = chooseMeetingTitle(manual: nil, tab: nil, eventKit: "e", window: "w")
    #expect(c.rung == .eventkit)
    c = chooseMeetingTitle(manual: nil, tab: "t", eventKit: "e", window: "w")
    #expect(c.rung == .tab)
    c = chooseMeetingTitle(manual: "m", tab: "t", eventKit: "e", window: "w")
    #expect(c.rung == .manual)
}
