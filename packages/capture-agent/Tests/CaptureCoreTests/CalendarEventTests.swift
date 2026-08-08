import Testing
import Foundation
@testable import CaptureCore

private let IST = TimeZone(secondsFromGMT: 5 * 3600 + 1800)!
private let START = 1_785_997_956          // 2026-08-06 12:02:36 IST

private func ev(_ over: (inout CalendarEventInput) -> Void = { _ in }) -> CalendarEventInput {
    var e = CalendarEventInput(
        identifier: "ABC-123", title: "ARR Standup",
        start: START, end: START + 1800,
        attendees: ["Sam", "Alex"])
    over(&e)
    return e
}

@Test func recurringOccurrencesGetDistinctUris() {
    // One identifier is shared by every occurrence of a recurring event. Without
    // the occurrence start in the uri the whole series collapses into a single
    // document that overwrites itself every week.
    let week1 = ev()
    let week2 = ev { $0 = CalendarEventInput(identifier: "ABC-123", title: "ARR Standup",
                                             start: START + 7 * 86400, end: START + 7 * 86400 + 1800) }
    #expect(calendarEventUri(week1) != calendarEventUri(week2))
    #expect(calendarEventUri(week1) == "calendar://ABC-123/\(START)")
}

@Test func bodyCarriesWhatSomeoneWouldActuallySearchFor() {
    let e = ev {
        $0 = CalendarEventInput(identifier: "X", title: "Quarterly review",
                                start: START, end: START + 3600,
                                location: "WeWork Salarpuria", notes: "Agenda: pricing, retention",
                                organizer: "Sam", attendees: ["Alex", "Jordan"])
    }
    let text = calendarEventText(e, timeZone: IST)
    #expect(text.contains("Calendar event: Quarterly review"))
    #expect(text.contains("(60 min)"))
    #expect(text.contains("Where: WeWork Salarpuria"))
    #expect(text.contains("Organizer: Sam"))
    #expect(text.contains("Attendees: Alex, Jordan"))
    #expect(text.contains("Agenda: pricing, retention"))
}

@Test func allDayEventsSaySoInsteadOfClaimingAZeroLengthTime() {
    let e = ev { $0 = CalendarEventInput(identifier: "Y", title: "Offsite",
                                         start: START, end: START + 86400, isAllDay: true) }
    let text = calendarEventText(e, timeZone: IST)
    #expect(text.contains("(all day)"))
    #expect(!text.contains("min)"))
}

@Test func declinedAndUntitledEventsAreNotStored() {
    // A declined event is a record of something that did not happen; an untitled
    // one carries nothing recallable.
    #expect(calendarEventPayload(ev { $0 = CalendarEventInput(
        identifier: "Z", title: "Optional sync", start: START, end: START + 60, declined: true) }) == nil)
    #expect(calendarEventPayload(ev { $0 = CalendarEventInput(
        identifier: "Z", title: "   ", start: START, end: START + 60) }) == nil)
}

@Test func payloadTimestampIsTheEventStartNotSyncTime() {
    // ts drives the time-window enumeration recall uses to replay a day, so an
    // event must land in the window it happened in, not when it was synced.
    let p = calendarEventPayload(ev())!
    #expect(p.ts == START)
    #expect(p.source == "calendar")
    #expect(p.title == "ARR Standup")
    #expect(p.meta["attendees"] == "Sam, Alex")
    #expect(p.meta["attendeeCount"] == "2")
    #expect(p.meta["durationSec"] == "1800")
}

@Test func longInviteBoilerplateIsCapped() {
    let e = ev { $0 = CalendarEventInput(identifier: "L", title: "Webinar",
                                         start: START, end: START + 60,
                                         notes: String(repeating: "x", count: 5000)) }
    let text = calendarEventText(e, timeZone: IST)
    #expect(text.count < 2400)          // capped, not the full 5000
    #expect(text.hasSuffix("…"))
}

@Test func optionalFieldsAreOmittedRatherThanRenderedEmpty() {
    let e = CalendarEventInput(identifier: "M", title: "Focus block",
                               start: START, end: START + 3600,
                               location: "   ", notes: "", organizer: nil)
    let text = calendarEventText(e, timeZone: IST)
    #expect(!text.contains("Where:"))
    #expect(!text.contains("Organizer:"))
    #expect(!text.contains("Attendees:"))
    let p = calendarEventPayload(e)!
    #expect(p.meta["location"] == nil)
    #expect(p.meta["attendees"] == nil)
}

@Test func attendeeNamesNeverCarryAContactableAddress() {
    // EKParticipant.name falls back to the raw email when no display name is
    // set, so `compactMap(\.name)` yields a MIX. Probing a real calendar on
    // 2026-08-08 showed addresses reaching the store, while both this file and
    // the meeting stamp claimed "display names, never emails".
    #expect(attendeeDisplayName("Sam Rivera") == "Sam Rivera")
    #expect(attendeeDisplayName("sam.rivera@example.com") == "sam.rivera")
    #expect(attendeeDisplayName("  alex@example.com  ") == "alex")
    #expect(attendeeDisplayName("@example.com") == nil)      // no local part
    #expect(attendeeDisplayName("   ") == nil)
    // The property that matters: nothing that comes out is contactable.
    for raw in ["Sam Rivera", "sam.rivera@example.com", "  alex@example.com  "] {
        #expect(!(attendeeDisplayName(raw) ?? "").contains("@"))
    }
}
