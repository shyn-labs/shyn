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

public func diarizationPlan(enabled: Bool, modelsReady: Bool,
                            segments: [TranscriptSegment]) -> DiarizationPlan {
    guard enabled else { return .skip("off") }
    guard !segments.isEmpty else { return .skip("no speech") }
    guard modelsReady else { return .skip("model not ready") }
    return segments.contains(where: { $0.speaker == .others }) ? .diarize(.others) : .diarize(.me)
}
