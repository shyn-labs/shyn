import Testing
import Foundation
@testable import shyn_capture
@testable import CaptureCore

// The daemon calls the screen agent "reporting" when a stats post landed
// within two heartbeat windows. The agent posted stats only inside ship(),
// so after any restart it read as dead until it happened to capture
// something — and a terminal in front (excluded app), a locked screen, or
// an idle desk all capture nothing. Three times that looked like a broken
// install to someone reading `shyn diagnose`. Alive and capturing are
// different facts; the heartbeat carries the first one.

final class RecordingSink: CaptureSink, @unchecked Sendable {
    var ingested: [IngestPayload] = []
    var posted: [Stats] = []
    func ingest(_ p: IngestPayload) async throws { ingested.append(p) }
    func postStats(_ s: Stats) async throws { posted.append(s) }
}

private func env(locked: Bool = false, idle: Double = 0, front: FrontWindow? = nil,
                 ax: Bool = true, screen: Bool = true) -> AgentEnv {
    AgentEnv(isScreenLocked: { locked }, idleSeconds: { idle }, frontWindow: { front },
             isSecureInputActive: { false }, axTrusted: { ax }, screenGranted: { screen })
}

@Test func startPostsStatsBeforeAnyCapture() async {
    let sink = RecordingSink()
    let agent = Agent(sink: sink, configPath: "/nonexistent/capture.json", env: env())
    await agent.start()
    #expect(sink.posted.count == 1)
    #expect(sink.ingested.isEmpty)
}

@Test func aTickOnALockedScreenStillPostsStats() async {
    let sink = RecordingSink()
    let agent = Agent(sink: sink, configPath: "/nonexistent/capture.json", env: env(locked: true))
    await agent.tick()
    #expect(sink.posted.count == 1)
    #expect(sink.ingested.isEmpty)
}

@Test func aTickWithNothingInFrontStillPostsStats() async {
    let sink = RecordingSink()
    let agent = Agent(sink: sink, configPath: "/nonexistent/capture.json", env: env(front: nil))
    await agent.tick()
    #expect(sink.posted.count == 1)
}

@Test func theHeartbeatCarriesFreshPermissionReads() async {
    let sink = RecordingSink()
    let agent = Agent(sink: sink, configPath: "/nonexistent/capture.json",
                      env: env(locked: true, ax: false, screen: true))
    await agent.tick()
    #expect(sink.posted.last?.tcc?.ax == false)
    #expect(sink.posted.last?.tcc?.screen == true)
}

@Test func theDebounceStillHoldsBetweenBackToBackTicks() async {
    // Two ticks inside the 2s debounce are one observation, and one heartbeat.
    let sink = RecordingSink()
    let agent = Agent(sink: sink, configPath: "/nonexistent/capture.json", env: env(locked: true))
    await agent.tick(); await agent.tick()
    #expect(sink.posted.count == 1)
}
