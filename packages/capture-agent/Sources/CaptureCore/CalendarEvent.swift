import Foundation

// Calendar events as first-class memory documents.
//
// Why here and not a TypeScript reader beside chrome/safari/notes: the calendar
// store under ~/Library/Calendars and the group container are TCC-protected and
// their on-disk schema is undocumented — the Notes reader already carries a
// known-issues entry about depending on exactly that kind of reverse-engineered
// schema. The meeting agent instead holds a WORKING Calendar grant and already
// queries EventKit, a documented API. Using it needs no new permission and no
// schema archaeology.
//
// Motivating gap (2026-08-06): asked to reconstruct a day, recall could only
// infer the schedule from SCREENSHOTS of the calendar. The events themselves
// were never indexed.

/// The parts of an EKEvent this file needs, lifted out so the shaping logic —
/// and its tests — never link EventKit.
public struct CalendarEventInput: Sendable {
    public let identifier: String
    public let title: String
    public let start: Int
    public let end: Int
    public let isAllDay: Bool
    public let location: String?
    public let notes: String?
    public let organizer: String?
    /// Display names only, never email addresses — same rule the meeting
    /// calendar stamp already follows.
    public let attendees: [String]
    /// True when the user declined: it did not happen, so it is not a record of
    /// the day. Kept out rather than filtered at query time.
    public let declined: Bool

    public init(identifier: String, title: String, start: Int, end: Int,
                isAllDay: Bool = false, location: String? = nil, notes: String? = nil,
                organizer: String? = nil, attendees: [String] = [], declined: Bool = false) {
        self.identifier = identifier; self.title = title
        self.start = start; self.end = end; self.isAllDay = isAllDay
        self.location = location; self.notes = notes
        self.organizer = organizer; self.attendees = attendees; self.declined = declined
    }
}

/// EKParticipant.name falls back to the raw email address when a participant has
/// no display name set, so `compactMap(\.name)` does NOT yield display names —
/// it yields a mix. Both this file's original comment and the meeting calendar
/// stamp claimed "display names, never emails" while doing exactly that (found
/// 2026-08-08 by probing a real calendar: raw addresses were reaching the payload).
///
/// It matters because documents leave the machine: recall hands them to an LLM
/// over MCP, so a contactable address for every colleague would travel with
/// them. The local part still answers "who was in that meeting" without shipping
/// an address.
public func attendeeDisplayName(_ raw: String) -> String? {
    let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !t.isEmpty else { return nil }
    guard let at = t.firstIndex(of: "@") else { return t }   // a real display name
    let local = String(t[t.startIndex..<at])
    return local.isEmpty ? nil : local
}

/// A recurring event shares ONE identifier across every occurrence, so the URI
/// must carry the occurrence start or the whole series collapses into a single
/// document that overwrites itself every week.
public func calendarEventUri(_ e: CalendarEventInput) -> String {
    "calendar://\(e.identifier)/\(e.start)"
}

/// Body text is what search actually matches on, so it carries the things a
/// person would search for — who was there, where, and any agenda in the notes.
public func calendarEventText(_ e: CalendarEventInput, timeZone: TimeZone = .current) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = timeZone
    f.dateFormat = e.isAllDay ? "EEEE, d MMM yyyy" : "EEEE, d MMM yyyy HH:mm"
    let when = f.string(from: Date(timeIntervalSince1970: Double(e.start)))

    var lines = ["Calendar event: \(e.title)"]
    if e.isAllDay {
        lines.append("When: \(when) (all day)")
    } else {
        let mins = max(0, (e.end - e.start) / 60)
        lines.append("When: \(when) (\(mins) min)")
    }
    if let l = e.location?.trimmingCharacters(in: .whitespacesAndNewlines), !l.isEmpty {
        lines.append("Where: \(l)")
    }
    if let o = e.organizer?.trimmingCharacters(in: .whitespacesAndNewlines), !o.isEmpty {
        lines.append("Organizer: \(o)")
    }
    if !e.attendees.isEmpty {
        lines.append("Attendees: \(e.attendees.joined(separator: ", "))")
    }
    // Notes carry agendas and dial-in details. Capped: a pasted invite can run
    // to kilobytes of boilerplate that would dominate the document.
    if let n = e.notes?.trimmingCharacters(in: .whitespacesAndNewlines), !n.isEmpty {
        lines.append("")
        lines.append(n.count > 2000 ? String(n.prefix(2000)) + "…" : n)
    }
    return lines.joined(separator: "\n")
}

/// nil when the event should not be stored at all.
public func calendarEventPayload(_ e: CalendarEventInput) -> IngestPayload? {
    let title = e.title.trimmingCharacters(in: .whitespacesAndNewlines)
    // An untitled event carries no recallable content, and a declined one is a
    // record of something that did not happen.
    guard !title.isEmpty, !e.declined else { return nil }

    var meta = ["startedAt": String(e.start), "endedAt": String(e.end),
                "durationSec": String(max(0, e.end - e.start)),
                "allDay": e.isAllDay ? "true" : "false"]
    // Trim before the empty check, matching calendarEventText — without it a
    // whitespace-only field is rendered nowhere but still stored in meta.
    let trimmed = { (s: String?) -> String? in
        let t = s?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (t?.isEmpty ?? true) ? nil : t
    }
    if let l = trimmed(e.location) { meta["location"] = l }
    if let o = trimmed(e.organizer) { meta["organizer"] = o }
    if !e.attendees.isEmpty {
        meta["attendees"] = e.attendees.joined(separator: ", ")
        meta["attendeeCount"] = String(e.attendees.count)
    }
    return IngestPayload(
        source: "calendar",
        uri: calendarEventUri(e),
        title: title,
        // ts is the event START, not sync time: that is what makes an event show
        // up when recall enumerates the window it belongs to.
        ts: e.start,
        text: calendarEventText(e),
        meta: meta)
}
