import Foundation

// Builds the meeting-source IngestPayload (wire contract frozen by
// packages/daemon/test/meeting-e2e.test.ts — keep field-for-field in sync).
// Lives in CaptureCore so the shape is unit-testable; the byte-honest audio
// purge stays with the uploader.

// eventTitle/attendees are the calendar stamp (spec
// 2026-07-23-eventkit-meeting-stamping): EventKit match first, window-title
// fallback second, nil → today's app-name format. Attendees are display
// names, never emails.
public func meetingPayload(bundleId: String?, appName: String, startEpoch: Int, endEpoch: Int,
                           transcript: String,
                           eventTitle: String? = nil, attendees: [String] = [],
                           timeZone: TimeZone = .current) -> IngestPayload {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd-HHmm"   // meeting START in LOCAL time (spec uri scheme)
    f.locale = Locale(identifier: "en_US_POSIX")
    let stamp = f.string(from: Date(timeIntervalSince1970: Double(startEpoch)))
    let app = bundleId ?? "call"
    let human = DateFormatter(); human.dateStyle = .medium; human.timeStyle = .short
    let when = human.string(from: Date(timeIntervalSince1970: Double(startEpoch)))
    var meta = ["app": appName, "bundleId": app, "startedAt": String(startEpoch),
                "endedAt": String(endEpoch), "durationSec": String(endEpoch - startEpoch),
                "channels": "me,others",
                // "Where was I": the zone the Mac was set to while this ran.
                // The offset is already in every timestamp; naming it makes a
                // trip searchable. Location proper is deliberately not here.
                "tz": timeZone.identifier,
                "tzOffset": gmtOffsetString(timeZone, at: Date(timeIntervalSince1970: Double(startEpoch)))]
    if let t = eventTitle {
        meta["calTitle"] = t
        if !attendees.isEmpty {
            meta["attendees"] = attendees.joined(separator: ", ")
            meta["attendeeCount"] = String(attendees.count)
        }
    }
    return IngestPayload(
        source: "meeting",
        uri: "meeting://\(app)/\(stamp)",
        title: eventTitle.map { "\($0) · \(appName) · \(when)" } ?? "\(appName) meeting · \(when)",
        ts: startEpoch, text: transcript,
        meta: meta)
}

func gmtOffsetString(_ tz: TimeZone, at date: Date) -> String {
    let secs = tz.secondsFromGMT(for: date)
    let sign = secs < 0 ? "-" : "+"
    let a = abs(secs)
    return String(format: "%@%02d:%02d", sign, a / 3600, (a % 3600) / 60)
}
