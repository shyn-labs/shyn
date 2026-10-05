import Foundation

/// Whether, and which channel, to diarize after Whisper. Calls diarize the far
/// side only (the mic stays Me, since a hybrid room on one mic is a stated v1
/// limit); a session with no far-side speech diarizes the mic.
public enum DiarizationPlan: Equatable, Sendable {
    case skip(String)
    case diarize(Speaker)
}

/// A call contributes a self-sample only with this much voiced mic speech.
public let selfSampleMinSeconds: Double = 30

/// `crashedLastAttempt`: the session carries a diarizing breadcrumb, so the
/// previous run died inside the diarizer (native crash, jetsam, trap), which
/// never reaches keepForRetry. Without this the restarted agent would re-pick the
/// same session first and crash again, blocking every other pending session.
public func diarizationPlan(enabled: Bool, modelsReady: Bool,
                            segments: [TranscriptSegment],
                            crashedLastAttempt: Bool) -> DiarizationPlan {
    guard enabled else { return .skip("off") }
    guard !segments.isEmpty else { return .skip("no speech") }
    guard modelsReady else { return .skip("model not ready") }
    guard !crashedLastAttempt else { return .skip("crashed last attempt") }
    return segments.contains(where: { $0.speaker == .others }) ? .diarize(.others) : .diarize(.me)
}

// Breadcrumb in the session dir, written just before diarization and removed
// right after it returns. If it is still there on entry, the last run never
// came back from the diarizer. It is deleted with the rest of the session dir.
public let diarizingBreadcrumbName = "diarizing"

public func diarizingBreadcrumbExists(in dir: URL) -> Bool {
    FileManager.default.fileExists(atPath: dir.appendingPathComponent(diarizingBreadcrumbName).path)
}

public func markDiarizing(in dir: URL) {
    try? Data().write(to: dir.appendingPathComponent(diarizingBreadcrumbName), options: .atomic)
}

public func clearDiarizingBreadcrumb(in dir: URL) {
    try? FileManager.default.removeItem(at: dir.appendingPathComponent(diarizingBreadcrumbName))
}
