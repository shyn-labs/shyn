import AppKit
import Foundation
import CaptureCore
import WhisperKit

// Process entry point, kept in its own file and behind @main so the rest of
// the target has NO top-level code.
//
// That restriction is the whole reason this file exists. A Swift module with
// top-level statements cannot be imported, so shyn-meeting — 1,600 lines
// including the entire meeting lifecycle — could not have a test target at
// all. Everything testable had to be pushed down into CaptureCore or go
// untested, and what went untested was the composition: the title ladder that
// silently bottomed out for a week in September 2026, and control-file parsing
// that had never had a test since it was written.
//
// Splitting the entry out costs one file and makes `@testable import
// shyn_meeting` legal. Keep this file free of logic — anything with a decision
// in it belongs where a test can reach it.
@main
struct MeetingMain {
    static func main() async {
        guard #available(macOS 14.2, *) else {
            FileHandle.standardError.write(Data(
                "shyn-meeting requires macOS 14.2+ (CoreAudio process tap)\n".utf8))
            exit(1)
        }
        if CommandLine.arguments.contains("selftest") { await runSelfTest() }
        if CommandLine.arguments.contains("transcribe") { await runTranscribeFile() }
        if CommandLine.arguments.contains("prewarm") { await runPrewarm() }
        if CommandLine.arguments.contains("diarize") { await runDiarizeFile() }
        runAgent()
    }

    // prewarm: specialize the configured model's Core ML files to this chip
    // and exit. What the agent does at startup; here to time it and to prove
    // the cache survives across processes of the same binary.
    @available(macOS 14.2, *)
    private static func runPrewarm() async -> Never {
        let cfg = MeetingConfig.load(from: configPath)
        if let took = await prewarmWhisper(model: cfg.whisperModel, modelDir: whisperModelDir) {
            print("prewarm OK: \(cfg.whisperModel) in \(String(format: "%.1f", took))s"); exit(0)
        }
        exit(1)
    }

    // transcribe <mic.wav> <system.wav> [--whole]: run the real transcriber on
    // two channel files and print the segments and the timing line. Recordings
    // are purged after transcription, so this is the only way to compare the
    // chunked and whole-channel decoders on the same audio, or to time a
    // model, without a live meeting. Diagnostic entry; never returns.
    @available(macOS 14.2, *)
    private static func runTranscribeFile() async -> Never {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: "transcribe"), args.count > i + 2 else {
            FileHandle.standardError.write(Data("usage: shyn-meeting transcribe <mic.wav> <system.wav> [--whole]\n".utf8))
            exit(2)
        }
        let cfg = MeetingConfig.load(from: configPath)
        let chunked = !args.contains("--whole")
        let t0 = Date()
        let outcome = await transcribeMeeting(mic: URL(fileURLWithPath: args[i + 1]),
                                              system: URL(fileURLWithPath: args[i + 2]),
                                              model: cfg.whisperModel, modelDir: whisperModelDir,
                                              chunked: chunked)
        switch outcome {
        case .failure(let reason):
            print("FAILED: \(reason)"); exit(1)
        case .segments(let segs):
            for s in segs.sorted(by: { $0.start < $1.start }) {
                print(String(format: "%7.2f  %@: %@", s.start, s.speaker.rawValue, s.text))
            }
            print("mode=\(chunked ? "chunked" : "whole") model=\(cfg.whisperModel) segments=\(segs.count) wall=\(String(format: "%.1f", Date().timeIntervalSince(t0)))s")
            exit(0)
        }
    }

    // diarize <wav> [--download] [--rttm]: one channel -> turns + per-speaker
    // speech seconds. --download fetches the models first (diagnostic only; the
    // agent never downloads while transcribing). --rttm prints the turns as RTTM
    // so the release gate can score them. Diagnostic entry; never returns.
    @available(macOS 14.2, *)
    private static func runDiarizeFile() async -> Never {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: "diarize"), args.count > i + 1 else {
            FileHandle.standardError.write(Data("usage: shyn-meeting diarize <wav> [--download] [--rttm]\n".utf8))
            exit(2)
        }
        let path = args[i + 1]
        if args.contains("--download") { _ = await downloadDiarizerModels(dir: diarizerModelDir) }
        do {
            let samples = try AudioProcessor.loadAudioAsFloatArray(fromPath: path)
            let t0 = Date()
            let d = try await diarizeChannel(samples: samples, dir: diarizerModelDir)
            if args.contains("--rttm") {
                let uri = URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent
                for t in d.turns {
                    print(String(format: "SPEAKER %@ 1 %.3f %.3f <NA> <NA> spk%d <NA> <NA>",
                                 uri, t.start, t.end - t.start, t.speaker))
                }
                exit(0)
            }
            for t in d.turns { print(String(format: "%8.2f %8.2f  S%d", t.start, t.end, t.speaker)) }
            for (s, e) in d.embeddings.sorted(by: { $0.key < $1.key }) {
                print(String(format: "speaker S%d speech=%.1fs dim=%d", s, e.speechSec, e.embedding.count))
            }
            print(String(format: "turns=%d speakers=%d wall=%.1fs", d.turns.count, d.embeddings.count,
                         Date().timeIntervalSince(t0)))
            exit(0)
        } catch {
            FileHandle.standardError.write(Data("diarize failed: \(error)\n".utf8)); exit(1)
        }
    }

    // selftest: exercise the meeting wire path (assemble → payload → ingest →
    // stats) without audio/TCC — mirrors shyn-capture's selftest. Never
    // returns; it is a diagnostic entry, not a mode the agent runs in.
    @available(macOS 14.2, *)
    private static func runSelfTest() async -> Never {
        let segs = [
            TranscriptSegment(start: 0.0, speaker: .me, text: "hello everyone, shall we start the synthetic standup"),
            TranscriptSegment(start: 2.5, speaker: .others, text: "yes, agenda first please"),
            TranscriptSegment(start: 5.0, speaker: .me, text: "retention decision is due today"),
        ]
        let now = Int(Date().timeIntervalSince1970)
        let payload = meetingPayload(bundleId: "com.shyn.selftest", appName: "SelfTest",
                                     startEpoch: now - 300, endEpoch: now,
                                     transcript: assembleTranscript(segs))
        do {
            try await client.ingest(payload)
            var stats = MeetingStats()
            stats.state = "idle"; stats.meetingsCaptured = 1; stats.lastTranscribedTs = now
            try await client.postMeetingStats(stats)
            print("selftest OK: ingested \(payload.uri)")
            exit(0)
        } catch {
            FileHandle.standardError.write(Data("selftest FAIL: \(error)\n".utf8))
            exit(1)
        }
    }
}
