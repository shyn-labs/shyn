import Testing
import Foundation
@testable import CaptureCore

// Taken from a real capture on 2026-09-03. shyn's own Chrome reader had the
// meeting name in the index one second BEFORE the recording started, and the
// meeting still shipped as "Google Chrome meeting · 3 Sep 2026 at 15:03":
//
//   15:02:42  "Meet"                                    meet.google.com/abc-defg-hij?hs=122&…
//   15:02:57  "Meet"                                    meet.google.com/abc-defg-hij?hs=49
//   15:02:59  "Meet – Q3 Business Metrics + Roadmap v1" meet.google.com/abc-defg-hij
//   15:03:00  session starts
//
// The tab title resolves from the generic lobby name to the real one at join,
// so the LAST usable visit wins, and visits shortly before the session start
// count — the join is what triggers the recording in the first place.
let sessionStart = 1_788_427_980   // 2026-09-03 15:03:00 IST
let sessionEnd = 1_788_433_800     // 2026-09-03 16:33:00 IST

private func visit(_ offset: Int, _ title: String, _ url: String) -> BrowserVisit {
    BrowserVisit(ts: sessionStart + offset, title: title, url: url)
}

@Test func takesTheJoinedMeetTitleOverTheLobbyTitle() {
    let visits = [
        visit(-18, "Meet", "https://meet.google.com/abc-defg-hij?hs=122&ijlm=1788427962403"),
        visit(-3, "Meet", "https://meet.google.com/abc-defg-hij?hs=49"),
        visit(-1, "Meet \u{2013} Q3 Business Metrics + Roadmap v1", "https://meet.google.com/abc-defg-hij"),
    ]
    #expect(conferencingTabTitle(visits: visits, sessionStart: sessionStart, sessionEnd: sessionEnd)
        == "Q3 Business Metrics + Roadmap v1")
}

@Test func laterUsableTitleWinsOverAnEarlierOne() {
    // The lobby case above cannot tell first-wins from last-wins, because
    // "Meet" is dropped by the cleaner either way. This one can: two real
    // titles, and the later must win — a call that gets renamed, or a second
    // call joined in the same session, should carry the name it ended under.
    let visits = [
        visit(-2, "Meet \u{2013} Placeholder Sync", "https://meet.google.com/aaa-bbbb-ccc"),
        visit(1200, "Meet \u{2013} Registry API Integration", "https://meet.google.com/ddd-eeee-fff"),
    ]
    #expect(conferencingTabTitle(visits: visits, sessionStart: sessionStart, sessionEnd: sessionEnd)
        == "Registry API Integration")
}

@Test func unsortedInputStillResolvesByTimestamp() {
    // recent() is called with order:"asc", but nothing in the type enforces
    // it; the function must not depend on the caller's ordering.
    let visits = [
        visit(1200, "Meet \u{2013} Registry API Integration", "https://meet.google.com/ddd-eeee-fff"),
        visit(-2, "Meet \u{2013} Placeholder Sync", "https://meet.google.com/aaa-bbbb-ccc"),
    ]
    #expect(conferencingTabTitle(visits: visits, sessionStart: sessionStart, sessionEnd: sessionEnd)
        == "Registry API Integration")
}

@Test func ignoresNonConferencingTabsOpenDuringTheCall() {
    // Reading mail during a call is ordinary; the record must not be named
    // after the inbox. Same lesson identity learned on 2026-09-01.
    let visits = [
        visit(-1, "Meet \u{2013} Weekly Ops Review", "https://meet.google.com/abc-defg-hij"),
        visit(600, "Inbox (8) - maya@example.com - Mail", "https://mail.google.com/mail/u/0"),
        visit(900, "Some Doc - Google Docs", "https://docs.google.com/document/d/xyz"),
    ]
    #expect(conferencingTabTitle(visits: visits, sessionStart: sessionStart, sessionEnd: sessionEnd)
        == "Weekly Ops Review")
}

@Test func genericConferencingTitlesAreWorthNothing() {
    // A lobby-only capture must fall through to the next rung, not title the
    // meeting "Meet".
    let visits = [
        visit(-10, "Meet", "https://meet.google.com/abc-defg-hij"),
        visit(5, "Zoom Meeting", "https://zoom.us/j/123456"),
    ]
    #expect(conferencingTabTitle(visits: visits, sessionStart: sessionStart, sessionEnd: sessionEnd) == nil)
}

@Test func recognisesZoomTeamsWherebyAndJitsi() {
    for url in ["https://zoom.us/j/98765", "https://teams.microsoft.com/l/meetup-join/x",
                "https://whereby.com/acme-team", "https://meet.jit.si/standup"] {
        let visits = [visit(30, "Quarterly Review", url)]
        #expect(conferencingTabTitle(visits: visits, sessionStart: sessionStart, sessionEnd: sessionEnd)
            == "Quarterly Review", "expected a title for \(url)")
    }
}

@Test func ignoresVisitsOutsideTheSessionWindow() {
    // A call two hours earlier must not name this one. The lead-in grace is
    // deliberately short: it exists for the join that triggered the capture.
    let visits = [
        visit(-7200, "Meet \u{2013} Yesterday's Sync", "https://meet.google.com/old-meet-ing"),
        visit(sessionEnd - sessionStart + 3600, "Meet \u{2013} Later Call", "https://meet.google.com/new-meet-ing"),
    ]
    #expect(conferencingTabTitle(visits: visits, sessionStart: sessionStart, sessionEnd: sessionEnd) == nil)
}

@Test func emptyInputYieldsNothing() {
    #expect(conferencingTabTitle(visits: [], sessionStart: sessionStart, sessionEnd: sessionEnd) == nil)
}
