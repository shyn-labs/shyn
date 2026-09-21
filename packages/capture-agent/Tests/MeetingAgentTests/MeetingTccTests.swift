import Testing
import Foundation
@testable import shyn_meeting

// `tcc.audio` is not a permission query — macOS offers none for System Audio
// Recording. The agent learns the answer only by trying: true when a pre-roll
// recording starts, false when the recorder fails to start. Before either
// happens the honest value is "don't know", and the wire must say so by
// leaving the key out. Encoding a default of `false` read as "grant revoked"
// in `shyn diagnose` and the popover (logged 2026-09-01).

private func encodedTcc(_ stats: MeetingStats) -> [String: Any] {
    let data = try! JSONEncoder().encode(stats)
    let obj = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
    return obj["tcc"] as! [String: Any]
}

@Test func freshAgentOmitsAudioUntilARecordingIsAttempted() {
    let tcc = encodedTcc(MeetingStats())
    #expect(tcc["audio"] == nil)
    // The real permission queries still ship every time.
    #expect(tcc["mic"] != nil)
}

@Test func audioIsTrueAfterAStartedRecordingAndFalseAfterAFailedOne() {
    var stats = MeetingStats()
    stats.tcc.audio = true
    #expect(encodedTcc(stats)["audio"] as? Bool == true)
    stats.tcc.audio = false
    #expect(encodedTcc(stats)["audio"] as? Bool == false)
}
