import Foundation
import CaptureCore

// Builds the meeting-source IngestPayload (wire contract frozen by
// packages/daemon/test/meeting-e2e.test.ts — keep field-for-field in sync)
// and owns the byte-honest audio purge.

func meetingPayload(bundleId: String?, appName: String, startEpoch: Int, endEpoch: Int,
                    transcript: String) -> IngestPayload {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd-HHmm"   // meeting START in LOCAL time (spec uri scheme)
    f.locale = Locale(identifier: "en_US_POSIX")
    let stamp = f.string(from: Date(timeIntervalSince1970: Double(startEpoch)))
    let app = bundleId ?? "call"
    let human = DateFormatter(); human.dateStyle = .medium; human.timeStyle = .short
    return IngestPayload(
        source: "meeting",
        uri: "meeting://\(app)/\(stamp)",
        title: "\(appName) meeting · \(human.string(from: Date(timeIntervalSince1970: Double(startEpoch))))",
        ts: startEpoch, text: transcript,
        meta: ["app": appName, "bundleId": app, "startedAt": String(startEpoch),
               "endedAt": String(endEpoch), "durationSec": String(endEpoch - startEpoch),
               "channels": "me,others"])
}

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

struct MeetingTcc: Codable, Sendable { var mic: Bool; var audio: Bool }

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
