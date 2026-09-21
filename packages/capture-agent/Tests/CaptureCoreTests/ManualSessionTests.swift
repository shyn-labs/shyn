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
