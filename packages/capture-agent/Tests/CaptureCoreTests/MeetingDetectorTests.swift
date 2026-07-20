import Testing
import Foundation
@testable import CaptureCore

private func sig(_ mic: Bool, _ sys: Bool, app: Bool = false) -> MeetingSignal {
    MeetingSignal(micActive: mic, systemAudioActive: sys, meetingAppFrontmost: app)
}

@Test func detectsCandidateThenRecordsAfterGrace() {
    let cfg = MeetingConfig.defaults   // graceSeconds 10, endSilenceSeconds 60, candidateSeconds 10
    var d = MeetingDetector()
    #expect(d.step(signal: sig(true, true), now: 0, config: cfg) == .idle)        // t0: audio just started
    #expect(d.step(signal: sig(true, true), now: 10, config: cfg) == .candidate)  // sustained 10s → candidate
    #expect(d.step(signal: sig(true, true), now: 20, config: cfg) == .candidate)  // within grace
    #expect(d.step(signal: sig(true, true), now: 21, config: cfg) == .recording)  // grace elapsed (10s after candidate)
}

@Test func endsAfter60sSilenceNotBefore() {
    let cfg = MeetingConfig.defaults
    var d = MeetingDetector()
    _ = d.step(signal: sig(true, true), now: 0, config: cfg)
    _ = d.step(signal: sig(true, true), now: 10, config: cfg)   // candidate
    _ = d.step(signal: sig(true, true), now: 21, config: cfg)   // recording
    #expect(d.step(signal: sig(false, false), now: 60, config: cfg) == .recording)  // 39s silence < 60
    #expect(d.step(signal: sig(false, false), now: 82, config: cfg) == .ended)      // 61s silence ≥ 60
}

@Test func cancelResetsToIdle() {
    let cfg = MeetingConfig.defaults
    var d = MeetingDetector()
    _ = d.step(signal: sig(true, true), now: 0, config: cfg)
    _ = d.step(signal: sig(true, true), now: 10, config: cfg)   // candidate
    d.cancel()
    #expect(d.state == .idle)
}

@Test func oneSidedAudioKeepsRecordingAlive() {
    // Start needs BOTH channels (a call has two sides); continuation needs
    // EITHER — one side listening silently for >60s must not end the meeting.
    let cfg = MeetingConfig.defaults
    var d = MeetingDetector()
    _ = d.step(signal: sig(true, true), now: 0, config: cfg)
    _ = d.step(signal: sig(true, true), now: 10, config: cfg)   // candidate
    _ = d.step(signal: sig(true, true), now: 21, config: cfg)   // recording
    #expect(d.step(signal: sig(true, false), now: 90, config: cfg) == .recording)   // only me talking
    #expect(d.step(signal: sig(false, true), now: 160, config: cfg) == .recording)  // only others talking
    #expect(d.step(signal: sig(false, false), now: 221, config: cfg) == .ended)     // 61s of full silence
}

@Test func briefAudioBlipDoesNotTrigger() {
    let cfg = MeetingConfig.defaults
    var d = MeetingDetector()
    #expect(d.step(signal: sig(true, true), now: 0, config: cfg) == .idle)
    #expect(d.step(signal: sig(false, false), now: 3, config: cfg) == .idle)  // audio stopped before candidateSeconds
}

@Test func listenOnlyMeetingInMeetingAppRecords() {
    // A muted briefing: no live mic, only incoming system audio — but a
    // recognized meeting app is frontmost. Must still record (finding #8).
    let cfg = MeetingConfig.defaults
    var d = MeetingDetector()
    #expect(d.step(signal: sig(false, true, app: true), now: 0, config: cfg) == .idle)
    #expect(d.step(signal: sig(false, true, app: true), now: 10, config: cfg) == .candidate)
    #expect(d.step(signal: sig(false, true, app: true), now: 21, config: cfg) == .recording)
}

@Test func systemAudioWithoutMeetingAppDoesNotRecord() {
    // A lone YouTube video (system audio, no mic, no meeting app frontmost)
    // must NOT start a recording — the meeting-app gate is what prevents it.
    let cfg = MeetingConfig.defaults
    var d = MeetingDetector()
    #expect(d.step(signal: sig(false, true, app: false), now: 0, config: cfg) == .idle)
    #expect(d.step(signal: sig(false, true, app: false), now: 10, config: cfg) == .idle)
    #expect(d.step(signal: sig(false, true, app: false), now: 30, config: cfg) == .idle)
}
