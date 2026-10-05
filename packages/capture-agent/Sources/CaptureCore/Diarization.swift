import Foundation

// Pure half of speaker diarization (spec 2026-10-05). Nothing here touches a
// model, so it is all testable; shyn-meeting/Diarizer.swift owns FluidAudio.

/// One stretch of one speaker, on the channel's own timeline (seconds).
public struct DiarizedTurn: Sendable, Equatable {
    public let speaker: Int
    public let start: Double
    public let end: Double
    public init(speaker: Int, start: Double, end: Double) {
        self.speaker = speaker; self.start = start; self.end = end
    }
}

/// Merges a speaker's consecutive turns separated by <= `gapSeconds`. Nemotron
/// splits one speaker at short pauses; on the AMI spike clip bridging 1.0s took
/// DER from 25.2% to 11.7%. Turns of OTHER speakers are left alone, so an
/// interjection inside the gap still exists; overlap is how real meetings sound.
public func bridgeTurns(_ turns: [DiarizedTurn], gapSeconds: Double = 1.0) -> [DiarizedTurn] {
    var bySpeaker: [Int: [DiarizedTurn]] = [:]
    for t in turns { bySpeaker[t.speaker, default: []].append(t) }
    var out: [DiarizedTurn] = []
    for (speaker, ts) in bySpeaker {
        let sorted = ts.sorted { $0.start < $1.start }
        var cur = sorted[0]
        for n in sorted.dropFirst() {
            if n.start - cur.end <= gapSeconds {
                cur = DiarizedTurn(speaker: speaker, start: cur.start, end: max(cur.end, n.end))
            } else { out.append(cur); cur = n }
        }
        out.append(cur)
    }
    return out.sorted { $0.start != $1.start ? $0.start < $1.start : $0.speaker < $1.speaker }
}

/// The speaker with the most active time inside [start, end); nil if none
/// overlaps. An exact tie goes to the lower index (Dictionary order is not
/// deterministic, and a label must not flip between two runs).
public func dominantSpeaker(start: Double, end: Double, turns: [DiarizedTurn]) -> Int? {
    var overlap: [Int: Double] = [:]
    for t in turns {
        let o = min(end, t.end) - max(start, t.start)
        if o > 0 { overlap[t.speaker, default: 0] += o }
    }
    return overlap.max { $0.value != $1.value ? $0.value < $1.value : $0.key > $1.key }?.key
}

/// Raw model index → 1-based label in order of first appearance, so
/// "Speaker 1" is whoever spoke first in this meeting.
public func arrivalOrder(_ turns: [DiarizedTurn]) -> [Int: Int] {
    var order: [Int: Int] = [:]
    for t in turns.sorted(by: { $0.start < $1.start }) where order[t.speaker] == nil {
        order[t.speaker] = order.count + 1
    }
    return order
}

/// One speaker's turns as (start, end) pairs in time order.
public func speechRanges(speaker: Int, turns: [DiarizedTurn]) -> [(Double, Double)] {
    turns.filter { $0.speaker == speaker }.sorted { $0.start < $1.start }.map { ($0.start, $0.end) }
}

public func l2normalized(_ v: [Float]) -> [Float] {
    let n = max(1e-9, v.reduce(0) { $0 + $1 * $1 }.squareRoot())
    return v.map { $0 / n }
}

public func cosine(_ a: [Float], _ b: [Float]) -> Float {
    var dot: Float = 0, na: Float = 0, nb: Float = 0
    for i in 0..<min(a.count, b.count) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
    return dot / max(1e-9, na.squareRoot() * nb.squareRoot())
}

public struct EmbeddingError: Error, CustomStringConvertible {
    public let description: String
    public init(description: String) { self.description = description }
}

/// WeSpeaker's Core ML model takes a FIXED 10 s input and silently truncates
/// longer audio (spike Embed.swift notes), so a speaker's speech is embedded in
/// `window`-sample pieces, each L2-normalised, then length-weighted and
/// renormalised. A tail shorter than `minTail` is dropped when there is other
/// material: a repeat-padded scrap would be dominated by its own repetition.
public func windowedMean(_ audio: [Float], window: Int, minTail: Int,
                         embed: ([Float]) throws -> [Float]) throws -> [Float] {
    var sum: [Float] = []
    var total: Float = 0
    var start = 0
    while start < audio.count {
        let end = min(audio.count, start + window)
        if end - start < minTail && start > 0 { break }
        let e = l2normalized(try embed(Array(audio[start..<end])))
        if sum.isEmpty { sum = [Float](repeating: 0, count: e.count) }
        let w = Float(end - start)
        for i in 0..<min(sum.count, e.count) { sum[i] += e[i] * w }
        total += w
        start = end
    }
    guard total > 0 else { throw EmbeddingError(description: "no audio to embed") }
    return l2normalized(sum)
}

/// Wire form of an embedding: base64 of little-endian float32 (spec, Data model).
public func encodeEmbedding(_ v: [Float]) -> String {
    var d = Data(capacity: v.count * 4)
    for f in v { withUnsafeBytes(of: f.bitPattern.littleEndian) { d.append(contentsOf: $0) } }
    return d.base64EncodedString()
}
