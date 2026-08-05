import Foundation

// Post-decode transcript filtering. Whisper hallucinates filler on silence
// ("you", "Thank you.", "*Humming*") and we transcribe whole channels
// including silence, because WhisperKit's .vad returned ZERO segments on our
// two-channel WAVs (commit 0190c56). So the cleanup happens after decode.
//
// Thresholds are constants, not config: these are decoder-quality values, not
// user preferences. noSpeechProb/avgLogprob/compressionRatio are OpenAI's
// reference fallback signals; 2.4 is their published compression threshold.

/// The decoder-confidence fields we care about, lifted out of WhisperKit's
/// TranscriptionSegment so this file — and its tests — never link WhisperKit.
public struct SegmentQuality: Sendable {
    public let noSpeechProb: Float
    public let avgLogprob: Float
    public let compressionRatio: Float
    public init(noSpeechProb: Float, avgLogprob: Float, compressionRatio: Float) {
        self.noSpeechProb = noSpeechProb
        self.avgLogprob = avgLogprob
        self.compressionRatio = compressionRatio
    }
}

public enum TranscriptFilterLimits {
    public static let maxNoSpeechProb: Float = 0.6
    public static let minAvgLogprob: Float = -1.0
    public static let maxCompressionRatio: Float = 2.4
    public static let maxRepeatRun = 3
}

/// False for anything that looks like decoder noise rather than speech.
/// Length is deliberately NOT a signal — "No." is a complete answer.
public func passesQualityGates(_ q: SegmentQuality) -> Bool {
    q.noSpeechProb <= TranscriptFilterLimits.maxNoSpeechProb
        && q.avgLogprob >= TranscriptFilterLimits.minAvgLogprob
        && q.compressionRatio <= TranscriptFilterLimits.maxCompressionRatio
}

// Whisper marks non-speech stretches with wrapped annotations — "[BLANK_AUDIO]",
// "[Pause]", "(music)", and asterisk forms like "*Humming*" / "*ding*" that the
// original bracket-only check let straight through.
public func isNonSpeechAnnotation(_ text: String) -> Bool {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard t.count >= 2 else { return false }
    return (t.hasPrefix("[") && t.hasSuffix("]"))
        || (t.hasPrefix("(") && t.hasSuffix(")"))
        || (t.hasPrefix("*") && t.hasSuffix("*"))
}

/// Drop runs where the same normalised text repeats in more than
/// `maxRepeatRun` CONSECUTIVE segments. The whole run goes, not a trimmed
/// remainder: 40 "you" segments are an artefact in full, and keeping three of
/// them would still corrupt the transcript. Runs of three or fewer survive, so
/// a genuine "yes. yes. yes." is untouched.
public func collapseRepeats(_ segments: [TranscriptSegment]) -> [TranscriptSegment] {
    func key(_ s: TranscriptSegment) -> String {
        s.text.lowercased()
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: ".,!?;: "))
    }
    var out: [TranscriptSegment] = []
    var run: [TranscriptSegment] = []
    func flush() {
        if run.count <= TranscriptFilterLimits.maxRepeatRun { out += run }
        run.removeAll()
    }
    for s in segments {
        if let last = run.last, key(last) == key(s) { run.append(s) }
        else { flush(); run = [s] }
    }
    flush()
    return out
}
