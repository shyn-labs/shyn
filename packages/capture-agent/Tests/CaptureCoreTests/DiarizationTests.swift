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

// Review: on speakers without echo cancellation the far side bleeds into the mic, and one
// contaminated self-sample can later give a false Me. Mic speech that overlaps any far-side
// turn is not the user's alone, so it must not reach the self-sample.
private func pieces(_ r: [(Double, Double)]) -> [[Double]] { r.map { [$0.0, $0.1] } }
private func vc(_ a: Double, _ b: Double) -> VoicedChunk { VoicedChunk(startSec: a, endSec: b) }

@Test func excludingOverlapKeepsChunksThatNothingOverlaps() {
    let out = excludingOverlap([vc(0, 5), vc(10, 12)], turns: [t(0, 6, 9), t(1, 20, 30)])
    #expect(pieces(out) == [[0, 5], [10, 12]])
}

@Test func excludingOverlapDropsAFullyCoveredChunk() {
    let out = excludingOverlap([vc(2, 4), vc(10, 12)], turns: [t(0, 1, 5)])
    #expect(pieces(out) == [[10, 12]])
}

@Test func excludingOverlapTrimsBothEnds() {
    let out = excludingOverlap([vc(2, 10)], turns: [t(0, 0, 4), t(1, 8, 12)])
    #expect(pieces(out) == [[4, 8]])
}

@Test func excludingOverlapSplitsAChunkAroundATurnInTheMiddle() {
    let out = excludingOverlap([vc(0, 10)], turns: [t(0, 4, 6)])
    #expect(pieces(out) == [[0, 4], [6, 10]])
}

@Test func excludingOverlapHandlesOverlappingAndUnsortedTurns() {
    let out = excludingOverlap([vc(0, 10)], turns: [t(1, 6, 8), t(0, 2, 7), t(1, 1, 3)])
    #expect(pieces(out) == [[0, 1], [8, 10]])
}

@Test func excludingOverlapWithNoTurnsIsTheIdentity() {
    #expect(pieces(excludingOverlap([vc(1, 2)], turns: [])) == [[1, 2]])
}
