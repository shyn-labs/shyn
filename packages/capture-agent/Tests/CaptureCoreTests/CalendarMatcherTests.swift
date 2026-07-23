import Testing
@testable import CaptureCore

// Matcher for stamping meeting entries with the calendar event they belong
// to (spec 2026-07-23-eventkit-meeting-stamping). Pure: candidates come from
// EventKit at the call site; the matcher returns the index of the winner.

private func cand(_ start: Int, _ end: Int, attendees: Int = 2, allDay: Bool = false,
                  title: String = "event") -> CalendarCandidate {
    CalendarCandidate(title: title, start: start, end: end,
                      attendeeCount: attendees, isAllDay: allDay)
}

// Session: 10:00–11:00 (epoch 36000–39600)
private let S = 36_000, E = 39_600

@Test func singleOverlappingEventMatches() {
    let i = matchMeetingEvent(sessionStart: S, sessionEnd: E,
                              candidates: [cand(35_700, 39_300)])   // 9:55–10:55
    #expect(i == 0)
}

@Test func noCandidatesOrThinOverlapReturnsNil() {
    #expect(matchMeetingEvent(sessionStart: S, sessionEnd: E, candidates: []) == nil)
    // 10:45–12:00 overlaps only 15 min of a 60-min session (< 0.5)
    #expect(matchMeetingEvent(sessionStart: S, sessionEnd: E,
                              candidates: [cand(38_700, 43_200)]) == nil)
}

@Test func allDayEventsAreSkippedEvenWhenOverlapping() {
    let i = matchMeetingEvent(sessionStart: S, sessionEnd: E,
                              candidates: [cand(0, 86_400, allDay: true)])
    #expect(i == nil)
}

@Test func backToBackTieBreaksToLaterStart() {
    // A 9:30–10:30 and B 10:30–11:30 both overlap exactly 30 min (= 0.5)
    let i = matchMeetingEvent(sessionStart: S, sessionEnd: E,
                              candidates: [cand(34_200, 37_800, title: "A"),
                                           cand(37_800, 41_400, title: "B")])
    #expect(i == 1)
}

@Test func eventWithAttendeesBeatsSoloEventWithLargerOverlap() {
    // solo focus block covers the whole session; the 3-person standup covers
    // 45 min — the standup is the meeting.
    let i = matchMeetingEvent(sessionStart: S, sessionEnd: E,
                              candidates: [cand(S, E, attendees: 0, title: "focus"),
                                           cand(S, S + 2_700, attendees: 3, title: "standup")])
    #expect(i == 1)
}

@Test func largerOverlapWinsAmongAttendedEvents() {
    let i = matchMeetingEvent(sessionStart: S, sessionEnd: E,
                              candidates: [cand(S, S + 2_100, attendees: 2),     // 35 min
                                           cand(S + 600, E, attendees: 2)])      // 50 min
    #expect(i == 1)
}

@Test func zeroLengthSessionIsSafe() {
    #expect(matchMeetingEvent(sessionStart: S, sessionEnd: S,
                              candidates: [cand(S - 600, S + 600)]) == nil)
}
