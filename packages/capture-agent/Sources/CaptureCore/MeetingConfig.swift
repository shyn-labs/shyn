import Foundation

public struct MeetingConfig: Codable, Sendable {
    public var enabled = true
    public var graceSeconds = 10
    public var endSilenceSeconds = 60
    public var candidateSeconds = 10
    public var maxDurationMinutes = 180
    public var whisperModel = "small"
    public var excludeApps: [String] = []
    // Mic echo cancellation (AVAudioEngine voice processing). On by default:
    // without it the mic records the far end off the speakers, which both
    // corrupts speaker labels and can voice both channels into a phantom
    // pre-roll. Escape hatch in capture.json if it ever degrades mic capture.
    public var echoCancellation = true
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
        echoCancellation = try c.decodeIfPresent(Bool.self, forKey: .echoCancellation) ?? true
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
