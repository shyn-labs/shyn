import Foundation
import EventKit
import CaptureCore

// Reads calendar events from the LOCAL EventKit store and ships them to the
// daemon as documents. macOS Calendar's own sync (Google/Exchange/iCloud) is the
// transport; shyn makes no network call, exactly as calendarStamp already does.
//
// This lives in the meeting agent because that process already holds the
// Calendar grant and already imports EventKit — no new permission, no second
// prompt, and nothing to install.

/// A wide-but-bounded window. Backwards for recall ("what did I do in July"),
/// a little forwards so "what's coming up" is answerable at all. Re-read whole
/// each sweep rather than incrementally: an event can be edited or cancelled
/// after the fact, and ingest dedups by content hash, so a re-read of unchanged
/// events costs one hash comparison each and changes nothing.
let calendarPastDays = 180
let calendarFutureDays = 30

/// Hourly. Calendars change on human timescales, and a sweep re-reads a
/// six-month window — there is nothing to gain from doing it every tick.
let calendarSyncIntervalSeconds = 3600

// `async` and free (nonisolated) ON PURPOSE: reading a six-month window and
// shipping ~2,000 payloads takes seconds, and awaiting that inside the agent
// actor would freeze detection and `shyn meeting stop` — the exact bug that
// forced transcription off the tick path. Called with await from the actor, this
// runs on the cooperative pool instead.
@available(macOS 14.2, *)
func readCalendarEvents(now: Int) async -> [IngestPayload] {
    guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else { return [] }
    let store = EKEventStore()
    let from = Date(timeIntervalSince1970: Double(now - calendarPastDays * 86400))
    let to = Date(timeIntervalSince1970: Double(now + calendarFutureDays * 86400))

    // predicateForEvents caps at ~4 years per call; our window is far inside
    // that, so one call is enough.
    let events = store.events(matching: store.predicateForEvents(
        withStart: from, end: to, calendars: nil))

    return events.compactMap { e -> IngestPayload? in
        guard let start = e.startDate, let end = e.endDate else { return nil }
        // attendeeDisplayName because EKParticipant.name silently falls back to
        // the raw email address — see its doc comment for why that matters.
        let attendees = (e.attendees ?? []).compactMap(\.name).compactMap(attendeeDisplayName)
        let declined = (e.attendees ?? [])
            .first { $0.isCurrentUser }?.participantStatus == .declined
        return calendarEventPayload(CalendarEventInput(
            identifier: e.eventIdentifier ?? e.calendarItemIdentifier,
            title: e.title ?? "",
            start: Int(start.timeIntervalSince1970),
            end: Int(end.timeIntervalSince1970),
            isAllDay: e.isAllDay,
            location: e.location,
            notes: e.notes,
            organizer: e.organizer?.name.flatMap(attendeeDisplayName),
            attendees: attendees,
            declined: declined))
    }
}

/// Ships a sweep's payloads. Returns how many landed; stops at the first failure
/// because a daemon that is down will fail all of them, and the next sweep
/// re-reads the whole window anyway.
@available(macOS 14.2, *)
func shipCalendarEvents(_ payloads: [IngestPayload], via client: DaemonClient) async -> Int {
    var shipped = 0
    for p in payloads {
        do { try await client.ingest(p); shipped += 1 } catch { break }
    }
    return shipped
}
