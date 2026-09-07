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

@Test func cancelUntilQuietSuppressesRecandidateWhileSignalsStayActive() {
    // The phantom-purge loop (live finding 2026-08-18): verification fails,
    // the detector is cancelled, but the meeting app still holds mic+system —
    // so it re-candidated 10s later and re-notified every ~57s for a whole
    // meeting. After cancelUntilQuiet(), continuously-active audio must NOT
    // produce a new candidate; only a quiet gap re-arms detection.
    let cfg = MeetingConfig.defaults
    var d = MeetingDetector()
    _ = d.step(signal: sig(true, true), now: 0, config: cfg)
    _ = d.step(signal: sig(true, true), now: 10, config: cfg)   // candidate
    _ = d.step(signal: sig(true, true), now: 21, config: cfg)   // recording
    d.cancelUntilQuiet(now: 21)
    #expect(d.state == .idle)
    #expect(d.step(signal: sig(true, true), now: 30, config: cfg) == .idle)
    #expect(d.step(signal: sig(true, true), now: 120, config: cfg) == .idle)   // 90s active: still suppressed
    #expect(d.step(signal: sig(true, true), now: 600, config: cfg) == .idle)   // suppression never times out
}

@Test func quietGapReArmsDetectionAfterCancelUntilQuiet() {
    let cfg = MeetingConfig.defaults
    var d = MeetingDetector()
    _ = d.step(signal: sig(true, true), now: 0, config: cfg)
    _ = d.step(signal: sig(true, true), now: 10, config: cfg)   // candidate
    d.cancelUntilQuiet(now: 10)   // first purge: no backoff, so one quiet tick still re-arms
    _ = d.step(signal: sig(true, true), now: 20, config: cfg)    // suppressed
    _ = d.step(signal: sig(false, false), now: 30, config: cfg)  // quiet: re-armed
    #expect(d.step(signal: sig(true, true), now: 40, config: cfg) == .idle)       // new episode t0
    #expect(d.step(signal: sig(true, true), now: 50, config: cfg) == .candidate)  // sustained 10s → candidate
}

@Test func plainCancelStillAllowsImmediateRedetection() {
    // `cancel()` keeps its old semantics (max-duration splits rely on it):
    // detection restarts while the signals are still active.
    let cfg = MeetingConfig.defaults
    var d = MeetingDetector()
    _ = d.step(signal: sig(true, true), now: 0, config: cfg)
    _ = d.step(signal: sig(true, true), now: 10, config: cfg)   // candidate
    d.cancel()
    _ = d.step(signal: sig(true, true), now: 20, config: cfg)   // new episode t0
    #expect(d.step(signal: sig(true, true), now: 30, config: cfg) == .candidate)
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

@Test func rescueEvidenceReArmsDetectionOnceAfterAPhantomPurge() {
    // The purge AMPLIFIER (live loss 2026-08-31): suppression only lifts on a
    // quiet observation, but a live call never goes quiet — so one wrong
    // 40-second verdict disarmed detection for the remaining 57 minutes of a
    // real meeting. Rescue evidence arriving later (the user finally joins the
    // call properly, the browser grabs the mic) must re-arm without waiting
    // for silence that will not come until the call is over.
    let cfg = MeetingConfig.defaults
    var d = MeetingDetector()
    _ = d.step(signal: sig(true, true), now: 0, config: cfg)
    _ = d.step(signal: sig(true, true), now: 10, config: cfg)   // candidate
    _ = d.step(signal: sig(true, true), now: 21, config: cfg)   // recording
    d.cancelUntilQuiet(now: 21)
    #expect(d.step(signal: sig(true, true), now: 30, config: cfg) == .idle)  // suppressed

    // Rising edge of rescue: false → true re-arms even though audio never
    // went quiet. The FIRST purge carries no backoff, so rescue still works
    // here — that is deliberate (see purgeBackoffSeconds).
    d.noteRescueEvidence(now: 30)
    #expect(d.step(signal: sig(true, true), now: 40, config: cfg) == .idle)       // new episode t0
    #expect(d.step(signal: sig(true, true), now: 50, config: cfg) == .candidate)  // sustained → candidate
}

@Test func rescueReArmIsBoundedToOncePerEpisode() {
    // Bounded on purpose: an unbounded re-arm would resurrect the original
    // notification-spam bug (one "Meeting detected" every ~57s for a whole
    // call) whenever the rescue signal stays true through repeated purges.
    let cfg = MeetingConfig.defaults
    var d = MeetingDetector()
    _ = d.step(signal: sig(true, true), now: 0, config: cfg)
    _ = d.step(signal: sig(true, true), now: 10, config: cfg)
    d.cancelUntilQuiet(now: 10)
    d.noteRescueEvidence(now: 10)
    _ = d.step(signal: sig(true, true), now: 20, config: cfg)
    _ = d.step(signal: sig(true, true), now: 30, config: cfg)   // candidate again

    // Second purge in the same unbroken episode: rescue must NOT re-arm again.
    d.cancelUntilQuiet(now: 30)
    d.noteRescueEvidence(now: 30)
    #expect(d.step(signal: sig(true, true), now: 40, config: cfg) == .idle)
    #expect(d.step(signal: sig(true, true), now: 100, config: cfg) == .idle)

    // Only real silence clears the episode and restores the rescue budget —
    // and since 2026-09-07, silence means SUSTAINED silence. A single quiet
    // sample is what a flapping room produces every cycle; treating it as the
    // end of an episode is what let one notification fire every 57 seconds.
    _ = d.step(signal: sig(false, false), now: 110, config: cfg)
    #expect(d.step(signal: sig(true, true), now: 120, config: cfg) == .idle)  // one dip: not enough
    for t in stride(from: 130.0, through: 175.0, by: 5.0) {
        _ = d.step(signal: sig(false, false), now: t, config: cfg)
    }
    _ = d.step(signal: sig(true, true), now: 180, config: cfg)
    #expect(d.step(signal: sig(true, true), now: 191, config: cfg) == .candidate)
}

// LIVED 2026-09-07, at an all-day in-person event: 26 "Meeting detected"
// notifications between 10:10 and 10:37, at a metronomic 57–58s apart.
//
// The period is the whole tell. candidateSeconds(10) + graceSeconds(10) +
// commitVerificationSlack(30) = 50s of cycle, plus tick granularity = 57s.
// Every cycle: candidate → notify → record a pre-roll → fail verification
// (mic and system both unvoiced, because it is a ROOM) → purge → re-arm →
// repeat, indefinitely.
//
// cancelUntilQuiet was supposed to stop exactly this, and its own comment says
// so. It does not, because its premise — "the signals that admitted the last
// episode are usually STILL active right after a cancel" — is false in a room.
// Outside .recording, `audio` needs mic AND system simultaneously, so any tick
// where that conjunction breaks is a "quiet step" that clears suppression
// outright. Device activity flaps constantly; the suppression never survives
// one cycle.
//
// Suppression is purely condition-based, so there is NO FLOOR on how often the
// notification can fire. That is the defect: a failure repeating identically
// forever should get quieter, not keep its cadence.
private func simulateFlappingRoom(dipEvery: Int, minutes: Double,
                                  detector d: inout MeetingDetector) -> Int {
    let cfg = MeetingConfig.defaults
    var notifications = 0, prev = MeetingState.idle
    var recordingSince: Double? = nil
    var t = 0.0
    while t < minutes * 60 {
        // Device activity flaps: a one-tick dip periodically, which is all it
        // takes to look like "quiet" to the start gate.
        let dip = Int(t / 3) % dipEvery == dipEvery - 1
        let st = d.step(signal: sig(!dip, !dip), now: t, config: cfg)
        if st == .candidate && prev != .candidate { notifications += 1 }
        if st == .recording {
            recordingSince = recordingSince ?? t
            // The commit gate purges an unverified pre-roll once the
            // verification window elapses: grace + 30s slack from pre-roll,
            // i.e. 30s after .recording begins.
            if t - (recordingSince ?? t) >= 30 {
                d.cancelUntilQuiet(now: t); recordingSince = nil
            }
        } else { recordingSince = nil }
        prev = st
        t += 3
    }
    return notifications
}

@Test func aRoomThatNeverVerifiesMustNotNotifyForever() {
    var d = MeetingDetector()
    let n = simulateFlappingRoom(dipEvery: 19, minutes: 30, detector: &d)
    // Half an hour of a signal that can never commit.
    //
    // 5 is not a slack number, it is what the ladder predicts: retries at
    // roughly t=10s, 60s, 230s, 580s, 1530s — the 0/120/300/900/900 backoff
    // laid end to end with the ~50s cycle. Before this change the cadence was
    // flat at one per cycle: 26 were observed live in 27 minutes, and this
    // simulation reproduced the same fixed ~57s spacing.
    #expect(n <= 5, "got \(n) 'Meeting detected' notifications in 30 minutes")
    // And the gaps must GROW — a fixed cadence at any value is the bug.
    #expect(n >= 3, "backoff must not silence detection outright, got \(n)")
}

@Test func backoffDoesNotCostTheFirstRetry() {
    // The 2026-08-31 loss must not come back: one wrong 40-second verdict cost
    // 57 minutes of a real meeting, and the rescue re-arm exists so a bad call
    // costs 40s instead. Backoff must leave the FIRST retry alone.
    let cfg = MeetingConfig.defaults
    var d = MeetingDetector()
    _ = d.step(signal: sig(true, true), now: 0, config: cfg)
    _ = d.step(signal: sig(true, true), now: 10, config: cfg)   // candidate
    _ = d.step(signal: sig(true, true), now: 21, config: cfg)   // recording
    d.cancelUntilQuiet(now: 21)
    d.noteRescueEvidence(now: 24)
    _ = d.step(signal: sig(true, true), now: 30, config: cfg)   // new episode t0
    #expect(d.step(signal: sig(true, true), now: 41, config: cfg) == .candidate)
}

@Test func aCommittedSessionClearsTheBackoff() {
    // Backoff counts CONSECUTIVE failures. A meeting that actually commits is
    // proof the gate is working here, so the next purge starts from scratch —
    // otherwise a long day of real meetings would slowly go deaf.
    let cfg = MeetingConfig.defaults
    var d = MeetingDetector()
    for i in 1...4 {
        _ = d.step(signal: sig(false, false), now: Double(i) * 1000 - 20, config: cfg)
        _ = d.step(signal: sig(true, true), now: Double(i) * 1000 - 10, config: cfg)
        _ = d.step(signal: sig(true, true), now: Double(i) * 1000, config: cfg)
        d.cancelUntilQuiet(now: Double(i) * 1000)
    }
    d.noteCommitted()
    // Fresh start: a quiet step then sustained audio candidates immediately.
    _ = d.step(signal: sig(false, false), now: 5000, config: cfg)
    _ = d.step(signal: sig(true, true), now: 5010, config: cfg)
    #expect(d.step(signal: sig(true, true), now: 5021, config: cfg) == .candidate)
}
