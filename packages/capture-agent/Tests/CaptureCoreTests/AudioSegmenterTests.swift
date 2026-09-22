import Testing
import Foundation
@testable import CaptureCore

// Whisper was decoding every second of both channels, half of which is the
// other person talking — silence on this channel. A 52-minute call
// took 24m53s awake (2026-09-21). The segmenter keeps only voiced stretches
// (padded, merged across short gaps, capped at Whisper's 30s window) so the
// decoder sees speech, and sees it in chunks it can run concurrently.

private let SR = 16_000
private func silence(_ sec: Double) -> [Float] { [Float](repeating: 0, count: Int(sec * Double(SR))) }
private func tone(_ sec: Double, amp: Float = 0.2) -> [Float] {
    (0..<Int(sec * Double(SR))).map { amp * sin(Float($0) * 2 * .pi * 220 / Float(SR)) }
}
private func approx(_ a: Double, _ b: Double, tol: Double = 0.06) -> Bool { abs(a - b) <= tol }

@Test func silenceYieldsNoChunks() {
    #expect(voicedChunks(samples: silence(20), sampleRate: SR).isEmpty)
}

@Test func voicedStretchesArePaddedAndCloseGapsAreMerged() {
    // 10.0–12.0 speech, 0.5s gap, 12.5–14.0 speech, long silence, 40.0–41.0 speech.
    let audio = silence(10) + tone(2) + silence(0.5) + tone(1.5) + silence(26) + tone(1) + silence(19)
    let c = voicedChunks(samples: audio, sampleRate: SR)
    #expect(c.count == 2)
    #expect(approx(c[0].startSec, 9.6) && approx(c[0].endSec, 14.4))   // merged, padded 0.4s
    #expect(approx(c[1].startSec, 39.6) && approx(c[1].endSec, 41.4))
}

@Test func aBlipShorterThanTheSustainIsNotVoice() {
    // A 100ms click never sustains for 250ms: no chunk.
    let audio = silence(5) + tone(0.1, amp: 0.5) + silence(5)
    #expect(voicedChunks(samples: audio, sampleRate: SR).isEmpty)
}

@Test func paddingClampsToTheAudioEdges() {
    let audio = tone(1) + silence(3) + tone(1)          // speech at the very start and end
    let c = voicedChunks(samples: audio, sampleRate: SR)
    #expect(c.count == 2)
    #expect(c.first!.startSec == 0)
    #expect(approx(c.last!.endSec, 5.0))
}

@Test func longSpeechIsSplitIntoWhisperSizedChunksThatStillCoverItAll() {
    let audio = tone(70)
    let c = voicedChunks(samples: audio, sampleRate: SR)
    #expect(c.count >= 3)
    #expect(c.allSatisfy { $0.endSec - $0.startSec <= 30.0 + 1e-6 })
    #expect(c.first!.startSec == 0 && approx(c.last!.endSec, 70))
    for (a, b) in zip(c, c.dropFirst()) { #expect(approx(a.endSec, b.startSec, tol: 1e-6)) }   // contiguous
}

@Test func slicingReturnsTheSamplesForAChunk() {
    let audio = silence(2) + tone(1) + silence(2)
    let c = voicedChunks(samples: audio, sampleRate: SR)
    let s = sliceSamples(audio, chunk: c[0], sampleRate: SR)
    // Sample indices are what the slice is defined by; a float difference can round differently.
    #expect(s.count == Int(c[0].endSec * Double(SR)) - Int(c[0].startSec * Double(SR)))
    #expect(s.count > SR)   // at least the 1s of tone plus padding
}

@Test func voicedSecondsSumsChunkDurations() {
    let c = [VoicedChunk(startSec: 1, endSec: 3.5), VoicedChunk(startSec: 10, endSec: 11)]
    #expect(voicedSeconds(c) == 3.5)
}

@Test func coverageLineNamesBothChannelsChunksAndWorkers() {
    let line = transcribeCoverageLine(micVoicedSec: 1092, micTotalSec: 3090,
                                      systemVoicedSec: 1445, systemTotalSec: 3090,
                                      chunks: 63, workers: 4)
    #expect(line == "mic 18m12s voiced of 51m30s · system 24m05s · 63 chunks · 4 workers")
}

// Lived on the first manual recording after 0.5.13 shipped: a room recording
// has a silent system channel, the segmenter found nothing, the channel was
// decoded whole as designed — and the line said "system 0m10s voiced of
// 0m10s". A fallback is not voice; the line must say which it was.
@Test func coverageLineSaysWhenAChannelWasDecodedWholeForLackOfVoice() {
    let line = transcribeCoverageLine(micVoicedSec: 10, micTotalSec: 10,
                                      systemVoicedSec: nil, systemTotalSec: 10,
                                      chunks: 2, workers: 4)
    #expect(line == "mic 0m10s voiced of 0m10s · system no voice found, decoded whole · 2 chunks · 4 workers")
}


// The whole-channel fallback exists for a threshold MISS: energy is there but
// never sustains. A channel with no energy at all is silence — a room
// recording's system channel — and decoding it whole cost 1m45s for 90s of
// nothing on 2026-09-22, and would cost an hour for an hour. Tell them apart.
@Test func aChannelWithNoEnergyIsSilentNotAThresholdMiss() {
    #expect(channelVerdict(samples: silence(30), sampleRate: SR) == .silent)
    // Energy present but never sustained: ambiguous, keep the fallback.
    let clicks = (0..<20).flatMap { _ in tone(0.05, amp: 0.3) + silence(1.0) }
    #expect(channelVerdict(samples: clicks, sampleRate: SR) == .noSustainedVoice)
    // Real speech-like sustain: voiced.
    #expect(channelVerdict(samples: silence(2) + tone(2) + silence(2), sampleRate: SR) == .voiced)
}

@Test func coverageLineSaysWhenAChannelWasSkippedAsSilent() {
    let line = transcribeCoverageLine(micVoicedSec: 10, micTotalSec: 90,
                                      systemVoicedSec: nil, systemTotalSec: 90,
                                      systemSkippedSilent: true, chunks: 1, workers: 4)
    #expect(line == "mic 0m10s voiced of 1m30s · system silent, skipped · 1 chunks · 4 workers")
}
