import Testing
import Foundation
@testable import CaptureCore

private func t(_ s: Int, _ a: Double, _ b: Double) -> DiarizedTurn { DiarizedTurn(speaker: s, start: a, end: b) }

@Test func bridgingMergesShortSameSpeakerGapsOnly() {
    // Spike, AMI ES2004a: the model splits a speaker at short pauses; bridging 1.0s
    // took DER 25.2% → 11.7%. A different speaker in the gap must not be swallowed.
    let turns = [t(0, 0, 2), t(0, 2.6, 4), t(1, 4.2, 5), t(0, 7, 8)]
    #expect(bridgeTurns(turns) == [t(0, 0, 4), t(1, 4.2, 5), t(0, 7, 8)])
}

@Test func bridgingKeepsOverlappingSpeakersApart() {
    let turns = [t(0, 0, 3), t(1, 2, 4), t(0, 3.8, 6)]
    #expect(bridgeTurns(turns) == [t(0, 0, 6), t(1, 2, 4)])
}

@Test func dominantSpeakerIsWhoeverTalkedLongestInsideTheSpan() {
    let turns = [t(0, 0, 3), t(1, 2, 10)]
    #expect(dominantSpeaker(start: 1, end: 6, turns: turns) == 1)   // speaker 1: 4s, speaker 0: 2s
    #expect(dominantSpeaker(start: 0, end: 2.5, turns: turns) == 0)
}

@Test func anExactTieGoesToTheLowerSpeaker() {
    let turns = [t(1, 0, 1), t(0, 1, 2)]
    #expect(dominantSpeaker(start: 0, end: 2, turns: turns) == 0)
}

@Test func aSpanWithNoTurnHasNoSpeaker() {
    #expect(dominantSpeaker(start: 5, end: 6, turns: [t(0, 0, 1)]) == nil)
}

@Test func labelsFollowFirstArrivalNotModelIndex() {
    // Nemotron's index is arbitrary; "Speaker 1" must be whoever spoke first.
    let turns = [t(3, 5, 6), t(1, 0, 1), t(3, 2, 3)]
    #expect(arrivalOrder(turns) == [1: 1, 3: 2])
}

@Test func speechRangesAreOneSpeakersTurnsInOrder() {
    let turns = [t(0, 4, 5), t(1, 0, 1), t(0, 0.5, 2)]
    let r = speechRanges(speaker: 0, turns: turns)
    #expect(r.map(\.0) == [0.5, 4]); #expect(r.map(\.1) == [2, 5])
}

@Test func windowedMeanWeightsByLengthAndDropsATinyTail() throws {
    // Two full windows embed to orthogonal unit vectors; a 1-sample tail is dropped.
    var calls = 0
    let v = try windowedMean([Float](repeating: 0, count: 21), window: 10, minTail: 2) { _ in
        calls += 1; return calls == 1 ? [1, 0] : [0, 1]
    }
    #expect(calls == 2)
    #expect(abs(v[0] - v[1]) < 1e-6)
    #expect(abs(v[0] * v[0] + v[1] * v[1] - 1) < 1e-5)
}

@Test func windowedMeanOfNothingThrows() {
    #expect(throws: (any Error).self) { _ = try windowedMean([], window: 10, minTail: 2) { _ in [1] } }
}

@Test func cosineOfANormalisedVectorWithItselfIsOne() {
    let v = l2normalized([3, 4])
    #expect(abs(cosine(v, v) - 1) < 1e-6)
    #expect(abs(cosine([1, 0], [0, 1])) < 1e-6)
}

@Test func embeddingsEncodeAsLittleEndianFloat32Base64() {
    // 1.0f = 0x3F800000 → bytes 00 00 80 3F
    #expect(encodeEmbedding([1]) == Data([0, 0, 0x80, 0x3F]).base64EncodedString())
}
