import CaptureCore
@preconcurrency import CoreML
import FluidAudio
import Foundation

// The only file that touches FluidAudio. Everything decidable without a model
// lives in CaptureCore/Diarization.swift.
//
// Models live under SHYN_HOME, never FluidAudio's default Application Support
// folder: uninstall --purge must take them, and the agent must never download
// while transcribing (lived 2026-09-22: a hub check during load made the same
// binary take 9s or 49s). Only downloadDiarizerModels fetches.
//
// The transcription path (diarizeChannel / embedSpeech) loads from explicit
// local paths and never calls loadFromHuggingFace, downloadIfNeeded or any
// ModelHub code: those can re-fetch AND delete the cache on a weights-version
// bump, a missing file or a revision mismatch. A missing, partial or stale
// cache therefore throws and the caller falls back to Me/Others.

let diarizerModelDir = URL(fileURLWithPath: home + "/models/fluidaudio")
private let readyMarker = ".shyn-diarizer-ready"

private let nemotronConfig = Nemotron3Config.offline

// Layout FluidAudio's downloaders produce under `dir` (verified on 0.17.5).
private func nemotronDir(_ dir: URL) -> URL {
    dir.appendingPathComponent(Repo.nemotron3Diarization.folderName)
}
private func nemotronModelURL(_ dir: URL) -> URL {
    nemotronDir(dir)
        .appendingPathComponent(nemotronConfig.hubSubdirectory)
        .appendingPathComponent(nemotronConfig.modelFileName)
}
private func silenceURL(_ dir: URL) -> URL {
    nemotronDir(dir).appendingPathComponent(ModelNames.Nemotron3.silenceEmbeddingFile)
}
private func wespeakerDir(_ dir: URL) -> URL {
    dir.appendingPathComponent(Repo.diarizer.folderName)
}
private func segmentationURL(_ dir: URL) -> URL {
    wespeakerDir(dir).appendingPathComponent(ModelNames.Diarizer.segmentationFile)
}
private func embeddingURL(_ dir: URL) -> URL {
    wespeakerDir(dir).appendingPathComponent(ModelNames.Diarizer.embeddingFile)
}

/// True only when the marker records the FluidAudio weights version this build
/// expects AND every file the loaders read is on disk. A stale or partial cache
/// reads as not ready; it is never repaired here.
func diarizerModelsReady(dir: URL) -> Bool {
    let marker = try? String(contentsOf: dir.appendingPathComponent(readyMarker), encoding: .utf8)
    guard marker?.trimmingCharacters(in: .whitespacesAndNewlines) == ModelNames.Nemotron3.weightsVersion else {
        return false
    }
    return modelFilesPresent(dir: dir)
}

/// Every file Core ML reads for each compiled bundle, plus the silence
/// embedding. A bundle missing its weights can crash Core ML natively (not a
/// catchable throw), so presence is checked up front.
private func modelFilesPresent(dir: URL) -> Bool {
    let bundles = [nemotronModelURL(dir), segmentationURL(dir), embeddingURL(dir)]
    let files = bundles.flatMap { b in
        ["coremldata.bin", "model.mil", "weights/weight.bin"].map { b.appendingPathComponent($0) }
    } + [silenceURL(dir)]
    return files.allSatisfy { FileManager.default.fileExists(atPath: $0.path) }
}

/// Fetches Nemotron 3 (offline preset) and the WeSpeaker embedder into `dir`.
/// Background-only (predownload gate); never called on the transcription path.
/// The ready marker (the weights version) is written LAST, so an interrupted
/// download reads as not ready.
func downloadDiarizerModels(dir: URL) async -> Bool {
    do {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        _ = try await Nemotron3Models.loadFromHuggingFace(config: nemotronConfig, cacheDirectory: dir)
        _ = try await DiarizerModels.downloadIfNeeded(to: dir.appendingPathComponent("wespeaker"))
        guard modelFilesPresent(dir: dir) else {
            throw EmbeddingError(description: "download finished but model files are missing")
        }
        try Data((ModelNames.Nemotron3.weightsVersion + "\n").utf8)
            .write(to: dir.appendingPathComponent(readyMarker), options: .atomic)
        return true
    } catch {
        FileHandle.standardError.write(Data(logLine("[diarizer] model download failed: \(error)").utf8))
        return false
    }
}

/// Loads Nemotron 3 from disk only. Throws if anything is missing.
private func loadNemotron(dir: URL) throws -> Nemotron3Models {
    guard let sil = try? Data(contentsOf: silenceURL(dir)),
          sil.count == nemotronConfig.preEncoderDims * MemoryLayout<Float>.size
    else { throw EmbeddingError(description: "diarizer silence embedding missing or malformed") }
    let mlConfig = MLModelConfiguration()
    mlConfig.computeUnits = .all
    let model = try MLModel(contentsOf: nemotronModelURL(dir), configuration: mlConfig)
    let silence = sil.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
    return try Nemotron3Models(config: nemotronConfig, model: model, silenceEmbedding: silence)
}

/// Loads the WeSpeaker bundle from disk only. Throws if anything is missing.
private func loadWeSpeaker(dir: URL) throws -> DiarizerManager {
    let models = try DiarizerModels.load(
        localSegmentationModel: segmentationURL(dir), localEmbeddingModel: embeddingURL(dir))
    let manager = DiarizerManager()
    manager.initialize(models: models)
    return manager
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
    let models = try loadNemotron(dir: dir)
    let diarizer = Nemotron3Diarizer(config: nemotronConfig, models: models)
    let (probs, frames) = try diarizer.processComplete(samples)
    let raw = Nemotron3Diarizer.segments(
        probabilities: probs, frameCount: frames, threshold: 0.5, minDurationSeconds: 0.2
    ).map { DiarizedTurn(speaker: $0.speakerIndex, start: Double($0.startSeconds), end: Double($0.endSeconds)) }
    let turns = bridgeTurns(raw)

    let manager = try loadWeSpeaker(dir: dir)
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
    let manager = try loadWeSpeaker(dir: dir)
    return try windowedMean(slice(samples, ranges: ranges), window: wespeakerWindow, minTail: wespeakerMinTail) {
        try manager.extractSpeakerEmbedding(from: $0)
    }
}

private func slice(_ s: [Float], ranges: [(Double, Double)]) -> [Float] {
    ranges.flatMap { r -> ArraySlice<Float> in
        // Int(Double) traps on NaN, infinity or overflow: skip such a range rather than crash.
        guard r.0.isFinite, r.1.isFinite, r.0 >= 0, r.1 >= r.0, r.1 < 1e9 else { return [] }
        let a = min(s.count, Int(r.0 * 16_000)), b = min(s.count, Int(r.1 * 16_000))
        return a < b ? s[a..<b] : []
    }
}
