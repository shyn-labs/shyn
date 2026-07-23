import Testing
@testable import CaptureCore

// The gate decides when the meeting agent kicks a background Whisper
// pre-download: on startup AND whenever the configured model changes
// (status-ui writes capture.json; config hot-reloads). One download at a
// time; failures back off instead of hammering every 3s tick.

@Test func kicksWhenModelAbsentAndIdle() {
    var g = ModelPredownloadGate()
    #expect(g.shouldKick(present: false, now: 1000) == true)
}

@Test func noKickWhenPresentOrInFlight() {
    var g = ModelPredownloadGate()
    #expect(g.shouldKick(present: true, now: 1000) == false)   // already on disk
    #expect(g.shouldKick(present: false, now: 1003) == true)   // kick
    #expect(g.shouldKick(present: false, now: 1006) == false)  // in flight — no second kick
}

@Test func successResetsSoAModelSwitchKicksAgain() {
    var g = ModelPredownloadGate()
    #expect(g.shouldKick(present: false, now: 0) == true)      // small missing → kick
    g.finished(success: true, now: 60)
    #expect(g.shouldKick(present: true, now: 63) == false)     // small ready
    // user switches to large-v3 (not on disk) → immediate kick
    #expect(g.shouldKick(present: false, now: 120) == true)
}

@Test func failureCoolsDownThenRetries() {
    var g = ModelPredownloadGate(cooldownSeconds: 300)
    #expect(g.shouldKick(present: false, now: 0) == true)
    g.finished(success: false, now: 30)                        // network died
    #expect(g.shouldKick(present: false, now: 33) == false)    // cooldown
    #expect(g.shouldKick(present: false, now: 329) == false)   // still cooling
    #expect(g.shouldKick(present: false, now: 331) == true)    // retry after cooldown
}
