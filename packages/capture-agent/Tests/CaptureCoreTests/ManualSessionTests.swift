import Testing
@testable import CaptureCore

// A manual recording exists because shyn could not hear the meeting itself:
// a room, a speakerphone, a talk. There is no app. Until 2026-09-21 the
// pre-roll filed it under whatever was frontmost when the user clicked Start —
// WhatsApp once, the menu bar app itself twice.

@Test func manualSessionWithNoConferencingHolderHasNoApp() {
    let app = manualSessionApp(holder: nil, frontmost: (bundleId: "net.whatsapp.WhatsApp", name: "WhatsApp"))
    #expect(app.bundleId == nil)
    #expect(app.name == "Recording")
}

@Test func manualSessionKeepsTheAppThatActuallyHoldsCallAudio() {
    // Manual start during a Zoom call the detector missed: the holder is real evidence.
    let app = manualSessionApp(holder: "us.zoom.xos", frontmost: (bundleId: "us.zoom.xos", name: "zoom.us"))
    #expect(app.bundleId == "us.zoom.xos")
    #expect(app.name == "zoom.us")
}

@Test func typedAttendeesBeatTheCalendarRosterAndFallBackToIt() {
    #expect(meetingAttendees(manual: ["Maya R"], calendar: ["Dev P", "Sam K"]) == ["Maya R"])
    #expect(meetingAttendees(manual: [], calendar: ["Dev P", "Sam K"]) == ["Dev P", "Sam K"])
}

// A manual recording owns the recorder. On 2026-10-05 the detector, still
// stepping underneath one, went idle → candidate 55s into an in-person
// recording and called startPreroll a second time: the recorder ignored the
// second start, but committed was reset, so the commit gate saw mic voice with
// no system audio and purged the "phantom" — ending the user's recording.
@Test func aLiveManualSessionIgnoresEveryDetectorTransition() {
    let transitions: [(MeetingState, MeetingState)] = [
        (.idle, .candidate), (.candidate, .recording), (.recording, .ended),
        (.candidate, .idle), (.ended, .idle), (.recording, .recording),
    ]
    for (prev, state) in transitions {
        #expect(detectorAction(prev: prev, state: state, manualLive: true) == .none,
                "\(prev) → \(state) acted on a live manual session")
    }
}

@Test func withoutAManualSessionTheDetectorStillDrivesRecording() {
    #expect(detectorAction(prev: .idle, state: .candidate, manualLive: false) == .startPreroll)
    #expect(detectorAction(prev: .ended, state: .candidate, manualLive: false) == .startPreroll)
    #expect(detectorAction(prev: .candidate, state: .candidate, manualLive: false) == .none)
    #expect(detectorAction(prev: .candidate, state: .idle, manualLive: false) == .discardPreroll)
    #expect(detectorAction(prev: .recording, state: .ended, manualLive: false) == .endSession)
    #expect(detectorAction(prev: .candidate, state: .recording, manualLive: false) == .none)
}
