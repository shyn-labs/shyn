import Testing
@testable import CaptureCore

private let call = [TranscriptSegment(start: 0, end: 1, speaker: .me, text: "hi"),
                    TranscriptSegment(start: 1, end: 2, speaker: .others, text: "hello")]
private let room = [TranscriptSegment(start: 0, end: 1, speaker: .me, text: "hi")]

@Test func offMeansSkipWithoutAReasonWorthLogging() {
    #expect(diarizationPlan(enabled: false, modelsReady: true, segments: call) == .skip("off"))
}

@Test func onButModelNotReadyFallsBackToTodaysLabels() {
    // Review focus 1: the user flips the toggle and has a meeting before the download ends.
    #expect(diarizationPlan(enabled: true, modelsReady: false, segments: call) == .skip("model not ready"))
}

@Test func aCallDiarizesTheFarSide() {
    #expect(diarizationPlan(enabled: true, modelsReady: true, segments: call) == .diarize(.others))
}

@Test func inPersonDiarizesTheMic() {
    #expect(diarizationPlan(enabled: true, modelsReady: true, segments: room) == .diarize(.me))
}

@Test func nothingSaidNothingToDiarize() {
    #expect(diarizationPlan(enabled: true, modelsReady: true, segments: []) == .skip("no speech"))
}
