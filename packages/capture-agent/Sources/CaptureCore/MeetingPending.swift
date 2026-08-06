import Foundation

// Transcription outcome (live finding 2026-08-04): the transcriber used to
// return [] for BOTH "the model could not even load" and "we decoded fine,
// nobody spoke". The caller read empty as silence, purged the audio, and the
// meeting was gone — a real capture died that way when WhisperKit tried to
// fetch large-v3_turbo with no network. Infra failure and genuine silence are
// different events and now have different types.
public enum TranscriptionOutcome: Sendable {
    case segments([TranscriptSegment])
    case failure(String)
}

// Sidecar written into the session dir when transcription fails for infra
// reasons: it holds the metadata the retry needs (the agent may restart
// before the retry lands, so this cannot live in memory). Audio stays next to
// it, still bounded by the 24h sweepOrphanAudio pass at startup — a meeting
// whose model never arrives inside a day is still let go, which keeps the
// byte-honest purge promise honest.
public struct PendingSession: Codable, Sendable {
    public var start: Int
    public var end: Int
    public var bundleId: String?
    public var appName: String
    public var windowTitle: String?
    public var reason: String
    public var attempts: Int

    public init(start: Int, end: Int, bundleId: String?, appName: String,
                windowTitle: String?, reason: String, attempts: Int = 1) {
        self.start = start; self.end = end; self.bundleId = bundleId
        self.appName = appName; self.windowTitle = windowTitle
        self.reason = reason; self.attempts = attempts
    }
}

// A sidecar written at COMMIT time carries no end timestamp — the session is
// still recording, and the process that would have written the end may be the
// one that got killed. Derive it from how far the WAVs actually got.
//
// This exists because of a real loss on 2026-08-06: a 70-minute meeting was
// interrupted by `shyn setup` during an upgrade, leaving orphaned WAVs with no
// sidecar. Nothing retried them and the 24h sweep would have deleted them. The
// retry machinery only covered transcription FAILURE, not interruption.
public func inferredEnd(in dir: URL, start: Int) -> Int {
    let fm = FileManager.default
    let ends = ["mic.wav", "system.wav"].compactMap { name -> Int? in
        let u = dir.appendingPathComponent(name)
        guard let m = (try? u.resourceValues(forKeys: [.contentModificationDateKey]))?
            .contentModificationDate else { return nil }
        return Int(m.timeIntervalSince1970)
    }
    guard let latest = ends.max(), latest > start else {
        _ = fm            // keep the reference explicit; nothing else to consult
        return start + 1  // never return an end <= start: durationSec must be sane
    }
    return latest
}

public let pendingSidecarName = "pending.json"
// A model that is present but unusable (corrupt download, unsupported device)
// would otherwise retry every tick forever, pinning the ANE. Give up after
// this many attempts and purge rather than spin.
public let maxPendingAttempts = 5

public func writePendingSession(_ p: PendingSession, in dir: URL) -> Bool {
    guard let data = try? JSONEncoder().encode(p) else { return false }
    return (try? data.write(to: dir.appendingPathComponent(pendingSidecarName), options: .atomic)) != nil
}

public func readPendingSession(in dir: URL) -> PendingSession? {
    guard let data = try? Data(contentsOf: dir.appendingPathComponent(pendingSidecarName)) else { return nil }
    return try? JSONDecoder().decode(PendingSession.self, from: data)
}

// Cleared as soon as a retry produces a transcript, even if the daemon is down
// and the payload only reaches the ring buffer: the transcript exists at that
// point, so re-transcribing would ship it twice.
public func clearPendingSession(in dir: URL) {
    try? FileManager.default.removeItem(at: dir.appendingPathComponent(pendingSidecarName))
}

// Session dirs awaiting a retry, oldest meeting first.
public func pendingSessions(root: URL) -> [URL] {
    guard let items = try? FileManager.default.contentsOfDirectory(
        at: root, includingPropertiesForKeys: nil) else { return [] }
    return items
        .compactMap { dir -> (URL, Int)? in
            guard let p = readPendingSession(in: dir) else { return nil }
            return (dir, p.start)
        }
        .sorted { $0.1 < $1.1 }
        .map(\.0)
}
