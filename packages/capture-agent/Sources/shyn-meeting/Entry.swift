import AppKit
import Foundation
import CaptureCore

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
        runAgent()
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
