import Testing
import Foundation
@testable import CaptureCore

@Test func mergesChannelsChronologicallyWithLabels() {
    let segs = [
        TranscriptSegment(start: 0.0, speaker: .me, text: "hi everyone"),
        TranscriptSegment(start: 2.5, speaker: .others, text: "hello, ready to start?"),
        TranscriptSegment(start: 5.0, speaker: .me, text: "yes let's go"),
    ]
    let t = assembleTranscript(segs)
    // chronological, speaker-labeled
    #expect(t == "Me: hi everyone\nOthers: hello, ready to start?\nMe: yes let's go")
}

@Test func handlesOneSidedAndEmpty() {
    #expect(assembleTranscript([]) == "")
    let onlyOthers = [TranscriptSegment(start: 1, speaker: .others, text: "solo speaker")]
    #expect(assembleTranscript(onlyOthers) == "Others: solo speaker")
}

@Test func meetingConfigPartialJsonAndDefaults() throws {
    let path = NSTemporaryDirectory() + "cap-\(UUID()).json"
    try #"{"meeting":{"whisperModel":"medium","excludeApps":["com.zoom.xos"]}}"#
        .write(toFile: path, atomically: true, encoding: .utf8)
    let c = MeetingConfig.load(from: path)
    #expect(c.whisperModel == "medium")
    #expect(c.excludeApps == ["com.zoom.xos"])
    #expect(c.endSilenceSeconds == 60)   // default preserved
    #expect(MeetingConfig.load(from: "/nope.json").whisperModel == "small")  // missing → defaults
}
