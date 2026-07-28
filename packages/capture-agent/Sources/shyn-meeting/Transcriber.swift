import Foundation
import WhisperKit
import CaptureCore

// WhisperKit transcription of the two channel WAVs into speaker-labeled
// segments (mic → Me, system → Others). Spike-validated API shapes
// (WhisperKit 0.18.0): WhisperKit(WhisperKitConfig(model:)), array-returning
// transcribe(audioPath:decodeOptions:), TranscriptionResult.segments.
// Language auto-detect on purpose: on Hindi/Hinglish speech Whisper emits an
// English gist — recorded spike decision, more searchable than mangled
// Devanagari (spikes/meeting-probe/README.md §Accuracy).
//
// Returns [] on ANY failure — a meeting with no transcript is dropped, never
// thrown out of the agent loop.
func transcribeMeeting(mic: URL, system: URL, model: String, modelDir: URL,
                       onProgress: @escaping @Sendable (Double) async -> Void = { _ in }) async -> [TranscriptSegment] {
    do {
        // downloadBase keeps CoreML models out of ~/Documents (WhisperKit's
        // default), which is TCC-protected for a headless agent.
        let pipe = try await WhisperKit(WhisperKitConfig(model: model, downloadBase: modelDir))
        // VAD chunking skips the long silent stretches every channel carries
        // (the mic is silent while others talk, and vice-versa) — proportionally
        // less ANE inference and no temperature-fallback thrashing on
        // [BLANK_AUDIO] windows, which is what stretched long meetings to hours.
        var opts = DecodingOptions(task: .transcribe, skipSpecialTokens: true)
        opts.chunkingStrategy = .vad
        // Only the channels that actually recorded; drives the progress denominator.
        let channels = [(mic, Speaker.me), (system, Speaker.others)]
            .filter { FileManager.default.fileExists(atPath: $0.0.path) }
        let total = channels.count
        var segs: [TranscriptSegment] = []
        for (idx, (url, speaker)) in channels.enumerated() {
            // WhisperKit fires this per decode window; read its Progress into a
            // single 0…1 fraction and hand only the Double (Sendable) to the
            // actor — the non-Sendable pipe never crosses an isolation boundary.
            let onWindow: TranscriptionCallback = { _ in
                let f = overallTranscribeProgress(
                    channelsDone: idx, channelFraction: pipe.progress.fractionCompleted, totalChannels: total)
                Task { await onProgress(f) }
                return nil
            }
            let results: [TranscriptionResult] =
                (try? await pipe.transcribe(audioPath: url.path, decodeOptions: opts, callback: onWindow)) ?? []
            for r in results {
                for s in r.segments {
                    let text = s.text.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !text.isEmpty, !isNonSpeechAnnotation(text) else { continue }
                    segs.append(TranscriptSegment(start: Double(s.start), speaker: speaker, text: text))
                }
            }
        }
        await onProgress(1.0)
        return segs
    } catch {
        FileHandle.standardError.write(Data("[transcriber] failed: \(error)\n".utf8))
        return []
    }
}

// Whisper marks non-speech stretches with bracketed/parenthesized
// annotations — "[BLANK_AUDIO]", "[Pause]", "[ Silence ]", "(music)" etc.
// (live-verification finding: silent meeting tails produced dozens of
// them). They carry no content; drop whole-annotation segments.
func isNonSpeechAnnotation(_ text: String) -> Bool {
    (text.hasPrefix("[") && text.hasSuffix("]")) ||
    (text.hasPrefix("(") && text.hasSuffix(")"))
}

// True once the CoreML model files exist locally (status reporting; the
// first transcription triggers the download otherwise).
func whisperModelPresent(model: String, modelDir: URL) -> Bool {
    let dir = modelDir
        .appendingPathComponent("models/argmaxinc/whisperkit-coreml/openai_whisper-\(model)")
    return FileManager.default.fileExists(
        atPath: dir.appendingPathComponent("TextDecoder.mlmodelc").path)
}
