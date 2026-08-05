import Foundation

public struct MeetingConfig: Codable, Sendable {
    public var enabled = true
    public var graceSeconds = 10
    public var endSilenceSeconds = 60
    public var candidateSeconds = 10
    public var maxDurationMinutes = 180
    public var whisperModel = "small"
    public var excludeApps: [String] = []
    // NOTE: `echoCancellation` existed in 0.4.18 and was REMOVED in 0.4.19 along
    // with the voice-processing code it gated. A live-degrading feature behind a
    // default-on flag is worse than no feature; a dead flag that silently does
    // nothing is worse still. An existing "echoCancellation" key in capture.json
    // is simply ignored. See AudioRecorder.swift and docs/known-issues.md.
    public init() {}
    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        graceSeconds = try c.decodeIfPresent(Int.self, forKey: .graceSeconds) ?? 10
        endSilenceSeconds = try c.decodeIfPresent(Int.self, forKey: .endSilenceSeconds) ?? 60
        candidateSeconds = try c.decodeIfPresent(Int.self, forKey: .candidateSeconds) ?? 10
        maxDurationMinutes = try c.decodeIfPresent(Int.self, forKey: .maxDurationMinutes) ?? 180
        whisperModel = try c.decodeIfPresent(String.self, forKey: .whisperModel) ?? "small"
        excludeApps = try c.decodeIfPresent([String].self, forKey: .excludeApps) ?? []
    }
    public static let defaults = MeetingConfig()

    // capture.json has a top-level "meeting" object; load it, tolerant of a
    // missing file / missing keys (falls back to defaults).
    public static func load(from path: String) -> MeetingConfig {
        guard let data = FileManager.default.contents(atPath: path),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let meeting = root["meeting"],
              let sub = try? JSONSerialization.data(withJSONObject: meeting),
              let cfg = try? JSONDecoder().decode(MeetingConfig.self, from: sub)
        else { return .defaults }
        return cfg
    }
}
