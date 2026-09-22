import Foundation

// Voiced-region segmentation for transcription (2026-09-22).
//
// Whisper decoded every second of both channels, and on a two-person call
// half of each channel is the other person talking — silence here. A
// 52-minute call cost 24m53s of decode. This keeps only the stretches that
// carry voice, using the same RMS-and-sustain notion the commit gate trusts
// (CaptureCore/VoiceActivity.swift): level above threshold continuously for
// sustainSec. Regions separated by a short gap merge, each is padded so no
// word is clipped at an edge, and anything longer than Whisper's 30s window
// is split at its quietest point. The chunks are what the decoder sees, and
// it can run them concurrently. Pure, so all of it is testable on synthetic
// arrays — recordings are purged after transcription.

public struct VoicedChunk: Equatable, Sendable {
    public let startSec: Double
    public let endSec: Double
    public init(startSec: Double, endSec: Double) { self.startSec = startSec; self.endSec = endSec }
    public var durationSec: Double { endSec - startSec }
}

public func voicedChunks(samples: [Float], sampleRate: Int,
                         frameMs: Int = 20, threshold: Float = 0.01, sustainSec: Double = 0.25,
                         mergeGapSec: Double = 1.0, padSec: Double = 0.4,
                         maxChunkSec: Double = 30.0) -> [VoicedChunk] {
    let frame = max(1, sampleRate * frameMs / 1000)
    let frameCount = samples.count / frame
    guard frameCount > 0 else { return [] }
    let totalSec = Double(samples.count) / Double(sampleRate)
    let secPerFrame = Double(frame) / Double(sampleRate)

    // Per-frame RMS.
    var rms = [Float](repeating: 0, count: frameCount)
    for f in 0..<frameCount {
        var sum: Float = 0
        let base = f * frame
        for i in base..<(base + frame) { sum += samples[i] * samples[i] }
        rms[f] = (sum / Float(frame)).squareRoot()
    }

    // Sustained runs of above-threshold frames → raw regions (in frames).
    let sustainFrames = Int((sustainSec / secPerFrame).rounded(.up))
    var regions: [(Int, Int)] = []
    var runStart: Int? = nil
    for f in 0...frameCount {
        let voiced = f < frameCount && rms[f] >= threshold
        if voiced { if runStart == nil { runStart = f } }
        else if let s = runStart {
            if f - s >= sustainFrames { regions.append((s, f)) }
            runStart = nil
        }
    }
    guard !regions.isEmpty else { return [] }

    // Merge across short gaps, then pad and clamp, then merge overlaps.
    let mergeFrames = Int((mergeGapSec / secPerFrame).rounded())
    var merged: [(Int, Int)] = [regions[0]]
    for r in regions.dropFirst() {
        if r.0 - merged[merged.count - 1].1 < mergeFrames { merged[merged.count - 1].1 = r.1 }
        else { merged.append(r) }
    }
    let padFrames = Int((padSec / secPerFrame).rounded())
    var padded: [(Int, Int)] = []
    for r in merged {
        let s = max(0, r.0 - padFrames), e = min(frameCount, r.1 + padFrames)
        if let last = padded.last, s <= last.1 { padded[padded.count - 1].1 = max(last.1, e) }
        else { padded.append((s, e)) }
    }

    // Split anything longer than the decoder window at its quietest frame in
    // the last 5s before the limit, so a cut lands in a pause, not a word.
    let maxFrames = Int(maxChunkSec / secPerFrame)
    let searchFrames = Int(5.0 / secPerFrame)
    var out: [VoicedChunk] = []
    for r in padded {
        var s = r.0
        while r.1 - s > maxFrames {
            let lo = max(s + 1, s + maxFrames - searchFrames), hi = s + maxFrames
            var cut = hi, quietest = Float.greatestFiniteMagnitude
            for f in lo...hi where rms[f] < quietest { quietest = rms[f]; cut = f }
            out.append(VoicedChunk(startSec: Double(s) * secPerFrame, endSec: Double(cut) * secPerFrame))
            s = cut
        }
        let endSec = r.1 == frameCount ? totalSec : Double(r.1) * secPerFrame
        out.append(VoicedChunk(startSec: Double(s) * secPerFrame, endSec: endSec))
    }
    return out
}

// Silence and a threshold miss are different failures with different costs.
// The whole-channel fallback exists for the miss — energy that never sustains
// for 250ms — and is cheap insurance. Running it on a channel with no energy
// at all (a room recording's system channel) decodes an hour of nothing for
// an hour of meeting; on 2026-09-22 it spent 1m45s on 90s of zeros.
public enum ChannelVerdict: Equatable, Sendable { case silent, noSustainedVoice, voiced }

public func channelVerdict(samples: [Float], sampleRate: Int,
                           frameMs: Int = 20, threshold: Float = 0.01) -> ChannelVerdict {
    if !voicedChunks(samples: samples, sampleRate: sampleRate, frameMs: frameMs, threshold: threshold).isEmpty {
        return .voiced
    }
    let frame = max(1, sampleRate * frameMs / 1000)
    var peak: Float = 0
    var i = 0
    while i + frame <= samples.count {
        var sum: Float = 0
        for j in i..<(i + frame) { sum += samples[j] * samples[j] }
        peak = max(peak, (sum / Float(frame)).squareRoot())
        i += frame
    }
    return peak < threshold / 2 ? .silent : .noSustainedVoice
}

public func sliceSamples(_ samples: [Float], chunk: VoicedChunk, sampleRate: Int) -> [Float] {
    let s = max(0, Int(chunk.startSec * Double(sampleRate)))
    let e = min(samples.count, Int(chunk.endSec * Double(sampleRate)))
    return s < e ? Array(samples[s..<e]) : []
}

public func voicedSeconds(_ chunks: [VoicedChunk]) -> Double {
    chunks.reduce(0) { $0 + $1.durationSec }
}

// The measurement line: what fraction of each channel actually carried voice,
// how many chunks the decoder saw, and how many it ran at once. Every call
// reports its own achievable speedup instead of an estimate.
// A nil voiced figure means the segmenter found no voice on that channel and
// it was decoded whole — a fallback, not voice, and the line says so (lived
// on the first room recording after 0.5.13: a silent system channel read as
// "0m10s voiced of 0m10s").
public func transcribeCoverageLine(micVoicedSec: Double?, micTotalSec: Double,
                                   systemVoicedSec: Double?, systemTotalSec: Double,
                                   micSkippedSilent: Bool = false, systemSkippedSilent: Bool = false,
                                   chunks: Int, workers: Int) -> String {
    let fallback = { (skipped: Bool) in skipped ? "silent, skipped" : "no voice found, decoded whole" }
    let mic = micVoicedSec.map { "\(fmtDuration($0)) voiced of \(fmtDuration(micTotalSec))" }
        ?? fallback(micSkippedSilent)
    let sys = systemVoicedSec.map { fmtDuration($0) } ?? fallback(systemSkippedSilent)
    return "mic \(mic) · system \(sys) · \(chunks) chunks · \(workers) workers"
}
