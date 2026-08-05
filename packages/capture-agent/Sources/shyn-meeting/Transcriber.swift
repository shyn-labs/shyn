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
        // No chunking. WhisperKit's `.vad` chunking returned ZERO segments for
        // our two-channel WAVs (verified 2026-07-28: turbo+VAD = 0 segments vs
        // 30 clean segments without it on the same audio), so the whole channel
        // is transcribed. The speed win comes from the turbo model, not VAD.
        let opts = DecodingOptions(task: .transcribe, skipSpecialTokens: true)
        // Only the channels that actually recorded; drives the progress denominator.
        let channels = [(mic, Speaker.me), (system, Speaker.others)]
            .filter { FileManager.default.fileExists(atPath: $0.0.path) }
        let total = channels.count
        var dropped = (annotation: 0, silence: 0, lowConfidence: 0, degenerate: 0, repeated: 0)
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
                    if text.isEmpty { continue }
                    if isNonSpeechAnnotation(text) { dropped.annotation += 1; continue }
                    let q = SegmentQuality(noSpeechProb: s.noSpeechProb,
                                           avgLogprob: s.avgLogprob,
                                           compressionRatio: s.compressionRatio)
                    if !passesQualityGates(q) {
                        if q.noSpeechProb > TranscriptFilterLimits.maxNoSpeechProb { dropped.silence += 1 }
                        else if q.avgLogprob < TranscriptFilterLimits.minAvgLogprob { dropped.lowConfidence += 1 }
                        else { dropped.degenerate += 1 }
                        continue
                    }
                    segs.append(TranscriptSegment(start: Double(s.start), speaker: speaker, text: text))
                }
            }
        }
        let kept = collapseRepeats(segs)
        dropped.repeated = segs.count - kept.count
        // Never silent: an over-aggressive threshold must be diagnosable from
        // the log rather than showing up as a mysteriously empty transcript.
        // Built as an array rather than a long `+` chain — the concatenated
        // form defeated the Swift type-checker ("unable to type-check this
        // expression in reasonable time").
        let reasons = [
            "\(dropped.annotation) annotation",
            "\(dropped.silence) silence",
            "\(dropped.lowConfidence) low-confidence",
            "\(dropped.degenerate) degenerate",
            "\(dropped.repeated) repeated",
        ].joined(separator: ", ")
        let summary = "[transcriber] kept \(kept.count) segments; dropped \(reasons)\n"
        FileHandle.standardError.write(Data(summary.utf8))
        await onProgress(1.0)
        return kept
    } catch {
        FileHandle.standardError.write(Data("[transcriber] failed: \(error)\n".utf8))
        return []
    }
}

// isNonSpeechAnnotation moved to CaptureCore/TranscriptFilter.swift, where it
// also catches *asterisk* forms. Leaving a local copy here would shadow the
// CaptureCore one and silently keep the asterisk bug.

// True once the CoreML model files exist locally (status reporting; the
// first transcription triggers the download otherwise).
func whisperModelPresent(model: String, modelDir: URL) -> Bool {
    let dir = modelDir
        .appendingPathComponent("models/argmaxinc/whisperkit-coreml/openai_whisper-\(model)")
    return FileManager.default.fileExists(
        atPath: dir.appendingPathComponent("TextDecoder.mlmodelc").path)
}
