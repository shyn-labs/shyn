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

// --- Echo-duplicate suppression (live finding 2026-08-04) ---

// Shape taken from the first real bleed transcript (paraphrased): one person
// asked a question once, speaker→mic bleed put a REWORDED copy on the mic
// channel, and the user was credited with a question he only heard. The
// rewording is the hard part — the two copies share no verb.
@Test func dropsMicEchoOfFarEndSpeech() {
    let segs = [
        TranscriptSegment(start: 12.0, speaker: .me,
                          text: "Why are you trying to run this for the earlier seasons?"),
        TranscriptSegment(start: 12.4, speaker: .others,
                          text: "Why are you doing this for the previous seasons?"),
    ]
    #expect(assembleTranscript(segs)
            == "Others: Why are you doing this for the previous seasons?")
}

@Test func keepsShortAffirmationsFromBothSides() {
    // "Yes, absolutely." on both channels: under echoMinTokens, so left alone.
    // Noise beats deleting a real "yes" that both people said.
    let segs = [
        TranscriptSegment(start: 30.0, speaker: .me, text: "Yes, absolutely."),
        TranscriptSegment(start: 30.6, speaker: .others, text: "Yes, absolute"),
    ]
    #expect(dropEchoDuplicates(segs).count == 2)
}

@Test func keepsGenuineCrossTalk() {
    let segs = [
        TranscriptSegment(start: 5.0, speaker: .me, text: "we should ship the release tomorrow"),
        TranscriptSegment(start: 5.5, speaker: .others, text: "what about the pricing page copy"),
    ]
    #expect(dropEchoDuplicates(segs).count == 2)
}

@Test func keepsSameSentenceRepeatedLater() {
    // A genuine repeat outside the echo window survives: bleed is simultaneous.
    let segs = [
        TranscriptSegment(start: 10.0, speaker: .others, text: "the start date is the thing that matters"),
        TranscriptSegment(start: 50.0, speaker: .me, text: "the start date is the thing that matters"),
    ]
    #expect(dropEchoDuplicates(segs).count == 2)
}

@Test func keepsMicSpeechWhenSystemChannelIsSilent() {
    let segs = [
        TranscriptSegment(start: 1.0, speaker: .me, text: "let me walk through the form changes"),
        TranscriptSegment(start: 9.0, speaker: .me, text: "the schedule is already built into it"),
    ]
    #expect(dropEchoDuplicates(segs).count == 2)
}

@Test func dedupeSweepHandlesManySegmentsInOrder() {
    // Window must advance monotonically without dropping later matches.
    var segs: [TranscriptSegment] = []
    for i in 0..<200 {
        let t = Double(i) * 10
        segs.append(TranscriptSegment(start: t, speaker: .others,
                                      text: "agenda item number \(i) needs a decision"))
        segs.append(TranscriptSegment(start: t + 0.5, speaker: .me,
                                      text: "agenda item number \(i) needs a decision"))
    }
    let kept = dropEchoDuplicates(segs)
    #expect(kept.count == 200)
    #expect(kept.allSatisfy { $0.speaker == .others })
}

@Test func overlapCoefficientFavoursShorterSide() {
    let a = normalizedTokens("Why are you trying to run this for the earlier seasons?")
    let b = normalizedTokens("Why are you doing this for the previous seasons?")
    #expect(overlapCoefficient(a, b) >= echoOverlapThreshold)
    #expect(overlapCoefficient(a, normalizedTokens("completely unrelated sentence here")) < 0.3)
    #expect(overlapCoefficient([], a) == 0)
}
