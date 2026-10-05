import Foundation

public struct CaptureEvent: Sendable {
    public let bundleId: String, appName: String, windowTitle: String, text: String
    public let ts: Int
    public var method: String = "ax"   // caller sets "ocr" when fallback fired
    public init(bundleId: String, appName: String, windowTitle: String,
                text: String, ts: Int, method: String = "ax") {
        self.bundleId = bundleId; self.appName = appName
        self.windowTitle = windowTitle; self.text = text
        self.ts = ts; self.method = method
    }
}

public struct MethodCounts: Codable, Sendable { public var ax = 0, ocr = 0 }

// TCC visibility (spec §4): missing grants must surface in status. main.swift
// populates this once per stats post from AXIsProcessTrusted() and
// CGPreflightScreenCaptureAccess(). Optional so the pipeline tests (which
// don't touch TCC) stay pure; the daemon stores the payload opaquely.
public struct TccStatus: Codable, Sendable {
    public var ax: Bool, screen: Bool
    public init(ax: Bool, screen: Bool) { self.ax = ax; self.screen = screen }
}

public struct Stats: Codable, Sendable {
    public var agentVersion = "0.1.0"
    public var lastCaptureTs = 0
    public var captures = 0
    public var skips: [String: Int] = [:]
    public var method = MethodCounts()
    public var tcc: TccStatus? = nil
}

public struct PipelineState: Sendable {
    public var lastHashByWindow: [String: String] = [:]
    public var stats = Stats()
    public init() {}
}

/// One diarized speaker as sent to the daemon. Other people's embeddings exist
/// only for the length of this request: the daemon labels with them and drops them.
public struct SpeakerPayload: Sendable, Equatable {
    public let label: String       // "S1", matches "Speaker 1:" in text
    public let channel: String     // "system" | "mic"
    public let embedding: String   // base64 float32 LE
    public let speechSec: Double
    public init(label: String, channel: String, embedding: String, speechSec: Double) {
        self.label = label; self.channel = channel; self.embedding = embedding; self.speechSec = speechSec
    }
}

/// A sample of the user's own voice (calls only, ≥ 30 s of mic speech).
public struct VoiceSamplePayload: Sendable, Equatable {
    public let embedding: String
    public let speechSec: Double
    public init(embedding: String, speechSec: Double) { self.embedding = embedding; self.speechSec = speechSec }
}

public struct IngestPayload: Sendable {
    public let source: String
    public let uri: String, title: String, ts: Int, text: String
    public let meta: [String: String]
    /// Only for source "meeting" with diarization on; nil keeps the wire as before.
    public let speakers: [SpeakerPayload]?
    public let selfSample: VoiceSamplePayload?
    public init(source: String = "screen", uri: String, title: String,
                ts: Int, text: String, meta: [String: String],
                speakers: [SpeakerPayload]? = nil, selfSample: VoiceSamplePayload? = nil) {
        self.source = source; self.uri = uri; self.title = title
        self.ts = ts; self.text = text; self.meta = meta
        self.speakers = speakers; self.selfSample = selfSample
    }
}

/// The `ingest` params. Keys for speakers/selfSample appear only when set, so
/// with diarization off the wire is byte-identical to 0.5.19.
public func ingestParams(_ p: IngestPayload) -> [String: Any] {
    var d: [String: Any] = ["source": p.source, "uri": p.uri, "title": p.title,
                            "ts": p.ts, "text": p.text, "meta": p.meta]
    if let s = p.speakers {
        d["speakers"] = s.map { ["label": $0.label, "channel": $0.channel,
                                 "embedding": $0.embedding, "speechSec": $0.speechSec] as [String: Any] }
    }
    if let v = p.selfSample { d["selfSample"] = ["embedding": v.embedding, "speechSec": v.speechSec] }
    return d
}

public func decide(event: CaptureEvent, config: CaptureConfig,
                   state: inout PipelineState, secureInput: Bool) -> IngestPayload? {
    // Nested func (not a closure) so it can mutate the inout `state` without
    // Swift 6's escaping-closure-captures-inout error.
    func skip(_ r: String) -> IngestPayload? {
        state.stats.skips[r, default: 0] += 1; return nil
    }
    if let reason = gate(bundleId: event.bundleId, title: event.windowTitle,
                         config: config, now: Double(event.ts), secureInput: secureInput) {
        return skip(reason.rawValue)
    }
    let text = normalize(event.text)
    if text.count < 80 { return skip("empty") }
    // Fail closed on on-screen secrets: never let a rendered token/key into
    // the register, whatever the page title was.
    if containsSecret(text) { return skip("secret") }
    let key = windowKey(bundleId: event.bundleId, windowTitle: event.windowTitle)
    let hash = sha256Hex(text)
    if state.lastHashByWindow[key] == hash { return skip("unchanged") }
    // Bound the change-dedup map for a long-lived agent (one entry per distinct
    // window title, never otherwise evicted). At the cap, drop all state: the
    // only cost is that each still-open window re-captures once more before its
    // hash is re-learned. Cap is generous vs. realistic distinct-window counts.
    if state.lastHashByWindow.count >= 8192 { state.lastHashByWindow.removeAll(keepingCapacity: true) }
    state.lastHashByWindow[key] = hash
    state.stats.captures += 1
    state.stats.lastCaptureTs = event.ts
    if event.method == "ocr" { state.stats.method.ocr += 1 } else { state.stats.method.ax += 1 }
    return IngestPayload(
        uri: bucketUri(bundleId: event.bundleId, windowTitle: event.windowTitle,
                       epochSeconds: event.ts),
        title: "\(event.appName) — \(event.windowTitle)",
        ts: event.ts, text: text,
        meta: ["app": event.appName, "bundleId": event.bundleId,
               "windowTitle": event.windowTitle, "method": event.method])
}

// Normalized frontmost-window signature for the title-watch capture trigger.
// Collapses volatile badges — unread counts like "(11)" and leading "•"
// markers — so a busy inbox ticking (11)->(12) doesn't fire a capture on
// every mail, while a genuine navigation (Inbox -> a specific thread) does.
public func titleSignature(bundleId: String, title: String) -> String {
    var t = title.replacingOccurrences(of: #"\(\d+\)"#, with: "",
                                       options: .regularExpression)
    t = t.replacingOccurrences(of: #"^[•\s]+"#, with: "", options: .regularExpression)
    t = t.trimmingCharacters(in: .whitespacesAndNewlines)
    return bundleId + "\u{1}" + t
}
