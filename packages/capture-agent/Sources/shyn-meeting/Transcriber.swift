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
// Never throws out of the agent loop. Returns .failure for infra problems
// (model missing, download offline, every channel erroring) and .segments for
// a decode that actually ran — including .segments([]) for a silent meeting.
// The caller purges audio on silence and keeps it for retry on failure, so
// collapsing the two (as this did until 2026-08-05) destroys recordings.
func transcribeMeeting(mic: URL, system: URL, model: String, modelDir: URL,
                       chunked: Bool = true,
                       onProgress: @escaping @Sendable (Double) async -> Void = { _ in }) async -> TranscriptionOutcome {
    // Idle sleep stays off for the whole decode (a 25-minute job took 4h40m of
    // wall time on 2026-09-05 because the Mac slept under it). Both clocks are
    // logged below: uptime stops during sleep, Date does not, the gap is sleep.
    let wallStart = Date(), awakeStart = ProcessInfo.processInfo.systemUptime
    let loadBox = LoadTimeBox()
    let timing = {
        transcribeTimingLine(awakeSec: ProcessInfo.processInfo.systemUptime - awakeStart,
                             wallSec: Date().timeIntervalSince(wallStart),
                             modelLoadSec: loadBox.seconds)
    }
    return await withSystemAwake(reason: "shyn: transcribing a meeting") {
        await transcribeChannels(mic: mic, system: system, model: model, modelDir: modelDir,
                                 chunked: chunked, onProgress: onProgress, timing: timing, loadBox: loadBox)
    }
}

// Records how long WhisperKit took to come up, for the timing line.
final class LoadTimeBox: @unchecked Sendable { var seconds: Double? = nil }

// Decoders run this many chunks at once. WhisperKit's macOS default is 16;
// each worker carries its own KV cache on a ~3GB model, and memory pressure
// during transcription is what killed the popover renderer on 2026-09-21.
let transcribeWorkers = 4

private func transcribeChannels(mic: URL, system: URL, model: String, modelDir: URL,
                                chunked: Bool,
                                onProgress: @escaping @Sendable (Double) async -> Void,
                                timing: () -> String, loadBox: LoadTimeBox) async -> TranscriptionOutcome {
    do {
        let loadStart = ProcessInfo.processInfo.systemUptime
        // downloadBase keeps CoreML models out of ~/Documents (WhisperKit's
        // default), which is TCC-protected for a headless agent. The folder is
        // named and downloads are OFF: the model is on disk by the time a
        // session reaches transcription (the pending queue holds it otherwise),
        // and with downloads on WhisperKit consults the model hub on every
        // load — a network round trip inside "model load" that swung between
        // 9s and 49s on the same binary (2026-09-22), and one a transcriber
        // that promises to stay on the machine should never make.
        let pipe = try await WhisperKit(WhisperKitConfig(model: model, downloadBase: modelDir,
                                                         modelFolder: whisperModelFolder(model: model, modelDir: modelDir),
                                                         download: false))
        loadBox.seconds = ProcessInfo.processInfo.systemUptime - loadStart
        // No chunking. WhisperKit's `.vad` chunking returned ZERO segments for
        // our two-channel WAVs (verified 2026-07-28: turbo+VAD = 0 segments vs
        // 30 clean segments without it on the same audio), so the whole channel
        // is transcribed. The speed win comes from the turbo model, not VAD.
        var opts = DecodingOptions(task: .transcribe, skipSpecialTokens: true)
        // Only the channels that actually recorded; drives the progress denominator.
        let channels = [(mic, Speaker.me), (system, Speaker.others)]
            .filter { FileManager.default.fileExists(atPath: $0.0.path) }
        let total = channels.count
        var dropped = (annotation: 0, repeated: 0)
        var segs: [TranscriptSegment] = []
        var channelErrors: [String] = []
        var coverage = ""
        if chunked {
            // Voiced chunks only, both channels in one concurrent batch
            // (CaptureCore/AudioSegmenter.swift). A channel the segmenter
            // finds nothing in is decoded whole, exactly as before — a
            // threshold miss must never cost a transcript.
            opts.concurrentWorkerCount = transcribeWorkers
            var arrays: [[Float]] = []
            var meta: [(speaker: Speaker, offset: Double)] = []
            var voiced: [Speaker: (Double?, Double)] = [:]   // nil voiced = decoded whole or skipped
            var skipped: Set<Speaker> = []
            for (url, speaker) in channels {
                do {
                    let samples = try AudioProcessor.loadAudioAsFloatArray(fromPath: url.path)
                    let totalSec = Double(samples.count) / 16_000
                    var chunks = voicedChunks(samples: samples, sampleRate: 16_000)
                    var fallback = false
                    if chunks.isEmpty {
                        switch channelVerdict(samples: samples, sampleRate: 16_000) {
                        case .silent:
                            // No energy at all: nothing to decode, and decoding it
                            // anyway costs the length of the meeting.
                            skipped.insert(speaker); voiced[speaker] = (nil, totalSec); continue
                        default:
                            fallback = true
                            chunks = [VoicedChunk(startSec: 0, endSec: totalSec)]
                        }
                    }
                    voiced[speaker] = (fallback ? nil : voicedSeconds(chunks), totalSec)
                    for c in chunks {
                        arrays.append(sliceSamples(samples, chunk: c, sampleRate: 16_000))
                        meta.append((speaker, c.startSec))
                    }
                } catch { channelErrors.append("\(speaker.rawValue): \(error)") }
            }
            let onWindow: TranscriptionCallback = { _ in
                let f = pipe.progress.fractionCompleted
                Task { await onProgress(f) }
                return nil
            }
            let results = await pipe.transcribe(audioArrays: arrays, decodeOptions: opts, callback: onWindow)
            var failed = 0
            for (i, rs) in results.enumerated() {
                guard let rs else { failed += 1; continue }
                for r in rs {
                    for s in r.segments {
                        let text = s.text.trimmingCharacters(in: .whitespacesAndNewlines)
                        if text.isEmpty { continue }
                        if isNonSpeechAnnotation(text) { dropped.annotation += 1; continue }
                        segs.append(TranscriptSegment(start: meta[i].offset + Double(s.start),
                                                      end: meta[i].offset + Double(s.end),
                                                      speaker: meta[i].speaker, text: text))
                    }
                }
            }
            if failed > 0 { channelErrors.append("\(failed) of \(arrays.count) chunks failed to decode") }
            let m = voiced[.me] ?? (nil, 0), o = voiced[.others] ?? (nil, 0)
            coverage = "; " + transcribeCoverageLine(micVoicedSec: m.0, micTotalSec: m.1,
                                                     systemVoicedSec: o.0, systemTotalSec: o.1,
                                                     micSkippedSilent: skipped.contains(.me),
                                                     systemSkippedSilent: skipped.contains(.others),
                                                     chunks: arrays.count, workers: transcribeWorkers)
        }
        for (idx, (url, speaker)) in channels.enumerated() where !chunked {
            // WhisperKit fires this per decode window; read its Progress into a
            // single 0…1 fraction and hand only the Double (Sendable) to the
            // actor — the non-Sendable pipe never crosses an isolation boundary.
            let onWindow: TranscriptionCallback = { _ in
                let f = overallTranscribeProgress(
                    channelsDone: idx, channelFraction: pipe.progress.fractionCompleted, totalChannels: total)
                Task { await onProgress(f) }
                return nil
            }
            var results: [TranscriptionResult] = []
            do { results = try await pipe.transcribe(audioPath: url.path, decodeOptions: opts, callback: onWindow) }
            catch { channelErrors.append("\(speaker.rawValue): \(error)") }
            for r in results {
                for s in r.segments {
                    let text = s.text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if text.isEmpty { continue }
                    if isNonSpeechAnnotation(text) { dropped.annotation += 1; continue }
                    segs.append(TranscriptSegment(start: Double(s.start), end: Double(s.end),
                                                  speaker: speaker, text: text))
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
            "\(dropped.repeated) repeated",
        ].joined(separator: ", ")
        // One stderr mechanism for the whole file: logLine timestamps it, which
        // is the entire reason it exists (an undatable failure line is what
        // made the 15 Jul model outage impossible to place).
        FileHandle.standardError.write(Data(
            logLine("[transcriber] kept \(kept.count) segments; dropped \(reasons); \(timing())\(coverage)").utf8))
        await onProgress(1.0)
        // Nothing DECODED and every channel errored: infra, not silence. The
        // test is on `segs`, not `kept`, on purpose — a decode that produced
        // segments which the filters then removed is a genuinely empty meeting
        // (.segments([]), caller purges), not a failure to keep audio for.
        let allFailed = chunked ? (segs.isEmpty && !channelErrors.isEmpty)
                                : (segs.isEmpty && !channelErrors.isEmpty && channelErrors.count == channels.count)
        if allFailed {
            FileHandle.standardError.write(Data(
                logLine("[transcriber] all channels failed: \(channelErrors.joined(separator: "; "))").utf8))
            return .failure(channelErrors.joined(separator: "; "))
        }
        return .segments(kept)
    } catch {
        // WhisperKit init: model missing, download offline, unsupported device.
        FileHandle.standardError.write(Data(logLine("[transcriber] failed: \(error); \(timing())").utf8))
        return .failure("\(error)")
    }
}

// isNonSpeechAnnotation moved to CaptureCore/TranscriptFilter.swift, where it
// also catches *asterisk* forms. Leaving a local copy here would shadow the
// CaptureCore one and silently keep the asterisk bug.

// True once the CoreML model files exist locally (status reporting; the
// first transcription triggers the download otherwise).
func whisperModelPresent(model: String, modelDir: URL) -> Bool {
    return FileManager.default.fileExists(
        atPath: whisperModelFolder(model: model, modelDir: modelDir) + "/TextDecoder.mlmodelc")
}

// Brings Whisper up exactly the way transcribeMeeting does and lets it go,
// so macOS specializes the Core ML models to this chip now and caches the
// result. Without it the first transcription after every upgrade paid ~90s
// itself (2026-09-22: 100s cold, 13s warm on the same file). WhisperKit's
// own `prewarm` mode (load each model, unload) was tried first and left 40s
// of it behind — the full load path specializes more than the sequential
// one does — so this is the real init, ~3GB for about a minute and a half,
// at startup, off the critical path. Returns seconds taken, or nil.
func prewarmWhisper(model: String, modelDir: URL) async -> Double? {
    let t0 = ProcessInfo.processInfo.systemUptime
    do {
        // With download off, WhisperKit needs the folder spelled out — the same
        // one whisperModelPresent checks.
        _ = try await WhisperKit(WhisperKitConfig(model: model, downloadBase: modelDir,
                                                  modelFolder: whisperModelFolder(model: model, modelDir: modelDir),
                                                  download: false))
        return ProcessInfo.processInfo.systemUptime - t0
    } catch {
        FileHandle.standardError.write(Data(logLine("[meeting] whisper prewarm failed: \(error)").utf8))
        return nil
    }
}

// The one place the on-disk layout of a WhisperKit model is spelled out.
func whisperModelFolder(model: String, modelDir: URL) -> String {
    modelDir.appendingPathComponent("models/argmaxinc/whisperkit-coreml/openai_whisper-\(model)").path
}
