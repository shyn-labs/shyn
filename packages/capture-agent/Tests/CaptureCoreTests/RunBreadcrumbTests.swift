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
