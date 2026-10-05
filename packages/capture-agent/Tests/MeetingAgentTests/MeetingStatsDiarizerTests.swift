import Testing
import Foundation
@testable import shyn_meeting

// The diarizer fields exist only for users who turned meeting.diarization on.
// Everyone else's stats wire must not change: the keys stay out entirely
// (synthesized Codable skips a nil optional), same as whisperDownloading.

private func encodedStats(_ stats: MeetingStats) -> [String: Any] {
    let data = try! JSONEncoder().encode(stats)
    return try! JSONSerialization.jsonObject(with: data) as! [String: Any]
}

@Test func diarizerStatsAreAbsentUntilSet() {
    var s = MeetingStats()
    let fresh = encodedStats(s)
    #expect(fresh["diarizerReady"] == nil)
    #expect(fresh["diarizerDownloading"] == nil)
    #expect(!String(data: try! JSONEncoder().encode(s), encoding: .utf8)!.contains("diarizer"))

    s.diarizerReady = true
    s.diarizerDownloading = false
    let set = encodedStats(s)
    #expect(set["diarizerReady"] as? Bool == true)
    #expect(set["diarizerDownloading"] as? Bool == false)
}

@Test func clearingDiarizerStatsRemovesTheKeysAgain() {
    var s = MeetingStats()
    s.diarizerReady = false
    s.diarizerDownloading = true
    s.diarizerReady = nil
    s.diarizerDownloading = nil
    #expect(!String(data: try! JSONEncoder().encode(s), encoding: .utf8)!.contains("diarizer"))
}
