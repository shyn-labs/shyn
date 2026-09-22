import Foundation

// When to prewarm Whisper (trigger Core ML's per-chip model specialization
// so the first real transcription does not pay ~90s for it). Once per model
// per process; only once the model is on disk and no session is live — the
// prewarm loads each model briefly, and a recording is the wrong moment for
// that memory spike. Pure, tested; the agent owns one.
public struct PrewarmGate: Sendable {
    private var inFlight: String? = nil
    private var done: Set<String> = []
    public init() {}

    public mutating func shouldKick(model: String, present: Bool, idle: Bool) -> Bool {
        guard present, idle, inFlight == nil, !done.contains(model) else { return false }
        inFlight = model
        return true
    }

    public mutating func finished(model: String) {
        if inFlight == model { inFlight = nil }
        done.insert(model)
    }
}
