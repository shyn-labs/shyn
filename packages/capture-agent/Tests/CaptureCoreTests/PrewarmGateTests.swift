import Testing
@testable import CaptureCore

// The first transcription after every upgrade paid ~90s for macOS to
// specialize the CoreML models to this chip (2026-09-22: a 10-second
// recording took 1m41s; the same file 15s on the next run). Prewarming at
// agent startup moves that cost off the first meeting. Once per model per
// process, only when the model is on disk and nothing is recording.

@Test func prewarmsOncePerModelWhenPresentAndIdle() {
    var g = PrewarmGate()
    #expect(g.shouldKick(model: "large-v3_turbo", present: true, idle: true) == true)
    #expect(g.shouldKick(model: "large-v3_turbo", present: true, idle: true) == false)   // in flight
    g.finished(model: "large-v3_turbo")
    #expect(g.shouldKick(model: "large-v3_turbo", present: true, idle: true) == false)   // done
    // A model switch in the popover is a new set of files to specialize.
    #expect(g.shouldKick(model: "small", present: true, idle: true) == true)
}

@Test func prewarmWaitsForTheModelAndForIdle() {
    var g = PrewarmGate()
    #expect(g.shouldKick(model: "small", present: false, idle: true) == false)   // still downloading
    #expect(g.shouldKick(model: "small", present: true, idle: false) == false)   // a call is live
    #expect(g.shouldKick(model: "small", present: true, idle: true) == true)
}
