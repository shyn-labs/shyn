import Testing
import Foundation
@testable import CaptureCore

// The control file is the CLI's and the menu bar's only channel into a running
// agent, so its parser has to be forgiving about what it does not understand
// and strict about what it does. Moved into CaptureCore on 2026-09-07 when
// `start` was added: it had lived in shyn-meeting, which has no test target,
// so the stop/cancel parsing had never been tested at all.

@Test func parsesStopAndCancel() {
    #expect(parseMeetingControl(Data(#"{"action":"stop","ts":1}"#.utf8))
        == MeetingControl(action: .stop, title: nil))
    #expect(parseMeetingControl(Data(#"{"action":"cancel","ts":1}"#.utf8))
        == MeetingControl(action: .cancel, title: nil))
}

@Test func parsesStartWithAndWithoutTitle() {
    #expect(parseMeetingControl(Data(#"{"action":"start","ts":1}"#.utf8))
        == MeetingControl(action: .start, title: nil))
    #expect(parseMeetingControl(Data(#"{"action":"start","title":"Standup","ts":1}"#.utf8))
        == MeetingControl(action: .start, title: "Standup"))
}

@Test func titleIsTrimmedAndBlankBecomesNil() {
    // `shyn meeting start ""` and a stray space must not produce a document
    // titled with whitespace — that is worse than the dated fallback.
    #expect(parseMeetingControl(Data(#"{"action":"start","title":"  Weekly Ops  "}"#.utf8))
        == MeetingControl(action: .start, title: "Weekly Ops"))
    #expect(parseMeetingControl(Data(#"{"action":"start","title":"   "}"#.utf8))
        == MeetingControl(action: .start, title: nil))
    #expect(parseMeetingControl(Data(#"{"action":"start","title":""}"#.utf8))
        == MeetingControl(action: .start, title: nil))
}

@Test func absurdlyLongTitleIsTruncatedNotRejected() {
    // Same 120-char ceiling the window-title cleaner uses: a doc title is not
    // a place for a paragraph, but a long title is still better than none.
    let long = String(repeating: "x", count: 400)
    let got = parseMeetingControl(Data(#"{"action":"start","title":"\#(long)"}"#.utf8))
    #expect(got?.title?.count == 120)
    #expect(got?.action == .start)
}

@Test func rejectsUnknownGarbageAndMissingAction() {
    // An unknown action must be dropped, not crash and not fall through to
    // some default — a future CLI writing a verb this agent predates is the
    // realistic case, and the agent still deletes the file either way.
    #expect(parseMeetingControl(Data(#"{"action":"selfdestruct"}"#.utf8)) == nil)
    #expect(parseMeetingControl(Data(#"{"ts":1}"#.utf8)) == nil)
    #expect(parseMeetingControl(Data("not json at all".utf8)) == nil)
    #expect(parseMeetingControl(Data("".utf8)) == nil)
    #expect(parseMeetingControl(Data("[]".utf8)) == nil)
}

@Test func titleOnStopIsIgnoredRatherThanCarried() {
    // Only `start` names a recording. A title on stop is meaningless; carrying
    // it would invite a caller to think it renames the session.
    #expect(parseMeetingControl(Data(#"{"action":"stop","title":"nope"}"#.utf8))
        == MeetingControl(action: .stop, title: nil))
}
