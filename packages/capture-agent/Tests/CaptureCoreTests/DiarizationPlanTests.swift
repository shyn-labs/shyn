import Foundation
import Testing
@testable import CaptureCore

private let call = [TranscriptSegment(start: 0, end: 1, speaker: .me, text: "hi"),
                    TranscriptSegment(start: 1, end: 2, speaker: .others, text: "hello")]
private let room = [TranscriptSegment(start: 0, end: 1, speaker: .me, text: "hi")]

@Test func offMeansSkipWithoutAReasonWorthLogging() {
    #expect(diarizationPlan(enabled: false, modelsReady: true, segments: call, crashedLastAttempt: false) == .skip("off"))
}

@Test func onButModelNotReadyFallsBackToTodaysLabels() {
    // Review focus 1: the user flips the toggle and has a meeting before the download ends.
    #expect(diarizationPlan(enabled: true, modelsReady: false, segments: call, crashedLastAttempt: false) == .skip("model not ready"))
}

@Test func aCallDiarizesTheFarSide() {
    #expect(diarizationPlan(enabled: true, modelsReady: true, segments: call, crashedLastAttempt: false) == .diarize(.others))
}

@Test func inPersonDiarizesTheMic() {
    #expect(diarizationPlan(enabled: true, modelsReady: true, segments: room, crashedLastAttempt: false) == .diarize(.me))
}

@Test func nothingSaidNothingToDiarize() {
    #expect(diarizationPlan(enabled: true, modelsReady: true, segments: [], crashedLastAttempt: false) == .skip("no speech"))
}

@Test func aCrashDuringTheLastAttemptSkipsDiarization() {
    // Review: a native crash in the diarizer never reaches keepForRetry, so launchd
    // would restart the agent into the same crash forever. The breadcrumb breaks the loop.
    #expect(diarizationPlan(enabled: true, modelsReady: true, segments: call, crashedLastAttempt: true)
            == .skip("crashed last attempt"))
    #expect(diarizationPlan(enabled: true, modelsReady: true, segments: room, crashedLastAttempt: true)
            == .skip("crashed last attempt"))
}

@Test func offStillWinsOverACrashBreadcrumb() {
    #expect(diarizationPlan(enabled: false, modelsReady: true, segments: call, crashedLastAttempt: true)
            == .skip("off"))
}

@Test func diarizingBreadcrumbLifecycle() throws {
    let dir = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("diarizing-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    #expect(!diarizingBreadcrumbExists(in: dir))
    markDiarizing(in: dir)
    #expect(diarizingBreadcrumbExists(in: dir))
    clearDiarizingBreadcrumb(in: dir)
    #expect(!diarizingBreadcrumbExists(in: dir))
    // Clearing an absent breadcrumb is harmless.
    clearDiarizingBreadcrumb(in: dir)
}
