import Testing
import Foundation
@testable import CaptureCore

private func ev(_ text: String, title: String = "Doc — Notes", ts: Int = 1_783_000_000)
    -> CaptureEvent {
    CaptureEvent(bundleId: "com.apple.TextEdit", appName: "TextEdit",
                 windowTitle: title, text: text, ts: ts)
}

@Test func unchangedTextIsDroppedSecondTime() {
    var state = PipelineState()
    let text = String(repeating: "same screen content ", count: 10)
    #expect(decide(event: ev(text), config: .defaults, state: &state, secureInput: false) != nil)
    #expect(decide(event: ev(text, ts: 1_783_000_030), config: .defaults,
                   state: &state, secureInput: false) == nil)
    #expect(state.stats.skips["unchanged"] == 1)
}

@Test func payloadShapeAndBucketing() {
    var state = PipelineState()
    let p = decide(event: ev(String(repeating: "text ", count: 30)),
                   config: .defaults, state: &state, secureInput: false)!
    #expect(p.source == "screen")
    #expect(p.uri.hasPrefix("screen://com.apple.TextEdit/"))
    #expect(p.title == "TextEdit — Doc — Notes")
    #expect(p.meta["method"] == "ax")
    #expect(state.stats.captures == 1 && state.stats.method.ax == 1)
}

@Test func gatedEventCountsSkipNotCapture() {
    var state = PipelineState()
    let e = CaptureEvent(bundleId: "com.1password.1password", appName: "1Password",
                         windowTitle: "Vault", text: "supersecret", ts: 0)
    #expect(decide(event: e, config: .defaults, state: &state, secureInput: false) == nil)
    #expect(state.stats.skips["excludedApp"] == 1 && state.stats.captures == 0)
}

@Test func shortTextSkipsAsEmpty() {
    var state = PipelineState()
    #expect(decide(event: ev("tiny"), config: .defaults, state: &state, secureInput: false) == nil)
    #expect(state.stats.skips["empty"] == 1)
}
