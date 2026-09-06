import Foundation
import CaptureCore

// The meeting-source IngestPayload builder moved to
// CaptureCore/MeetingPayload.swift (unit-testable). This file owns the
// byte-honest audio purge and the stats/control wire.

func purgeAudio(sessionDir: URL) { try? FileManager.default.removeItem(at: sessionDir) }

// Remove orphaned session dirs (agent crashed mid-meeting) older than 24h.
func sweepOrphanAudio(root: URL, olderThanSeconds: Double = 86_400) {
    guard let items = try? FileManager.default.contentsOfDirectory(
        at: root, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
    let cutoff = Date().addingTimeInterval(-olderThanSeconds)
    for item in items {
        let m = (try? item.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
        if let m, m < cutoff { try? FileManager.default.removeItem(at: item) }
    }
}

// --- Stats (posted under the top-level "meeting" key; the daemon merges
// captureStats posts by top-level key so screen + meeting agents coexist) ---

// `ax` is Accessibility, and it is reported for one reason: it is the ONLY
// signal that the window-title rung of the naming ladder is alive. Lived
// 2026-09-06 — com.shyn.meeting sat at Accessibility auth_value=0 while
// com.shyn.capture had it granted, so meetingWindowTitle() returned nil on
// every session. Seven meetings in a row were filed as "Google Chrome
// meeting", and the user reasonably read unfindable records as "shyn isn't
// capturing meetings". `shyn status` had nothing to say because this key did
// not exist. A permission that only degrades naming still has to be visible.
struct MeetingTcc: Codable, Sendable {
    var mic: Bool; var audio: Bool; var calendar: Bool = false; var ax: Bool = false
}

struct MeetingStats: Codable, Sendable {
    var state: String = "idle"
    var meetingsCaptured: Int = 0
    var lastTranscribedTs: Int = 0
    var modelReady: Bool = false
    var tcc = MeetingTcc(mic: false, audio: false)
    // Present only while a session is live (recording/transcribing): feeds
    // the status UI's live-meeting card (elapsed timer + app name).
    var sessionStartedAt: Int? = nil
    var sessionApp: String? = nil
    // True only while the startup Whisper pre-download is in flight
    // (onboarding shows a busy state; no percentage by design).
    var whisperDownloading: Bool? = nil
    // 0…1 overall transcription progress, present only while a background
    // transcription is running (state == "transcribing"); nil otherwise.
    var transcribeProgress: Double? = nil
}

private struct MeetingStatsEnvelope: Codable { var meeting: MeetingStats }

extension DaemonClient {
    func postMeetingStats(_ stats: MeetingStats) async throws {
        let data = try JSONEncoder().encode(MeetingStatsEnvelope(meeting: stats))
        let obj = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        _ = try await call(method: "captureStats", params: obj)
    }
}

// --- One-shot control file written by `shyn meeting stop|cancel` (CLI
// Task 10); the agent consumes (deletes) it on read. ---

enum MeetingControl: String { case stop, cancel }

func consumeMeetingControl(home: String) -> MeetingControl? {
    let path = home + "/meeting-control.json"
    guard let data = FileManager.default.contents(atPath: path) else { return nil }
    try? FileManager.default.removeItem(atPath: path)
    guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let action = obj["action"] as? String else { return nil }
    return MeetingControl(rawValue: action)
}
