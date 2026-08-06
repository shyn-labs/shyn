import Foundation

// Post-decode transcript filtering. Whisper hallucinates filler on near-silence
// ("you", "Thank you.", "*Humming*") and we transcribe whole channels including
// silence, because WhisperKit's .vad returned ZERO segments on our two-channel
// WAVs (commit 0190c56). So the cleanup happens after decode.
//
// REMOVED in 0.4.22: three per-segment "quality gates" on noSpeechProb,
// avgLogprob and compressionRatio, shipped in 0.4.18. They never rejected a
// single segment across three real runs (a 3-min mock, a 70-min meeting, and a
// 349-segment session), and probing WhisperKit 0.18.0 directly showed why:
//
//   noSpeech=0.0000  logprob=-0.1557  compression=2.0000  | The quarterly review starts now.
//   noSpeech=0.0000  logprob=-0.1557  compression=2.0000  | Retention improved by four points.
//
// noSpeechProb is always 0, so `0 <= 0.6` passed everything. avgLogprob and
// compressionRatio are IDENTICAL across every segment — they are result-level
// values replicated onto segments, not per-segment measurements — so a
// per-segment threshold on them is meaningless: all segments pass together or
// all fail together. A gate that can only ever delete the entire channel is a
// cliff, not a filter. Three gates implying protection they cannot provide are
// worse than none, so they are gone.
//
// What actually works, and is kept: isNonSpeechAnnotation (wrapped annotations)
// and collapseRepeats (114 runs collapsed on the 70-minute meeting), plus
// dropEchoDuplicates in TranscriptAssembler (5 mic echoes dropped in the mock).

public enum TranscriptFilterLimits {
    public static let maxRepeatRun = 3
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
