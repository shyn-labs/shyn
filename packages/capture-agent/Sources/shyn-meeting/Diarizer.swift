import CaptureCore
import FluidAudio
import Foundation

// The only file that touches FluidAudio. Everything decidable without a model
// lives in CaptureCore/Diarization.swift.
//
// Models live under SHYN_HOME, never FluidAudio's default Application Support
// folder: uninstall --purge must take them, and the agent must never download
// while transcribing (lived 2026-09-22: a hub check during load made the same
// binary take 9s or 49s). Only downloadDiarizerModels fetches; it writes the
// ready marker LAST, so an interrupted download reads as not ready.

let diarizerModelDir = URL(fileURLWithPath: home + "/models/fluidaudio")
private let readyMarker = ".shyn-diarizer-ready"

func diarizerModelsReady(dir: URL) -> Bool {
    FileManager.default.fileExists(atPath: dir.appendingPathComponent(readyMarker).path)
}

/// Fetches Nemotron 3 (offline preset) and the WeSpeaker embedder into `dir`.
/// Background-only (predownload gate); never called on the transcription path.
func downloadDiarizerModels(dir: URL) async -> Bool {
    do {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        _ = try await Nemotron3Models.loadFromHuggingFace(config: .offline, cacheDirectory: dir)
        _ = try await DiarizerModels.downloadIfNeeded(to: dir.appendingPathComponent("wespeaker"))
        try Data("1\n".utf8).write(to: dir.appendingPathComponent(readyMarker), options: .atomic)
        return true
    } catch {
        FileHandle.standardError.write(Data(logLine("[diarizer] model download failed: \(error)").utf8))
        return false
    }
}

struct ChannelDiarization {
    let turns: [DiarizedTurn]
    /// Raw speaker index → its embedding and seconds of speech.
    let embeddings: [Int: (embedding: [Float], speechSec: Double)]
}

// WeSpeaker's fixed 10 s input (spike Embed.swift): 160_000 samples at 16 kHz.
private let wespeakerWindow = 160_000
private let wespeakerMinTail = 16_000

/// Diarizes one 16 kHz mono channel and embeds every speaker found. Loads both
/// models, uses them, and lets them go out of scope before returning: never
/// resident beside Whisper. Throws on any model failure; the caller falls back.
func diarizeChannel(samples: [Float], dir: URL) async throws -> ChannelDiarization {
    guard diarizerModelsReady(dir: dir) else {
        throw EmbeddingError(description: "diarizer models not ready")
    }
    let config = Nemotron3Config.offline
    let models = try await Nemotron3Models.loadFromHuggingFace(config: config, cacheDirectory: dir)
    let diarizer = Nemotron3Diarizer(config: config, models: models)
    let (probs, frames) = try diarizer.processComplete(samples)
    let raw = Nemotron3Diarizer.segments(
        probabilities: probs, frameCount: frames, threshold: 0.5, minDurationSeconds: 0.2
    ).map { DiarizedTurn(speaker: $0.speakerIndex, start: Double($0.startSeconds), end: Double($0.endSeconds)) }
    let turns = bridgeTurns(raw)

    let manager = DiarizerManager()
    manager.initialize(models: try await DiarizerModels.downloadIfNeeded(to: dir.appendingPathComponent("wespeaker")))
    var embeddings: [Int: (embedding: [Float], speechSec: Double)] = [:]
    for speaker in Set(turns.map(\.speaker)) {
        let ranges = speechRanges(speaker: speaker, turns: turns)
        let audio = slice(samples, ranges: ranges)
        guard !audio.isEmpty else { continue }
        let e = try windowedMean(audio, window: wespeakerWindow, minTail: wespeakerMinTail) {
            try manager.extractSpeakerEmbedding(from: $0)
        }
        embeddings[speaker] = (e, ranges.reduce(0) { $0 + ($1.1 - $1.0) })
    }
    return ChannelDiarization(turns: turns, embeddings: embeddings)
}

/// One embedding of the given speech ranges (the user's self-sample on calls).
func embedSpeech(samples: [Float], ranges: [(Double, Double)], dir: URL) async throws -> [Float] {
    guard diarizerModelsReady(dir: dir) else {
        throw EmbeddingError(description: "diarizer models not ready")
    }
    let manager = DiarizerManager()
    manager.initialize(models: try await DiarizerModels.downloadIfNeeded(to: dir.appendingPathComponent("wespeaker")))
    return try windowedMean(slice(samples, ranges: ranges), window: wespeakerWindow, minTail: wespeakerMinTail) {
        try manager.extractSpeakerEmbedding(from: $0)
    }
}

private func slice(_ s: [Float], ranges: [(Double, Double)]) -> [Float] {
    ranges.flatMap { r -> ArraySlice<Float> in
        let a = max(0, Int(r.0 * 16_000)), b = min(s.count, Int(r.1 * 16_000))
        return a < b ? s[a..<b] : []
    }
}
