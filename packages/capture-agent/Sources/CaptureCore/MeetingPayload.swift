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
                           eventTitle: String? = nil, attendees: [String] = []) -> IngestPayload {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd-HHmm"   // meeting START in LOCAL time (spec uri scheme)
    f.locale = Locale(identifier: "en_US_POSIX")
    let stamp = f.string(from: Date(timeIntervalSince1970: Double(startEpoch)))
    let app = bundleId ?? "call"
    let human = DateFormatter(); human.dateStyle = .medium; human.timeStyle = .short
    let when = human.string(from: Date(timeIntervalSince1970: Double(startEpoch)))
    var meta = ["app": appName, "bundleId": app, "startedAt": String(startEpoch),
                "endedAt": String(endEpoch), "durationSec": String(endEpoch - startEpoch),
                "channels": "me,others"]
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
