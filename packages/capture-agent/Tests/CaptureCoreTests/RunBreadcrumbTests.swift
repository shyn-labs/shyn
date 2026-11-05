import Testing
import Foundation
@testable import CaptureCore

private func tmpHome() -> String {
    let d = FileManager.default.temporaryDirectory.appendingPathComponent("shyn-rb-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    return d.path
}

@Test func firstRunIsNotACrash() {
    let h = tmpHome()
    #expect(RunBreadcrumb.begin(home: h, agent: "meeting") == false)
}

@Test func cleanExitLeavesNothingToReport() {
    let h = tmpHome()
    RunBreadcrumb.begin(home: h, agent: "meeting")
    RunBreadcrumb.end(home: h, agent: "meeting")
    #expect(RunBreadcrumb.begin(home: h, agent: "meeting") == false)
}

@Test func aRunThatNeverEndedIsReportedOnceThenCleared() {
    let h = tmpHome()
    RunBreadcrumb.begin(home: h, agent: "capture", pid: 111, isAlive: { _ in false })
    #expect(RunBreadcrumb.begin(home: h, agent: "capture", pid: 222, isAlive: { _ in false }) == true)
    RunBreadcrumb.end(home: h, agent: "capture")
    #expect(RunBreadcrumb.begin(home: h, agent: "capture", pid: 333, isAlive: { _ in false }) == false)
}

@Test func aBreadcrumbWhosePidIsStillAliveIsAnotherInstanceNotACrash() {
    let h = tmpHome()
    RunBreadcrumb.begin(home: h, agent: "meeting", pid: 111, isAlive: { _ in true })
    #expect(RunBreadcrumb.begin(home: h, agent: "meeting", pid: 222, isAlive: { $0 == 111 }) == false)
}

@Test func agentsDoNotShareABreadcrumb() {
    let h = tmpHome()
    RunBreadcrumb.begin(home: h, agent: "capture", pid: 111, isAlive: { _ in false })
    #expect(RunBreadcrumb.begin(home: h, agent: "meeting", pid: 222, isAlive: { _ in false }) == false)
}

@Test func garbageInTheFileCountsAsDeadRun() {
    let h = tmpHome()
    try? "not a pid".write(toFile: RunBreadcrumb.path(home: h, agent: "meeting"), atomically: true, encoding: .utf8)
    #expect(RunBreadcrumb.begin(home: h, agent: "meeting") == true)
}

// The handler clears the breadcrumb and exits on SIGTERM while the caller's
// thread is blocked. This does NOT prove the main-queue starvation fix: the
// test thread is not the main thread, so a main-queue source could pass it too.
// That failure mode is only visible with the real agent under NSApplication.run(),
// i.e. the fake-daemon gate (scratchpad gate-agent-crashed.sh).
@Test func sigtermRemovesTheBreadcrumbAndExitsEvenWhileTheCallerIsBlocked() {
    let h = tmpHome()
    RunBreadcrumb.begin(home: h, agent: "meeting")
    final class Flag: @unchecked Sendable { var code: Int32? }
    let flag = Flag()
    RunBreadcrumb.endOnTerminate(home: h, agent: "meeting") { flag.code = $0 }
    raise(SIGTERM)
    let deadline = Date().addingTimeInterval(2)
    while flag.code == nil && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }   // blocks this thread
    #expect(flag.code == 0)
    #expect(!FileManager.default.fileExists(atPath: RunBreadcrumb.path(home: h, agent: "meeting")))
}
