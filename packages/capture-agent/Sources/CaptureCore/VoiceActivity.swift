import Foundation

// Sustain-based voice-likeness for one audio channel. Live-verification
// finding (2026-07-11): peak-blip detection ("any buffer above threshold in
// the last N seconds") kept meetings recording indefinitely — keyboard
// clicks near the mic and stray system sounds each read as activity, and a
// phantom meeting was detected from ambient noise. Speech (and, accepted
// limitation, music) holds level above threshold CONTINUOUSLY for hundreds
// of milliseconds; clicks and dings are isolated ~10-30ms transients that
// never sustain. A channel becomes "voiced" only after level >= threshold
// without interruption for sustainSeconds.
//
// Feed it per-buffer RMS levels (NOT peaks — a 5ms click dominates a peak
// but contributes little RMS) with their capture timestamps. Pure value
// type; the agent wraps two of these behind a lock (mic + system).
public struct VoiceActivity: Sendable {
    public let threshold: Float
    public let sustainSeconds: Double
    private var streakStart: Double? = nil   // when the current above-threshold run began
    private var lastVoiced: Double? = nil    // last time a sustained run was confirmed

    public init(threshold: Float = 0.01, sustainSeconds: Double = 0.25) {
        self.threshold = threshold
        self.sustainSeconds = sustainSeconds
    }

    public mutating func observe(level: Float, at now: Double) {
        guard level >= threshold else { streakStart = nil; return }
        let start = streakStart ?? now
        streakStart = start
        if now - start >= sustainSeconds { lastVoiced = now }
    }

    public func activeWithin(_ seconds: Double, at now: Double) -> Bool {
        guard let t = lastVoiced else { return false }
        return now - t <= seconds
    }
}
