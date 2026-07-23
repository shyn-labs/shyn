import Foundation

// Which calendar event does a captured meeting belong to?
// (spec 2026-07-23-eventkit-meeting-stamping). Pure so it's testable: the
// caller queries EventKit for events overlapping the session window and
// maps the winning index back to the full event for title/attendees.

public struct CalendarCandidate: Sendable {
    public let title: String
    public let start: Int          // epoch seconds
    public let end: Int
    public let attendeeCount: Int
    public let isAllDay: Bool
    public init(title: String, start: Int, end: Int, attendeeCount: Int, isAllDay: Bool) {
        self.title = title; self.start = start; self.end = end
        self.attendeeCount = attendeeCount; self.isAllDay = isAllDay
    }
}

// Requires the event to cover >= half the session; a call that isn't on the
// calendar must stay unstamped. Tie-breaks, in order: real meetings (2+
// attendees) beat solo blocks, larger overlap, later start (back-to-back
// case: the meeting you're in is the one that just started).
public func matchMeetingEvent(sessionStart: Int, sessionEnd: Int,
                              candidates: [CalendarCandidate]) -> Int? {
    let duration = sessionEnd - sessionStart
    guard duration > 0 else { return nil }
    var best: (score: (Int, Int, Int), index: Int)? = nil
    for (i, c) in candidates.enumerated() where !c.isAllDay {
        let overlap = min(c.end, sessionEnd) - max(c.start, sessionStart)
        guard overlap * 2 >= duration else { continue }   // ratio >= 0.5, integer-exact
        let score = (c.attendeeCount >= 2 ? 1 : 0, overlap, c.start)
        if best == nil || score > best!.score { best = (score, i) }
    }
    return best?.index
}
