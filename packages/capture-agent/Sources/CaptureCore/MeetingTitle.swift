import Foundation

// What a recording gets called, and which source decided it.
//
// This chain used to be one inlined `??` expression inside runTranscription,
// in shyn-meeting, which has no test target. On 2026-09-06 two of its four
// rungs returned nil at the same time — the local EventKit copy had gone stale
// and Accessibility was denied, so the window rung had never once fired — and
// seven consecutive meetings shipped as "Google Chrome meeting · <date>".
// Every rung was individually correct and individually tested. Nothing tested
// them together, and nothing could: the composition lived where tests cannot
// reach.
//
// Two things changed as a result. The chain is here, where it is testable. And
// bottoming out is now `.none`, a value a caller can log and report, rather
// than a nil that quietly becomes a dated app name — the difference between a
// degraded state you can see and one you cannot.

public enum TitleRung: String, Sendable {
    case manual     // the user typed it: `shyn meeting start "…"`
    case tab        // a conferencing tab open during the session
    case eventkit   // a calendar event overlapping the session
    case window     // the meeting app's window title at pre-roll
    case none       // nothing named it; the caller formats a dated fallback
}

public struct MeetingTitleChoice: Equatable, Sendable {
    public let title: String?
    public let rung: TitleRung
    public init(title: String?, rung: TitleRung) {
        self.title = title; self.rung = rung
    }
}

/// Picks the meeting title by precedence, strongest evidence first.
///
/// Order, and why (decided 2026-09-06): a name the user typed beats anything
/// inferred, because nothing guessed can beat being told. A conferencing tab
/// that was open beats the calendar, because a tab is evidence of what
/// HAPPENED where a calendar entry records what was PLANNED — and a stale
/// local copy, a same-day reschedule, or a long "busy" hold that merely
/// overlaps would otherwise win over the real name. The window title is last
/// because focus is the least reliable signal of all.
///
/// Blank and whitespace-only inputs count as absent at every rung. Upstream
/// cleaners already reject them, but a title is a thing a human reads and an
/// empty one is worse than the dated fallback — and it would make the reported
/// rung a lie about what actually named the recording.
public func chooseMeetingTitle(manual: String?, tab: String?,
                               eventKit: String?, window: String?) -> MeetingTitleChoice {
    for (candidate, rung) in [(manual, TitleRung.manual), (tab, .tab),
                              (eventKit, .eventkit), (window, .window)] {
        guard let t = candidate?.trimmingCharacters(in: .whitespacesAndNewlines),
              !t.isEmpty else { continue }
        return MeetingTitleChoice(title: t, rung: rung)
    }
    return MeetingTitleChoice(title: nil, rung: .none)
}
