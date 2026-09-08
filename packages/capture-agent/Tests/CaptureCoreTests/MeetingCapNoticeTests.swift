import Testing
import Foundation
@testable import CaptureCore

// Two moments where the duration cap has to be spoken out loud.
//
// AT THE CAP, it was silent until 2026-09-08: only a dbg() line marked it,
// which needs SHYN_MEETING_DEBUG=1, so the single visible signal was the live
// card quietly vanishing. Survivable for a call, which resumes on its own; bad
// for a room, which does not. Click Start at 09:00 for an all-day event and at
// 12:00 it stops while you carry on assuming it is running.
//
// AT THE START is the better moment, and the one that was missing entirely.
// Knowing the limit when a recording begins is planning information; learning
// it three hours in is an incident report. The start notice already existed and
// said only the name.

// --- start ---

@Test func startNoticeNamesTheRecordingAndTheLimit() {
    let n = recordingStartedNotice(name: "Day 1 keynote", maxDurationMinutes: 180)
    #expect(n.title == "Recording meeting")
    #expect(n.body.contains("Day 1 keynote"))
    #expect(n.body.contains("3h"))
    // The escape hatch stays, since it was the whole body before.
    #expect(n.body.contains("shyn meeting stop"))
}

@Test func startNoticeSurvivesAnEmptyName() {
    // sessionAppName can be empty for a manual start with no title and no
    // frontmost app worth naming; the limit must still be stated.
    let n = recordingStartedNotice(name: "", maxDurationMinutes: 180)
    #expect(n.body.contains("3h"))
    #expect(!n.body.hasPrefix(" —"), "leading separator with no name: \(n.body)")
}

// --- the cap ---

@Test func autoCallSaysItWillResumeItself() {
    let n = maxDurationNotice(manual: false, maxDurationMinutes: 180)
    #expect(n.title == "Recording stopped at 3h")
    #expect(n.body.contains("transcript"))
    #expect(n.body.lowercased().contains("resume"))
    #expect(!n.body.contains("start again"))
}

@Test func manualSessionSaysNothingResumes() {
    let n = maxDurationNotice(manual: true, maxDurationMinutes: 180)
    #expect(n.title == "Recording stopped at 3h")
    #expect(n.body.contains("transcript"))
    // A room cannot re-trigger the detector, so the user must act.
    #expect(n.body.contains("start again"))
    #expect(!n.body.lowercased().contains("will resume"))
}

@Test func capNoticeNamesTheConfigKeyThatMovesIt() {
    // The notice is the moment the user is actually thinking about this limit,
    // so it is the right place to say how to change it.
    for manual in [true, false] {
        let n = maxDurationNotice(manual: manual, maxDurationMinutes: 180)
        #expect(n.body.contains("maxDurationMinutes"), "manual=\(manual)")
    }
}

// --- shared duration wording ---

@Test func durationReadsAsHoursWhenItDividesCleanly() {
    #expect(capDurationText(180) == "3h")
    #expect(capDurationText(540) == "9h")
    #expect(capDurationText(60) == "1h")
}

@Test func durationReadsAsMinutesWhenItDoesNot() {
    // Someone who set 90 must not be told "1h".
    #expect(capDurationText(90) == "90 min")
    #expect(capDurationText(45) == "45 min")
    #expect(capDurationText(200) == "200 min")
}

@Test func startAndCapAgreeOnHowTheLimitIsWorded() {
    // Two notices, one limit. If they disagree the user thinks the setting
    // changed between them.
    for m in [45, 60, 90, 180, 540] {
        let text = capDurationText(m)
        #expect(recordingStartedNotice(name: "x", maxDurationMinutes: m).body.contains(text))
        #expect(maxDurationNotice(manual: true, maxDurationMinutes: m).title.contains(text))
    }
}
