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

// Speaker labelling. `Me`/`Others` describes the two RECORDING CHANNELS, not
// two people, and the gap between those bites in both directions:
//
//   In-person (lived 2026-08-06): a 70-minute onboarding session came out
//   1,211 "Me:" against 31 "Others:", because everyone in the room arrived
//   through one microphone. The transcript asserted the user had said "My name
//   is Divesh". A reader — or an AI asked what the user said — gets it
//   badly wrong.
//
//   1:1 calls: the far side is exactly one known person, and the calendar
//   already tells us who. "Others:" throws that away.

/// How the far side should be named.
public enum FarSideLabel: Sendable, Equatable {
    /// Two real channels, far side unknown or several people: keep "Others".
    case others
    /// Exactly one known person on the far side — a 1:1.
    case named(String)
    /// The far-side channel carried nothing, so there was no call: every voice
    /// came through the mic and the two-channel split says nothing about who
    /// spoke. Asserting "Me" for all of it would be a claim we cannot support.
    case unattributed
}

/// `others` must be the attendees EXCLUDING the user — EKParticipant.isCurrentUser
/// is what identifies them, and a raw roster of two cannot say which name is the
/// far side.
///
/// Conservative on purpose. `unattributed` requires the far side to be
/// COMPLETELY empty — not merely quiet — because "I did almost all the talking
/// on a call" is a real and correctly-labelled case that must not be caught by
/// this. And `named` requires exactly one other participant: with two or more,
/// which of them is speaking is exactly what we cannot know without diarization.
public func farSideLabel(_ segments: [TranscriptSegment], others: [String]) -> FarSideLabel {
    guard !segments.isEmpty else { return .others }
    if !segments.contains(where: { $0.speaker == .others }) {
        // No far-side audio at all: there was no call, so the two-channel split
        // says nothing about who spoke.
        return .unattributed
    }
    if others.count == 1, !others[0].trimmingCharacters(in: .whitespaces).isEmpty {
        return .named(others[0])
    }
    return .others
}

public func assembleTranscript(_ segments: [TranscriptSegment],
                               farSide: FarSideLabel = .others) -> String {
    let ordered = dropEchoDuplicates(segments).sorted { $0.start < $1.start }
    switch farSide {
    case .unattributed:
        // No prefix at all. Dropping a correct "Me:" from a solo recording
        // costs little; asserting it over several people in a room is a false
        // statement about who said what.
        return ordered.map(\.text).joined(separator: "\n")
    case .named(let who):
        return ordered
            .map { "\($0.speaker == .others ? who : Speaker.me.rawValue): \($0.text)" }
            .joined(separator: "\n")
    case .others:
        return ordered
            .map { "\($0.speaker.rawValue): \($0.text)" }
            .joined(separator: "\n")
    }
}

/// One line explaining an unusual labelling, so a reader is told rather than
/// left to infer. nil when the ordinary two-channel labels apply.
public func speakerNote(_ farSide: FarSideLabel) -> String? {
    switch farSide {
    case .unattributed:
        return "Speaker labels unavailable: no far-side audio, so every voice "
             + "came through this Mac's microphone and cannot be told apart."
    case .named, .others:
        return nil
    }
}
