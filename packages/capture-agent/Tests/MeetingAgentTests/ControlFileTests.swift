import Testing
import Foundation
@testable import shyn_meeting
@testable import CaptureCore

// First tests to reach INSIDE shyn-meeting. Until Entry.swift moved the
// process entry behind @main, this module could not be imported at all, so
// 1,600 lines of meeting lifecycle were untestable by construction — which is
// how the title ladder shipped broken for a week and how consumeMeetingControl
// went from Task 10 to September with no coverage.
//
// consumeMeetingControl is the natural first subject: it is the file IO half
// of the control channel (parseMeetingControl in CaptureCore is the other),
// and its delete-before-parse behaviour is load-bearing in a way no parser
// test can show.

private func tempHome() -> String {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("shyn-ctl-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.path
}

private func writeControl(_ home: String, _ json: String) {
    try? json.write(toFile: home + "/meeting-control.json", atomically: true, encoding: .utf8)
}

private func controlExists(_ home: String) -> Bool {
    FileManager.default.fileExists(atPath: home + "/meeting-control.json")
}

@Test func consumesAndDeletesAValidControl() {
    let home = tempHome()
    writeControl(home, #"{"action":"start","title":"Field team standup","ts":1}"#)
    let got = consumeMeetingControl(home: home)
    #expect(got == MeetingControl(action: .start, title: "Field team standup"))
    // One-shot: a control that survived the read would re-fire every tick.
    #expect(controlExists(home) == false)
}

@Test func deletesAnUnparseableControlToo() {
    // Delete-before-parse. Garbage that stayed on disk would be re-read every
    // tick forever — a poison pill in the agent's hot loop.
    let home = tempHome()
    writeControl(home, "this is not json")
    #expect(consumeMeetingControl(home: home) == nil)
    #expect(controlExists(home) == false)
}

@Test func deletesAControlWithAVerbThisAgentPredates() {
    // A newer CLI writing a verb this build does not know must not wedge it.
    let home = tempHome()
    writeControl(home, #"{"action":"pause-recording","ts":1}"#)
    #expect(consumeMeetingControl(home: home) == nil)
    #expect(controlExists(home) == false)
}

@Test func absentControlIsSimplyNothing() {
    let home = tempHome()
    #expect(consumeMeetingControl(home: home) == nil)
}

@Test func stopAndCancelRoundTripThroughTheFile() {
    let home = tempHome()
    writeControl(home, #"{"action":"stop","ts":1}"#)
    #expect(consumeMeetingControl(home: home)?.action == .stop)
    writeControl(home, #"{"action":"cancel","ts":1}"#)
    #expect(consumeMeetingControl(home: home)?.action == .cancel)
}
