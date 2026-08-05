import Testing
import Foundation
@testable import CaptureCore

private func tempRoot() throws -> URL {
    let root = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("pending-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
}

private func session(_ root: URL, _ name: String) throws -> URL {
    let dir = root.appendingPathComponent(name)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

@Test func pendingSidecarRoundTrips() throws {
    let root = try tempRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let dir = try session(root, "session-1000")
    let p = PendingSession(start: 1000, end: 1600, bundleId: "com.google.Chrome.app.x",
                           appName: "Google Meet", windowTitle: "Weekly Ops Review",
                           reason: "modelsUnavailable", attempts: 2)
    #expect(writePendingSession(p, in: dir))
    let read = readPendingSession(in: dir)
    #expect(read?.start == 1000)
    #expect(read?.end == 1600)
    #expect(read?.appName == "Google Meet")
    #expect(read?.windowTitle == "Weekly Ops Review")
    #expect(read?.reason == "modelsUnavailable")
    #expect(read?.attempts == 2)

    clearPendingSession(in: dir)
    #expect(readPendingSession(in: dir) == nil)
    // Clearing the sidecar must not touch the audio next to it.
    #expect(FileManager.default.fileExists(atPath: dir.path))
}

@Test func pendingSessionsListsOldestMeetingFirstAndIgnoresOthers() throws {
    let root = try tempRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let newer = try session(root, "session-2000")
    let older = try session(root, "session-1000")
    _ = try session(root, "session-3000")   // live/complete session, no sidecar
    #expect(writePendingSession(PendingSession(start: 2000, end: 2100, bundleId: nil,
                                              appName: "Zoom", windowTitle: nil,
                                              reason: "offline"), in: newer))
    #expect(writePendingSession(PendingSession(start: 1000, end: 1100, bundleId: nil,
                                              appName: "Meet", windowTitle: nil,
                                              reason: "offline"), in: older))
    let pending = pendingSessions(root: root)
    #expect(pending.count == 2)
    #expect(pending.first?.lastPathComponent == "session-1000")
    #expect(pending.last?.lastPathComponent == "session-2000")
}

@Test func pendingSessionsToleratesMissingRootAndGarbage() throws {
    let root = try tempRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let dir = try session(root, "session-1000")
    try "not json".write(to: dir.appendingPathComponent(pendingSidecarName),
                         atomically: true, encoding: .utf8)
    #expect(pendingSessions(root: root).isEmpty)
    #expect(pendingSessions(root: root.appendingPathComponent("nope")).isEmpty)
}

@Test func attemptsAreBounded() {
    // The retry loop reads attempts from the sidecar; the cap is what stops a
    // present-but-unusable model from re-transcribing forever.
    #expect(maxPendingAttempts >= 2)
    #expect(maxPendingAttempts <= 10)
}
