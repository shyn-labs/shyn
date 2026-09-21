import Testing
@testable import CaptureCore

// The agent posts ONE state string and the popover keys everything on it:
// the live card and its Stop button need "recording", the Start recording
// offer needs the recorder to be free. Until 2026-09-21 the string was the
// detector's state, so a manual room recording posted "idle" (the detector
// never saw it) and a recording that overlapped a running transcription
// posted "transcribing". Both hid Stop; the second also hid Start for the
// half hour after every meeting.

@Test func aLiveSessionReportsRecordingWhateverElseIsHappening() {
    #expect(reportedMeetingState(detector: .recording, manualLive: false, pendingTranscriptions: 0) == "recording")
    // Manual room recording: the detector is idle and does not know.
    #expect(reportedMeetingState(detector: .idle, manualLive: true, pendingTranscriptions: 0) == "recording")
    // Recording started while the last meeting is still transcribing.
    #expect(reportedMeetingState(detector: .recording, manualLive: false, pendingTranscriptions: 1) == "recording")
    #expect(reportedMeetingState(detector: .idle, manualLive: true, pendingTranscriptions: 2) == "recording")
}

@Test func transcriptionShowsOnlyWhenNothingIsRecording() {
    #expect(reportedMeetingState(detector: .idle, manualLive: false, pendingTranscriptions: 1) == "transcribing")
    #expect(reportedMeetingState(detector: .candidate, manualLive: false, pendingTranscriptions: 1) == "transcribing")
}

@Test func otherwiseTheDetectorSpeaks() {
    #expect(reportedMeetingState(detector: .idle, manualLive: false, pendingTranscriptions: 0) == "idle")
    #expect(reportedMeetingState(detector: .candidate, manualLive: false, pendingTranscriptions: 0) == "candidate")
    #expect(reportedMeetingState(detector: .ended, manualLive: false, pendingTranscriptions: 0) == "ended")
}
