import Foundation

public enum Speaker: String, Sendable { case me = "Me", others = "Others" }

public struct TranscriptSegment: Sendable {
    public let start: Double
    public let speaker: Speaker
    public let text: String
    public init(start: Double, speaker: Speaker, text: String) {
        self.start = start; self.speaker = speaker; self.text = text
    }
}

// Echo-duplicate suppression (live finding 2026-08-04, first real bleed
// transcript): on laptop speakers the mic hears the far end, so the SAME
// utterance lands in both channels and half of it comes out labeled "Me" —
// the transcript then asserts the user said things they only heard. AEC at
// capture (AudioRecorder voice processing) is the root-cause fix; this is the
// net for whatever residue it leaves, and for machines where it is refused.
//
// Directional on purpose: the system tap records other processes' OUTPUT,
// which cannot contain the user's own voice, so when the two channels agree
// the mic copy is the echo and the system copy is the truth.
//
// Knobs tuned against that transcript — Whisper rewords across channels
// ("trying to do it for the old years" vs "doing this for the past years"),
// so this compares token SETS by overlap coefficient (0.70 on that pair)
// rather than Jaccard (0.43 — would have missed it).
let echoWindowSeconds = 2.5
let echoOverlapThreshold = 0.6
// Short affirmations ("yes", "mm-hmm") collide constantly between two people
// who genuinely both said them. Leaving that noise in beats deleting real
// speech, so dedupe only considers segments carrying actual content.
let echoMinTokens = 4

func normalizedTokens(_ text: String) -> Set<String> {
    let keep = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "'"))
    return Set(text.lowercased()
        .components(separatedBy: keep.inverted)
        .filter { !$0.isEmpty })
}

// |A ∩ B| / min(|A|, |B|) — tolerant of one channel transcribing more words
// than the other, which is exactly what happens to a quieter echo.
func overlapCoefficient(_ a: Set<String>, _ b: Set<String>) -> Double {
    guard !a.isEmpty, !b.isEmpty else { return 0 }
    return Double(a.intersection(b).count) / Double(min(a.count, b.count))
}

public func dropEchoDuplicates(_ segments: [TranscriptSegment]) -> [TranscriptSegment] {
    let others = segments.filter { $0.speaker == .others }.sorted { $0.start < $1.start }
    guard !others.isEmpty else { return segments }
    let otherTokens = others.map { normalizedTokens($0.text) }

    // Mic segments walked in time order so the system-channel window only ever
    // advances (single sweep, not an n×m scan of a three-hour meeting).
    let micIndices = segments.indices
        .filter { segments[$0].speaker == .me }
        .sorted { segments[$0].start < segments[$1].start }
    var windowStart = 0
    var echoes = Set<Int>()
    for i in micIndices {
        let seg = segments[i]
        let tokens = normalizedTokens(seg.text)
        guard tokens.count >= echoMinTokens else { continue }
        while windowStart < others.count,
              others[windowStart].start < seg.start - echoWindowSeconds { windowStart += 1 }
        var j = windowStart
        while j < others.count, others[j].start <= seg.start + echoWindowSeconds {
            if otherTokens[j].count >= echoMinTokens,
               overlapCoefficient(tokens, otherTokens[j]) >= echoOverlapThreshold {
                echoes.insert(i)
                break
            }
            j += 1
        }
    }
    guard !echoes.isEmpty else { return segments }
    return segments.enumerated().filter { !echoes.contains($0.offset) }.map(\.element)
}

public func assembleTranscript(_ segments: [TranscriptSegment]) -> String {
    dropEchoDuplicates(segments)
        .sorted { $0.start < $1.start }
        .map { "\($0.speaker.rawValue): \($0.text)" }
        .joined(separator: "\n")
}
